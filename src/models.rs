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

/// Normalized provider used internally.
#[derive(Debug, Clone)]
pub struct NormalizedProvider {
    pub kind: ProviderKind,
    pub encryption_key: Option<String>,
    pub db_name: String,
    pub table_name: String,
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
                let encryption_key = match provider.kind {
                    ProviderKind::Binary => provider.encryption_key.or(self.encryption_key),
                    _ => None,
                };

                NormalizedProvider {
                    kind: provider.kind,
                    encryption_key,
                    db_name: provider
                        .db_name
                        .unwrap_or_else(|| DEFAULT_SQLITE_DB_NAME.to_string()),
                    table_name: provider
                        .table_name
                        .unwrap_or_else(|| DEFAULT_SQLITE_TABLE_NAME.to_string()),
                }
            }
            None => {
                let format = self
                    .format
                    .ok_or_else(|| Error::InvalidPayload("missing provider/format".to_string()))?;

                let kind = match format {
                    StorageFormat::Json => ProviderKind::Json,
                    StorageFormat::Yaml => ProviderKind::Yml,
                    StorageFormat::Binary => ProviderKind::Binary,
                };

                NormalizedProvider {
                    kind,
                    encryption_key: self.encryption_key,
                    db_name: DEFAULT_SQLITE_DB_NAME.to_string(),
                    table_name: DEFAULT_SQLITE_TABLE_NAME.to_string(),
                }
            }
        };

        if !matches!(provider.kind, ProviderKind::Binary) && provider.encryption_key.is_some() {
            return Err(Error::InvalidPayload(
                "encryptionKey is only supported with provider.kind='binary'".to_string(),
            ));
        }

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
