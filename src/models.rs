use serde::{Deserialize, Serialize};
use tauri::path::BaseDirectory;

use crate::error::{Error, Result};

pub const DEFAULT_SQLITE_DB_NAME: &str = "configurate.db";
pub const DEFAULT_SQLITE_TABLE_NAME: &str = "configurate_configs";

/// Supported storage file formats (legacy input compatibility).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StorageFormat {
    Json,
    #[serde(alias = "yml")]
    Yaml,
    Binary,
}

/// Supported provider kinds for the normalized runtime model.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Json,
    Yml,
    Binary,
    Sqlite,
}

/// Provider payload sent from the guest side.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPayload {
    pub kind: ProviderKind,
    pub encryption_key: Option<String>,
    pub db_name: Option<String>,
    pub table_name: Option<String>,
}

/// Optional path options sent from the guest side.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathOptions {
    pub dir_name: Option<String>,
    pub current_path: Option<String>,
}

/// A single keyring entry containing the keyring id and its plaintext value.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct KeyringEntry {
    /// Unique keyring id as declared in the TS schema via `keyring(T, { id })`.
    pub id: String,
    /// Dot-separated path to this field inside the config object (e.g. `"database.password"`).
    pub dotpath: String,
    /// Plaintext value to store in the OS keyring.
    pub value: String,
}

/// Options required to access the OS keyring.
/// The final key stored in the OS keyring uses:
/// - service = `{service}`
/// - user    = `{account}/{id}`
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct KeyringOptions {
    /// The keyring service name (e.g. your app name).
    pub service: String,
    /// The keyring account name (e.g. "default").
    pub account: String,
}

/// Value type inferred from `defineConfig` for SQLite column materialization.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SqliteValueType {
    String,
    Number,
    Boolean,
}

/// Flattened column definition for SQLite persistence.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteColumn {
    pub column_name: String,
    pub dotpath: String,
    pub value_type: SqliteValueType,
    #[serde(default)]
    pub is_keyring: bool,
}

/// Unified payload sent from TypeScript side for create/load/save/delete.
///
/// This struct intentionally keeps both new and legacy fields so one minor
/// version can accept old callers while normalizing into one internal model.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguratePayload {
    // New API
    pub file_name: Option<String>,
    pub base_dir: Option<BaseDirectory>,
    pub options: Option<PathOptions>,
    pub provider: Option<ProviderPayload>,
    #[serde(default)]
    pub schema_columns: Vec<SqliteColumn>,

    // Legacy API
    pub name: Option<String>,
    pub dir: Option<BaseDirectory>,
    pub dir_name: Option<String>,
    pub path: Option<String>,
    pub format: Option<StorageFormat>,
    pub encryption_key: Option<String>,

    // Common fields
    pub data: Option<serde_json::Value>,
    pub keyring_entries: Option<Vec<KeyringEntry>>,
    pub keyring_options: Option<KeyringOptions>,
    #[serde(default)]
    pub with_unlock: bool,
}

/// Normalized provider used internally after payload normalization.
///
/// Each variant carries only the fields that are meaningful for that provider,
/// eliminating the spurious `db_name`/`table_name` on non-SQLite providers and
/// the spurious `encryption_key` on non-Binary providers.
#[derive(Debug, Clone)]
pub enum NormalizedProvider {
    Json,
    Yml,
    Binary { encryption_key: Option<String> },
    Sqlite { db_name: String, table_name: String },
}

/// Normalized payload used internally across all commands.
#[derive(Debug, Clone)]
pub struct NormalizedConfiguratePayload {
    pub file_name: String,
    pub base_dir: BaseDirectory,
    pub dir_name: Option<String>,
    pub current_path: Option<String>,
    pub provider: NormalizedProvider,
    pub schema_columns: Vec<SqliteColumn>,
    pub data: Option<serde_json::Value>,
    pub keyring_entries: Option<Vec<KeyringEntry>>,
    pub keyring_options: Option<KeyringOptions>,
    pub with_unlock: bool,
}

impl ConfiguratePayload {
    pub fn normalize(self) -> Result<NormalizedConfiguratePayload> {
        let file_name = self
            .file_name
            .or(self.name)
            .ok_or_else(|| Error::InvalidPayload("missing fileName/name".to_string()))?;

        let base_dir = self
            .base_dir
            .or(self.dir)
            .ok_or_else(|| Error::InvalidPayload("missing baseDir/dir".to_string()))?;

        let (dir_name, current_path) = match self.options {
            Some(opts) => (opts.dir_name, opts.current_path),
            None => (self.dir_name, self.path),
        };

        let provider = match self.provider {
            Some(provider) => {
                // Validate early: encryptionKey is only meaningful for Binary.
                // Previously this check was at the bottom as dead code for this branch
                // because encryption_key was already set to None before the check.
                let is_binary_provider = matches!(&provider.kind, ProviderKind::Binary);
                if !is_binary_provider
                    && (provider.encryption_key.is_some() || self.encryption_key.is_some())
                {
                    return Err(Error::InvalidPayload(
                        "encryptionKey is only supported with provider.kind='binary'".to_string(),
                    ));
                }

                match provider.kind {
                    ProviderKind::Json => NormalizedProvider::Json,
                    ProviderKind::Yml => NormalizedProvider::Yml,
                    ProviderKind::Binary => NormalizedProvider::Binary {
                        encryption_key: provider.encryption_key.or(self.encryption_key),
                    },
                    ProviderKind::Sqlite => NormalizedProvider::Sqlite {
                        db_name: provider
                            .db_name
                            .unwrap_or_else(|| DEFAULT_SQLITE_DB_NAME.to_string()),
                        table_name: provider
                            .table_name
                            .unwrap_or_else(|| DEFAULT_SQLITE_TABLE_NAME.to_string()),
                    },
                }
            }
            None => {
                // Legacy API path: `format` + optional `encryptionKey`.
                let format = self
                    .format
                    .ok_or_else(|| Error::InvalidPayload("missing provider/format".to_string()))?;

                // Validate encryptionKey for the legacy path.
                if !matches!(format, StorageFormat::Binary) && self.encryption_key.is_some() {
                    return Err(Error::InvalidPayload(
                        "encryptionKey is only supported with provider.kind='binary'".to_string(),
                    ));
                }

                match format {
                    StorageFormat::Json => NormalizedProvider::Json,
                    StorageFormat::Yaml => NormalizedProvider::Yml,
                    StorageFormat::Binary => NormalizedProvider::Binary {
                        encryption_key: self.encryption_key,
                    },
                }
            }
        };

        Ok(NormalizedConfiguratePayload {
            file_name,
            base_dir,
            dir_name,
            current_path,
            provider,
            schema_columns: self.schema_columns,
            data: self.data,
            keyring_entries: self.keyring_entries,
            keyring_options: self.keyring_options,
            with_unlock: self.with_unlock,
        })
    }
}

/// Payload for the `unlock` command.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockPayload {
    pub data: serde_json::Value,
    pub keyring_entries: Option<Vec<KeyringEntry>>,
    pub keyring_options: Option<KeyringOptions>,
}

/// Single entry used by `load_all` and `save_all`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchEntryPayload {
    pub id: String,
    pub payload: ConfiguratePayload,
}

/// Batch payload used by `load_all` and `save_all`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchPayload {
    pub entries: Vec<BatchEntryPayload>,
}

/// Per-entry successful result.
#[derive(Debug, Serialize)]
pub struct BatchEntrySuccess {
    pub ok: bool,
    pub data: serde_json::Value,
}

/// Per-entry failed result.
#[derive(Debug, Serialize)]
pub struct BatchEntryFailure {
    pub ok: bool,
    pub error: serde_json::Value,
}

/// Per-entry result envelope.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum BatchEntryResult {
    Success(BatchEntrySuccess),
    Failure(BatchEntryFailure),
}

/// Top-level batch response.
#[derive(Debug, Serialize)]
pub struct BatchRunResult {
    pub results: std::collections::BTreeMap<String, BatchEntryResult>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_payload() -> ConfiguratePayload {
        ConfiguratePayload {
            file_name: Some("app.json".to_string()),
            base_dir: Some(BaseDirectory::AppConfig),
            options: None,
            provider: None,
            schema_columns: Vec::new(),
            name: None,
            dir: None,
            dir_name: None,
            path: None,
            format: None,
            encryption_key: None,
            data: None,
            keyring_entries: None,
            keyring_options: None,
            with_unlock: false,
        }
    }

    #[test]
    fn normalize_rejects_legacy_encryption_key_with_non_binary_provider() {
        let mut payload = base_payload();
        payload.provider = Some(ProviderPayload {
            kind: ProviderKind::Json,
            encryption_key: None,
            db_name: None,
            table_name: None,
        });
        payload.encryption_key = Some("legacy-key".to_string());

        let err = payload.normalize().expect_err("expected invalid payload");
        match err {
            Error::InvalidPayload(msg) => {
                assert_eq!(
                    msg,
                    "encryptionKey is only supported with provider.kind='binary'"
                );
            }
            _ => panic!("unexpected error variant"),
        }
    }

    #[test]
    fn normalize_allows_legacy_encryption_key_with_binary_provider() {
        let mut payload = base_payload();
        payload.provider = Some(ProviderPayload {
            kind: ProviderKind::Binary,
            encryption_key: None,
            db_name: None,
            table_name: None,
        });
        payload.encryption_key = Some("legacy-key".to_string());

        let normalized = payload.normalize().expect("expected valid payload");
        match normalized.provider {
            NormalizedProvider::Binary { encryption_key } => {
                assert_eq!(encryption_key.as_deref(), Some("legacy-key"));
            }
            _ => panic!("unexpected provider variant"),
        }
    }
}
