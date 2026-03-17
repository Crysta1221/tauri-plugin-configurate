use serde::{Deserialize, Serialize};
use tauri::path::BaseDirectory;

use crate::dotpath;
use crate::error::{Error, Result};

pub const DEFAULT_SQLITE_DB_NAME: &str = "configurate.db";
pub const DEFAULT_SQLITE_TABLE_NAME: &str = "configurate_configs";

/// Supported provider kinds for the normalized runtime model.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Json,
    Yml,
    Binary,
    Sqlite,
    Toml,
}

/// Provider payload sent from the guest side.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPayload {
    pub kind: ProviderKind,
    pub encryption_key: Option<String>,
    pub kdf: Option<KeyDerivation>,
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
#[serde(rename_all = "camelCase")]
pub struct KeyringEntry {
    /// Unique keyring id as declared in the TS schema via `keyring(T, { id })`.
    pub id: String,
    /// Dot-separated path to this field inside the config object (e.g. `"database.password"`).
    pub dotpath: String,
    /// Plaintext value to store in the OS keyring.
    pub value: String,
    /// When true, a "not found" keyring error on read is treated as absent (null) rather than an error.
    #[serde(default)]
    pub is_optional: bool,
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
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguratePayload {
    pub file_name: Option<String>,
    pub base_dir: Option<BaseDirectory>,
    pub options: Option<PathOptions>,
    pub provider: Option<ProviderPayload>,
    #[serde(default)]
    pub schema_columns: Vec<SqliteColumn>,

    // Common fields
    pub data: Option<serde_json::Value>,
    pub keyring_entries: Option<Vec<KeyringEntry>>,
    pub keyring_options: Option<KeyringOptions>,
    #[serde(default)]
    pub keyring_delete_ids: Vec<String>,
    #[serde(default)]
    pub with_unlock: bool,
    /// Whether create/save should return the resulting config data.
    /// Defaults to true for backward compatibility.
    pub return_data: Option<bool>,
    /// When true, `patch` creates the config with the patch data if it does
    /// not yet exist instead of returning an error.
    #[serde(default)]
    pub create_if_missing: bool,
    /// When true, rolling backup files are created before each write.
    /// Defaults to false (opt-in).
    #[serde(default)]
    pub backup: bool,
}

/// Key derivation function used by the Binary provider.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyDerivation {
    Sha256,
    Argon2,
}

/// Normalized provider used internally after payload normalization.
///
/// Each variant carries only the fields that are meaningful for that provider,
/// eliminating the spurious `db_name`/`table_name` on non-SQLite providers and
/// the spurious `encryption_key` on non-Binary providers.
#[derive(Clone)]
pub enum NormalizedProvider {
    Json,
    Yml,
    Toml,
    Binary {
        encryption_key: Option<String>,
        kdf: KeyDerivation,
    },
    Sqlite { db_name: String, table_name: String },
}

/// Custom Debug impl that redacts the `encryption_key` so it is never
/// accidentally printed in log output, panic messages, or test failures.
impl std::fmt::Debug for NormalizedProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Json => write!(f, "Json"),
            Self::Yml => write!(f, "Yml"),
            Self::Toml => write!(f, "Toml"),
            Self::Binary { encryption_key, kdf } => f
                .debug_struct("Binary")
                .field(
                    "encryption_key",
                    &encryption_key.as_ref().map(|_| "[REDACTED]"),
                )
                .field("kdf", kdf)
                .finish(),
            Self::Sqlite { db_name, table_name } => f
                .debug_struct("Sqlite")
                .field("db_name", db_name)
                .field("table_name", table_name)
                .finish(),
        }
    }
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
    pub keyring_delete_ids: Vec<String>,
    pub with_unlock: bool,
    pub return_data: bool,
    /// When true, `patch` creates the config if it does not exist.
    pub create_if_missing: bool,
    /// When true, rolling backup files are created before each write.
    pub backup: bool,
}

impl ConfiguratePayload {
    pub fn normalize(self) -> Result<NormalizedConfiguratePayload> {
        let file_name = self
            .file_name
            .ok_or_else(|| Error::InvalidPayload("missing fileName".to_string()))?;

        let base_dir = self
            .base_dir
            .ok_or_else(|| Error::InvalidPayload("missing baseDir".to_string()))?;

        let (dir_name, current_path) = match self.options {
            Some(opts) => (opts.dir_name, opts.current_path),
            None => (None, None),
        };

        let provider_payload = self
            .provider
            .ok_or_else(|| Error::InvalidPayload("missing provider".to_string()))?;

        if !self.keyring_delete_ids.is_empty() && self.keyring_options.is_none() {
            return Err(Error::InvalidPayload(
                "keyringDeleteIds provided without keyringOptions".to_string(),
            ));
        }

        if !matches!(&provider_payload.kind, ProviderKind::Binary)
            && provider_payload.encryption_key.is_some()
        {
            return Err(Error::InvalidPayload(
                "encryptionKey is only supported with provider.kind='binary'".to_string(),
            ));
        }

        if !matches!(&provider_payload.kind, ProviderKind::Binary)
            && provider_payload.kdf.is_some()
        {
            return Err(Error::InvalidPayload(
                "kdf is only supported with provider.kind='binary'".to_string(),
            ));
        }

        let provider = match provider_payload.kind {
            ProviderKind::Json => NormalizedProvider::Json,
            ProviderKind::Yml => NormalizedProvider::Yml,
            ProviderKind::Toml => NormalizedProvider::Toml,
            ProviderKind::Binary => NormalizedProvider::Binary {
                encryption_key: provider_payload.encryption_key,
                kdf: provider_payload.kdf.unwrap_or(KeyDerivation::Sha256),
            },
            ProviderKind::Sqlite => NormalizedProvider::Sqlite {
                db_name: provider_payload
                    .db_name
                    .unwrap_or_else(|| DEFAULT_SQLITE_DB_NAME.to_string()),
                table_name: provider_payload
                    .table_name
                    .unwrap_or_else(|| DEFAULT_SQLITE_TABLE_NAME.to_string()),
            },
        };

        let schema_columns = self.schema_columns;

        // Validate dotpaths early so callers get a clear error referencing the
        // offending column rather than a cryptic dotpath error at write time.
        for column in &schema_columns {
            dotpath::validate_path(&column.dotpath).map_err(|e| {
                Error::InvalidPayload(format!(
                    "invalid dotpath in column '{}': {}",
                    column.column_name, e
                ))
            })?;
        }

        Ok(NormalizedConfiguratePayload {
            file_name,
            base_dir,
            dir_name,
            current_path,
            provider,
            schema_columns,
            data: self.data,
            keyring_entries: self.keyring_entries,
            keyring_options: self.keyring_options,
            keyring_delete_ids: self.keyring_delete_ids,
            with_unlock: self.with_unlock,
            return_data: self.return_data.unwrap_or(true),
            create_if_missing: self.create_if_missing,
            backup: self.backup,
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

/// Payload for the `patch` command (reuses `ConfiguratePayload`).
pub type PatchPayload = ConfiguratePayload;

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
            data: None,
            keyring_entries: None,
            keyring_options: None,
            keyring_delete_ids: Vec::new(),
            with_unlock: false,
            return_data: None,
            create_if_missing: false,
            backup: false,
        }
    }

    #[test]
    fn normalize_rejects_encryption_key_with_non_binary_provider() {
        let mut payload = base_payload();
        payload.provider = Some(ProviderPayload {
            kind: ProviderKind::Json,
            encryption_key: Some("key".to_string()),
            kdf: None,
            db_name: None,
            table_name: None,
        });

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
    fn normalize_allows_encryption_key_with_binary_provider() {
        let mut payload = base_payload();
        payload.provider = Some(ProviderPayload {
            kind: ProviderKind::Binary,
            encryption_key: Some("my-key".to_string()),
            kdf: None,
            db_name: None,
            table_name: None,
        });

        let normalized = payload.normalize().expect("expected valid payload");
        match normalized.provider {
            NormalizedProvider::Binary { encryption_key, kdf } => {
                assert_eq!(encryption_key.as_deref(), Some("my-key"));
                assert!(matches!(kdf, KeyDerivation::Sha256), "expected default kdf to be Sha256");
            }
            _ => panic!("unexpected provider variant"),
        }
    }

    #[test]
    fn normalize_rejects_keyring_delete_ids_without_keyring_options() {
        let mut payload = base_payload();
        payload.provider = Some(ProviderPayload {
            kind: ProviderKind::Json,
            encryption_key: None,
            kdf: None,
            db_name: None,
            table_name: None,
        });
        payload.keyring_delete_ids = vec!["tok".to_string()];

        let err = payload.normalize().expect_err("expected invalid payload");
        match err {
            Error::InvalidPayload(msg) => {
                assert_eq!(msg, "keyringDeleteIds provided without keyringOptions");
            }
            _ => panic!("unexpected error variant"),
        }
    }
}
