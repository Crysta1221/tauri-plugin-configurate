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
/// Leading dots are allowed so that names like `.env` are accepted.
/// Blocked: empty, `.`, `..`, and all Windows-forbidden characters
/// (`/ \ : * ? " < > |` and null bytes).
fn validate_path_component(component: &str) -> Result<()> {
    if component.is_empty()
        || component == "."
        || component == ".."
        || component.chars().any(|c| matches!(c, '/' | '\\' | '\0' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return Err(Error::InvalidPayload(format!(
            "invalid path component '{}': must not be empty, '.' or '..', \
and must not contain path separators or Windows-forbidden characters (: * ? \" < > |)",
            component
        )));
    }
    Ok(())
}

/// Validates that a config `id` is a safe single filename component.
fn validate_config_id(id: &str) -> Result<()> {
    validate_path_component(id)
}

/// Validates a `sub_dir` value (forward-slash-separated relative path).
///
/// Each segment is validated with `validate_path_component`.
fn validate_sub_dir(sub_dir: &str) -> Result<()> {
    if sub_dir.is_empty() {
        return Err(Error::InvalidPayload("subDir must not be empty".to_string()));
    }
    for component in sub_dir.split('/') {
        validate_path_component(component)?;
    }
    Ok(())
}

/// Resolves the absolute path for a config file using Tauri's path resolver.
///
/// `dir` is Tauri's `BaseDirectory` (deserialized from the TypeScript integer value).
/// When `sub_dir` is provided it is appended as a relative sub-directory path
/// between the base directory and the config filename.
fn resolve_path<R: Runtime>(
    app: &AppHandle<R>,
    dir: BaseDirectory,
    id: &str,
    ext: &str,
    sub_dir: Option<&str>,
) -> Result<PathBuf> {
    validate_config_id(id)?;
    if let Some(sub) = sub_dir {
        validate_sub_dir(sub)?;
    }
    // `resolve("", dir)` returns the base directory itself; the config filename
    // (and optional sub-directory) are then appended so all BaseDirectory
    // variants are handled uniformly through Tauri's official path resolver.
    let base = app
        .path()
        .resolve("", dir)
        .map_err(|e| Error::Storage(e.to_string()))?;
    let parent = match sub_dir {
        Some(sub) => base.join(sub),
        None => base,
    };
    Ok(parent.join(format!("{}.{}", id, ext)))
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
    let path = resolve_path(&app, payload.dir, &payload.id, backend.extension(), payload.sub_dir.as_deref())?;

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
    let path = resolve_path(&app, payload.dir, &payload.id, backend.extension(), payload.sub_dir.as_deref())?;

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
    let path = resolve_path(&app, payload.dir, &payload.id, backend.extension(), payload.sub_dir.as_deref())?;

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
    let backend = storage::backend_for(&payload.format, payload.encryption_key.as_deref());
    let path = resolve_path(&app, payload.dir, &payload.id, backend.extension(), payload.sub_dir.as_deref())?;

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
        ] {
            assert!(validate_path_component(id).is_ok(), "should accept: {}", id);
        }
    }

    #[test]
    fn invalid_path_components() {
        for id in &[
            "",
            ".",
            "..",
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
                "should reject: {:?}",
                id
            );
        }
    }

    // ---- validate_sub_dir ----

    #[test]
    fn valid_sub_dirs() {
        for s in &["myapp", "myapp/config", ".hidden/folder", "a/b/c", "my-app"] {
            assert!(validate_sub_dir(s).is_ok(), "should accept: {}", s);
        }
    }

    #[test]
    fn invalid_sub_dirs() {
        for s in &[
            "",        // empty
            "a//b",    // empty segment
            "a/../b",  // .. component
            "a:b",     // Windows-forbidden char
            "a/./b",   // bare dot component
        ] {
            assert!(validate_sub_dir(s).is_err(), "should reject: {:?}", s);
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
