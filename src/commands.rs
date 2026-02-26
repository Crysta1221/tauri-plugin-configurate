use std::path::PathBuf;

use serde_json::Value;
use tauri::{command, path::BaseDirectory, AppHandle, Manager, Runtime};

use crate::dotpath;
use crate::error::{Error, Result};
use crate::keyring_store;
use crate::models::{ConfiguratePayload, KeyringEntry, KeyringOptions, UnlockPayload};
use crate::storage;

/// Validates a single path component (file or folder name segment).
///
/// Leading dots are allowed so that names like `.env` or `.example` are accepted.
/// Blocked in a single pass:
/// - empty string
/// - all-dots strings (`.`, `..`, `...`, etc.)
/// - any Windows-forbidden character: `/ \ \0 : * ? " < > |`
fn validate_path_component(component: &str) -> Result<()> {
    if component.is_empty() {
        return Err(Error::InvalidPayload(
            "invalid path component: must not be empty".to_string(),
        ));
    }
    let mut all_dots = true;
    for c in component.chars() {
        if matches!(c, '/' | '\\' | '\0' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            return Err(Error::InvalidPayload(format!(
                "invalid path component '{}': must not contain path separators \
or Windows-forbidden characters (: * ? \" < > | and null bytes)",
                component
            )));
        }
        if c != '.' {
            all_dots = false;
        }
    }
    if all_dots {
        return Err(Error::InvalidPayload(format!(
            "invalid path component '{}': dot-only names (., .., ...) are not allowed",
            component
        )));
    }
    if component.ends_with(' ') || component.ends_with('.') {
        return Err(Error::InvalidPayload(format!(
            "invalid path component '{}': must not end with a space or dot",
            component
        )));
    }
    Ok(())
}

/// Validates that a config `name` is a safe single filename component.
///
/// `name` must be a single path component — path separators (`/`, `\`) are rejected.
/// Include the extension in the name (e.g. `"app.json"`, `".env"`, `"data.yaml"`).
fn validate_config_name(name: &str) -> Result<()> {
    validate_path_component(name)
}

/// Validates a `dir_name` value (forward-slash-separated relative path).
///
/// `dir_name` replaces the app identifier component of the base path.
/// Each slash-separated segment is validated with `validate_path_component`.
fn validate_dir_name(dir_name: &str) -> Result<()> {
    if dir_name.is_empty() {
        return Err(Error::InvalidPayload("dirName must not be empty".to_string()));
    }
    for component in dir_name.split('/') {
        validate_path_component(component)?;
    }
    Ok(())
}

/// Validates a `path` value (forward-slash-separated relative sub-path within root).
///
/// Each slash-separated segment is validated with `validate_path_component`.
fn validate_path_field(path: &str) -> Result<()> {
    if path.is_empty() {
        return Err(Error::InvalidPayload("path must not be empty".to_string()));
    }
    for component in path.split('/') {
        validate_path_component(component)?;
    }
    Ok(())
}

/// Resolves the absolute path for a config file using Tauri's path resolver.
///
/// `dir` is Tauri's `BaseDirectory` (deserialized from the TypeScript integer value).
///
/// When `dir_name` is provided and the resolved base path ends with the app
/// identifier (e.g. `AppConfig` → `%APPDATA%/<identifier>`), the identifier
/// segment is **replaced** by `dir_name`.  For base directories that do not
/// include the identifier (e.g. `Desktop`, `Home`), `dir_name` is appended as
/// a sub-directory instead.
///
/// # Path layout (AppConfig, identifier `com.example.app`)
///
/// | `dir_name`  | `path`      | Resolved path                                              |
/// | ----------- | ----------- | ---------------------------------------------------------- |
/// | _(absent)_  | _(absent)_  | `%APPDATA%/com.example.app/<name>`                         |
/// | `"my-app"`  | _(absent)_  | `%APPDATA%/my-app/<name>`                                  |
/// | _(absent)_  | `"cfg/v2"`  | `%APPDATA%/com.example.app/cfg/v2/<name>`                  |
/// | `"my-app"`  | `"cfg/v2"`  | `%APPDATA%/my-app/cfg/v2/<name>`                           |
///
/// # Path layout (Desktop — no identifier)
///
/// | `dir_name`  | `path`      | Resolved path                                              |
/// | ----------- | ----------- | ---------------------------------------------------------- |
/// | _(absent)_  | _(absent)_  | `~/Desktop/<name>`                                         |
/// | `"my-app"`  | _(absent)_  | `~/Desktop/my-app/<name>`                                  |
///
/// `name` is used as-is (caller includes the extension, e.g. `"app.json"` or `".env"`).
/// No extension is appended automatically.
fn resolve_path<R: Runtime>(
    app: &AppHandle<R>,
    dir: BaseDirectory,
    name: &str,
    dir_name: Option<&str>,
    path: Option<&str>,
) -> Result<PathBuf> {
    validate_config_name(name)?;
    if let Some(d) = dir_name {
        validate_dir_name(d)?;
    }
    if let Some(p) = path {
        validate_path_field(p)?;
    }

    let base = app
        .path()
        .resolve("", dir)
        .map_err(|e| Error::Storage(e.to_string()))?;

    // When `dir_name` is provided and the resolved base path ends with the app
    // identifier (e.g. `%APPDATA%/com.example.app`), replace that last segment.
    // For directories without an identifier (e.g. Desktop, Home) `dir_name` is
    // simply appended as a sub-directory.
    let root = match dir_name {
        Some(d) => {
            let identifier = &app.config().identifier;
            if base.file_name().map_or(false, |n| n == identifier.as_str()) {
                base.parent().unwrap_or(&base).join(d)
            } else {
                base.join(d)
            }
        }
        None => base,
    };

    // path adds a sub-directory within the root.
    let parent = match path {
        Some(p) => root.join(p),
        None => root,
    };

    // name is used as-is — no extension is appended.
    Ok(parent.join(name))
}

/// Writes keyring entries to the OS keyring and nullifies the corresponding
/// dotpaths in `data` so that secrets are never persisted to disk.
fn apply_keyring_writes(
    data: &mut Value,
    entries: &[KeyringEntry],
    opts: &crate::models::KeyringOptions,
) -> Result<()> {
    for entry in entries {
        keyring_store::set(opts, &entry.id, &entry.value)?;
        // Replace the secret value with null in the on-disk representation.
        dotpath::nullify(data, &entry.dotpath)?;
    }
    Ok(())
}

/// Reads keyring entries and inlines the plaintext values back into `data`
/// at the correct dotpath location.
fn apply_keyring_reads(
    data: &mut Value,
    entries: &[KeyringEntry],
    opts: &crate::models::KeyringOptions,
) -> Result<()> {
    for entry in entries {
        let secret = keyring_store::get(opts, &entry.id)?;
        // The stored value might itself be a JSON object (for nested keyring fields).
        let val: Value = serde_json::from_str(&secret).unwrap_or(Value::String(secret));
        dotpath::set(data, &entry.dotpath, val)?;
    }
    Ok(())
}

/// Validates keyring payload pair semantics.
///
/// `keyring_entries` and `keyring_options` must either both be provided or
/// both be omitted. This prevents accidental plaintext persistence when callers
/// pass only one side.
fn keyring_pair<'a>(
    op: &str,
    keyring_entries: &'a Option<Vec<KeyringEntry>>,
    keyring_options: &'a Option<KeyringOptions>,
) -> Result<Option<(&'a [KeyringEntry], &'a KeyringOptions)>> {
    match (keyring_entries.as_deref(), keyring_options.as_ref()) {
        (Some(entries), Some(opts)) => Ok(Some((entries, opts))),
        (None, None) => Ok(None),
        (Some(_), None) => Err(Error::InvalidPayload(format!(
            "invalid '{}' payload: keyringEntries provided without keyringOptions",
            op
        ))),
        (None, Some(_)) => Err(Error::InvalidPayload(format!(
            "invalid '{}' payload: keyringOptions provided without keyringEntries",
            op
        ))),
    }
}

/// Creates a new configuration file. If keyring entries are provided they are
/// written to the OS keyring and nullified in the on-disk data. When
/// `with_unlock` is true the response includes the fully unlocked data.
#[command]
pub(crate) async fn create<R: Runtime>(
    app: AppHandle<R>,
    payload: ConfiguratePayload,
) -> Result<Value> {
    let backend = storage::backend_for(&payload.format, payload.encryption_key.as_deref());
    let path = resolve_path(&app, payload.dir, &payload.name, payload.dir_name.as_deref(), payload.path.as_deref())?;

    let mut data = payload.data.unwrap_or(Value::Object(serde_json::Map::new()));

    // Keep a copy for the unlocked response before nullifying secrets.
    let unlocked_data = if payload.with_unlock {
        Some(data.clone())
    } else {
        None
    };

    if let Some((entries, opts)) = keyring_pair("create", &payload.keyring_entries, &payload.keyring_options)? {
        apply_keyring_writes(&mut data, entries, opts)?;
    }

    backend.write(&path, &data)?;

    Ok(unlocked_data.unwrap_or(data))
}

/// Loads a configuration file from disk. When `with_unlock` is true the keyring
/// secrets are fetched and inlined into the returned value. Otherwise keyring
/// dotpaths remain `null` as stored on disk.
#[command]
pub(crate) async fn load<R: Runtime>(
    app: AppHandle<R>,
    payload: ConfiguratePayload,
) -> Result<Value> {
    let backend = storage::backend_for(&payload.format, payload.encryption_key.as_deref());
    let path = resolve_path(&app, payload.dir, &payload.name, payload.dir_name.as_deref(), payload.path.as_deref())?;

    let mut data = backend.read(&path)?;

    if payload.with_unlock {
        if let Some((entries, opts)) = keyring_pair("load", &payload.keyring_entries, &payload.keyring_options)? {
            apply_keyring_reads(&mut data, entries, opts)?;
        }
    }

    Ok(data)
}

/// Saves (overwrites) an existing configuration file. Keyring entries are
/// written to the OS keyring (overwriting any previous values) and nullified
/// in the on-disk data. When `with_unlock` is true the fully unlocked data is
/// returned.
#[command]
pub(crate) async fn save<R: Runtime>(
    app: AppHandle<R>,
    payload: ConfiguratePayload,
) -> Result<Value> {
    let backend = storage::backend_for(&payload.format, payload.encryption_key.as_deref());
    let path = resolve_path(&app, payload.dir, &payload.name, payload.dir_name.as_deref(), payload.path.as_deref())?;

    let mut data = payload.data.unwrap_or(Value::Object(serde_json::Map::new()));

    let unlocked_data = if payload.with_unlock {
        Some(data.clone())
    } else {
        None
    };

    if let Some((entries, opts)) = keyring_pair("save", &payload.keyring_entries, &payload.keyring_options)? {
        apply_keyring_writes(&mut data, entries, opts)?;
    }

    backend.write(&path, &data)?;

    Ok(unlocked_data.unwrap_or(data))
}

/// Deletes a configuration file from disk and removes all associated keyring
/// entries from the OS keyring.
///
/// - Config file: always deleted if it exists; returns `Ok(())` if it does not.
/// - Keyring entries: deleted one by one on a best-effort basis. Errors
///   (including "no entry") are silently ignored so a partial keyring state
///   never blocks deletion and all entries are attempted.
#[command]
pub(crate) async fn delete<R: Runtime>(
    app: AppHandle<R>,
    payload: ConfiguratePayload,
) -> Result<()> {
    let path = resolve_path(&app, payload.dir, &payload.name, payload.dir_name.as_deref(), payload.path.as_deref())?;

    // Delete keyring entries first so secrets are wiped even if the file
    // removal fails for some reason. All entries are attempted regardless of
    // individual errors (best-effort cleanup).
    if let Some((entries, opts)) = keyring_pair("delete", &payload.keyring_entries, &payload.keyring_options)? {
        for entry in entries {
            let _ = keyring_store::delete(opts, &entry.id);
        }
    }

    // Remove the config file. Treat "file not found" as success.
    match std::fs::remove_file(&path) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }

    Ok(())
}

/// Reads keyring secrets and inlines them into already-loaded plain data,
/// returning the fully unlocked config **without re-reading the file from disk**.
///
/// This is the back-end for `LockedConfig.unlock()` on the TypeScript side,
/// allowing a single IPC round-trip for the file read (`load`) and a separate
/// single IPC round-trip for the keyring fetch (`unlock`), instead of issuing
/// two full file-read calls.
#[command]
pub(crate) async fn unlock(payload: UnlockPayload) -> Result<Value> {
    let mut data = payload.data;
    if let Some((entries, opts)) = keyring_pair("unlock", &payload.keyring_entries, &payload.keyring_options)? {
        apply_keyring_reads(&mut data, entries, opts)?;
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::KeyringOptions;

    // ---- validate_path_component ----

    #[test]
    fn valid_path_components() {
        for id in &[
            "myconfig",
            ".env",
            ".env.local",
            "my-config",
            "my_config",
            "my.config.v2",
            "config2",
            "app.json",
            "data.yaml",
            ".example",
        ] {
            assert!(validate_path_component(id).is_ok(), "should accept: {id}");
        }
    }

    #[test]
    fn invalid_path_components() {
        for id in &[
            "",
            ".",
            "..",
            "...",           // all-dots
            "my/config",
            "my\\config",
            "my:config",
            "my*config",
            "my?config",
            "my\"config",
            "my<config",
            "my>config",
            "my|config",
            "null\0byte",
        ] {
            assert!(
                validate_path_component(id).is_err(),
                "should reject: {id:?}",
            );
        }
    }

    // ---- validate_config_name ----

    #[test]
    fn valid_config_names() {
        for name in &["app.json", ".env", "data.yaml", "settings.binc", ".example", "my-conf.json"] {
            assert!(validate_config_name(name).is_ok(), "should accept: {name}");
        }
    }

    #[test]
    fn invalid_config_names() {
        for name in &["", ".", "..", "a/b.json", "a\\b.json", "a:b", "a*b"] {
            assert!(
                validate_config_name(name).is_err(),
                "should reject: {name:?}",
            );
        }
    }

    // ---- validate_dir_name ----

    #[test]
    fn valid_dir_names() {
        for s in &["myapp", "myapp/config", ".hidden/folder", "a/b/c", "my-app"] {
            assert!(validate_dir_name(s).is_ok(), "should accept: {s}");
        }
    }

    #[test]
    fn invalid_dir_names() {
        for s in &[
            "",        // empty
            "a//b",    // empty segment
            "a/../b",  // .. component
            "a:b",     // Windows-forbidden char
            "a/./b",   // bare dot component
            "a/.../b", // all-dots component
        ] {
            assert!(validate_dir_name(s).is_err(), "should reject: {s:?}");
        }
    }

    // ---- validate_path_field ----

    #[test]
    fn valid_path_fields() {
        for s in &[
            "config",
            "config/v2",
            "profiles/default",
            "a/b/c",
            ".hidden",
        ] {
            assert!(validate_path_field(s).is_ok(), "should accept: {s}");
        }
    }

    #[test]
    fn invalid_path_fields() {
        for s in &[
            "",
            "a//b",
            "a/../b",
            "a:b",
            "a/./b",
        ] {
            assert!(validate_path_field(s).is_err(), "should reject: {s:?}");
        }
    }

    // ---- keyring_pair ----

    fn make_opts() -> KeyringOptions {
        KeyringOptions {
            service: "svc".into(),
            account: "acc".into(),
        }
    }

    #[test]
    fn keyring_pair_both_some() {
        let entries = Some(vec![]);
        let opts = Some(make_opts());
        assert!(keyring_pair("op", &entries, &opts).unwrap().is_some());
    }

    #[test]
    fn keyring_pair_both_none() {
        let entries: Option<Vec<crate::models::KeyringEntry>> = None;
        let opts: Option<KeyringOptions> = None;
        assert!(keyring_pair("op", &entries, &opts).unwrap().is_none());
    }

    #[test]
    fn keyring_pair_entries_only_errors() {
        let entries = Some(vec![]);
        let opts: Option<KeyringOptions> = None;
        assert!(keyring_pair("op", &entries, &opts).is_err());
    }

    #[test]
    fn keyring_pair_opts_only_errors() {
        let entries: Option<Vec<crate::models::KeyringEntry>> = None;
        let opts = Some(make_opts());
        assert!(keyring_pair("op", &entries, &opts).is_err());
    }
}
