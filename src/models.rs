use serde::{Deserialize, Serialize};
use tauri::path::BaseDirectory;

/// Supported storage file formats.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StorageFormat {
    Json,
    Yaml,
    Binary,
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

/// The unified payload sent from the TypeScript side for create / load / save.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguratePayload {
    /// Full filename for this configuration file (including extension, no path separators).
    /// For example: `"app.json"`, `"data.yaml"`, `".env"`.
    /// Path separators (`/`, `\`) are rejected; use `path` for subdirectories.
    pub name: String,
    /// Base directory (deserialized directly from Tauri's `BaseDirectory` integer enum).
    pub dir: BaseDirectory,
    /// Optional replacement for the app identifier directory.
    ///
    /// When provided, **replaces** the identifier component of the resolved base path.
    /// For example, with `BaseDirectory::AppConfig` on Windows:
    /// - absent     → `%APPDATA%\<identifier>\`
    /// - `"my-app"` → `%APPDATA%\my-app\`
    ///
    /// Each path component is validated; `..` and Windows-forbidden characters are rejected.
    pub dir_name: Option<String>,
    /// Optional sub-directory within the root (after `dir_name` / identifier is applied).
    ///
    /// Use forward slashes for nested paths (e.g. `"config/v2"`).
    /// Each component is validated; `..` and Windows-forbidden characters are rejected.
    /// The resolved path stays within the root directory.
    pub path: Option<String>,
    /// Storage format to use.
    pub format: StorageFormat,
    /// Plain (non-secret) configuration data as a JSON value.
    pub data: Option<serde_json::Value>,
    /// Keyring entries to write (create / save) or expected ids to read (unlock).
    pub keyring_entries: Option<Vec<KeyringEntry>>,
    /// Keyring options required when reading from or writing to the OS keyring.
    pub keyring_options: Option<KeyringOptions>,
    /// When true the command also reads secrets from the keyring and inlines them.
    pub with_unlock: bool,
    /// Optional encryption key for the binary format (XChaCha20-Poly1305).
    /// The 32-byte cipher key is derived via SHA-256 of this string.
    /// Omit for unencrypted binary (or non-binary formats).
    pub encryption_key: Option<String>,
}

/// Payload for the `unlock` command, which reads keyring secrets and inlines
/// them into already-loaded plain data without re-reading the file from disk.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockPayload {
    /// Plain config data (keyring fields are `null`) previously returned by load/create/save.
    pub data: serde_json::Value,
    /// Keyring entries whose values should be fetched and inlined.
    pub keyring_entries: Option<Vec<KeyringEntry>>,
    /// Keyring options for the OS keyring lookup.
    pub keyring_options: Option<KeyringOptions>,
}
