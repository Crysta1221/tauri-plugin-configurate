use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{command, path::BaseDirectory, AppHandle, Manager, Runtime};

use crate::dotpath;
use crate::error::{Error, Result};
use crate::keyring_store;
use crate::models::{
    BatchEntryFailure, BatchEntryResult, BatchEntrySuccess, BatchPayload, BatchRunResult,
    ConfiguratePayload, KeyringEntry, KeyringOptions, NormalizedConfiguratePayload,
    NormalizedProvider, UnlockPayload,
};
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
        if matches!(
            c,
            '/' | '\\' | '\0' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
        ) {
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

/// Validates that a config `fileName` is a safe single filename component.
fn validate_file_name(name: &str) -> Result<()> {
    validate_path_component(name)
}

/// Validates a `dir_name` value (forward-slash-separated relative path).
fn validate_dir_name(dir_name: &str) -> Result<()> {
    if dir_name.is_empty() {
        return Err(Error::InvalidPayload(
            "options.dirName must not be empty".to_string(),
        ));
    }
    for component in dir_name.split('/') {
        validate_path_component(component)?;
    }
    Ok(())
}

/// Validates a `currentPath` value (forward-slash-separated relative sub-path within root).
fn validate_current_path(path: &str) -> Result<()> {
    if path.is_empty() {
        return Err(Error::InvalidPayload(
            "options.currentPath must not be empty".to_string(),
        ));
    }
    for component in path.split('/') {
        validate_path_component(component)?;
    }
    Ok(())
}

fn resolve_root<R: Runtime>(
    app: &AppHandle<R>,
    base_dir: BaseDirectory,
    dir_name: Option<&str>,
    current_path: Option<&str>,
) -> Result<PathBuf> {
    if let Some(d) = dir_name {
        validate_dir_name(d)?;
    }
    if let Some(p) = current_path {
        validate_current_path(p)?;
    }

    let base = app
        .path()
        .resolve("", base_dir)
        .map_err(|e| Error::Storage(e.to_string()))?;

    // When `dir_name` is provided and the resolved base path ends with the app
    // identifier (e.g. `%APPDATA%/com.example.app`), replace that last segment.
    // For directories without an identifier (e.g. Desktop, Home) `dir_name` is
    // appended as a sub-directory.
    let root = match dir_name {
        Some(d) => {
            let identifier = &app.config().identifier;
            if base.file_name().is_some_and(|n| n == identifier.as_str()) {
                base.parent().unwrap_or(&base).join(d)
            } else {
                base.join(d)
            }
        }
        None => base,
    };

    let parent = match current_path {
        Some(p) => root.join(p),
        None => root,
    };

    Ok(parent)
}

fn resolve_file_path<R: Runtime>(
    app: &AppHandle<R>,
    payload: &NormalizedConfiguratePayload,
) -> Result<PathBuf> {
    validate_file_name(&payload.file_name)?;
    let root = resolve_root(
        app,
        payload.base_dir,
        payload.dir_name.as_deref(),
        payload.current_path.as_deref(),
    )?;
    Ok(root.join(&payload.file_name))
}

fn resolve_sqlite_db_path<R: Runtime>(
    app: &AppHandle<R>,
    payload: &NormalizedConfiguratePayload,
) -> Result<PathBuf> {
    let NormalizedProvider::Sqlite { db_name, .. } = &payload.provider else {
        return Err(Error::InvalidPayload(
            "resolve_sqlite_db_path called for non-sqlite provider".to_string(),
        ));
    };
    validate_file_name(db_name)?;
    let root = resolve_root(
        app,
        payload.base_dir,
        payload.dir_name.as_deref(),
        payload.current_path.as_deref(),
    )?;
    Ok(root.join(db_name))
}

/// Writes keyring entries to the OS keyring and nullifies the corresponding
/// dotpaths in `data` so that secrets are never persisted to disk.
fn apply_keyring_writes(
    data: &mut Value,
    entries: &[KeyringEntry],
    opts: &KeyringOptions,
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
    opts: &KeyringOptions,
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
/// both be omitted.
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

fn load_plain_data<R: Runtime>(
    app: &AppHandle<R>,
    payload: &NormalizedConfiguratePayload,
) -> Result<Value> {
    match &payload.provider {
        NormalizedProvider::Sqlite { table_name, .. } => {
            let db_path = resolve_sqlite_db_path(app, payload)?;
            storage::read_sqlite(
                &db_path,
                table_name,
                &payload.file_name,
                &payload.schema_columns,
            )
        }
        _ => {
            let backend = storage::file_backend_for(&payload.provider)?;
            let path = resolve_file_path(app, payload)?;
            backend.read(&path)
        }
    }
}

fn save_plain_data<R: Runtime>(
    app: &AppHandle<R>,
    payload: &NormalizedConfiguratePayload,
    data: &Value,
) -> Result<()> {
    match &payload.provider {
        NormalizedProvider::Sqlite { table_name, .. } => {
            let db_path = resolve_sqlite_db_path(app, payload)?;
            storage::write_sqlite(
                &db_path,
                table_name,
                &payload.file_name,
                data,
                &payload.schema_columns,
            )
        }
        _ => {
            let backend = storage::file_backend_for(&payload.provider)?;
            let path = resolve_file_path(app, payload)?;
            backend.write(&path, data)
        }
    }
}

fn delete_plain_data<R: Runtime>(
    app: &AppHandle<R>,
    payload: &NormalizedConfiguratePayload,
) -> Result<()> {
    match &payload.provider {
        NormalizedProvider::Sqlite { table_name, .. } => {
            let db_path = resolve_sqlite_db_path(app, payload)?;
            storage::delete_sqlite(
                &db_path,
                table_name,
                &payload.file_name,
                &payload.schema_columns,
            )
        }
        _ => {
            let path = resolve_file_path(app, payload)?;
            // Remove the config file. Treat "file not found" as success.
            match std::fs::remove_file(&path) {
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
            Ok(())
        }
    }
}

fn execute_create<R: Runtime>(
    app: &AppHandle<R>,
    mut payload: NormalizedConfiguratePayload,
) -> Result<Value> {
    let mut data = payload
        .data
        .take()
        .unwrap_or(Value::Object(serde_json::Map::new()));

    // Keep a copy for the unlocked response before nullifying secrets.
    let unlocked_data = if payload.with_unlock {
        Some(data.clone())
    } else {
        None
    };

    if let Some((entries, opts)) =
        keyring_pair("create", &payload.keyring_entries, &payload.keyring_options)?
    {
        apply_keyring_writes(&mut data, entries, opts)?;
    }

    save_plain_data(app, &payload, &data)?;
    Ok(unlocked_data.unwrap_or(data))
}

fn execute_load<R: Runtime>(
    app: &AppHandle<R>,
    payload: NormalizedConfiguratePayload,
) -> Result<Value> {
    let mut data = load_plain_data(app, &payload)?;

    if payload.with_unlock {
        if let Some((entries, opts)) =
            keyring_pair("load", &payload.keyring_entries, &payload.keyring_options)?
        {
            apply_keyring_reads(&mut data, entries, opts)?;
        }
    }

    Ok(data)
}

fn execute_save<R: Runtime>(
    app: &AppHandle<R>,
    mut payload: NormalizedConfiguratePayload,
) -> Result<Value> {
    let mut data = payload
        .data
        .take()
        .unwrap_or(Value::Object(serde_json::Map::new()));

    let unlocked_data = if payload.with_unlock {
        Some(data.clone())
    } else {
        None
    };

    if let Some((entries, opts)) =
        keyring_pair("save", &payload.keyring_entries, &payload.keyring_options)?
    {
        apply_keyring_writes(&mut data, entries, opts)?;
    }

    save_plain_data(app, &payload, &data)?;
    Ok(unlocked_data.unwrap_or(data))
}

fn execute_delete<R: Runtime>(
    app: &AppHandle<R>,
    payload: NormalizedConfiguratePayload,
) -> Result<()> {
    // Delete keyring entries first so secrets are wiped even if the main
    // storage removal fails. All entries are attempted regardless of errors.
    // Failures are logged as warnings so partial cleanup is visible to developers.
    if let Some((entries, opts)) =
        keyring_pair("delete", &payload.keyring_entries, &payload.keyring_options)?
    {
        for entry in entries {
            if let Err(e) = keyring_store::delete(opts, &entry.id) {
                eprintln!(
                    "[tauri-plugin-configurate] warning: failed to delete keyring entry '{}': {}",
                    entry.id, e
                );
            }
        }
    }

    delete_plain_data(app, &payload)
}

fn to_batch_error_value(error: &Error) -> Value {
    serde_json::to_value(error).unwrap_or_else(|_| {
        json!({
            "kind": "unknown",
            "message": error.to_string(),
        })
    })
}

fn validate_batch_ids(payload: &BatchPayload) -> Result<()> {
    if payload.entries.is_empty() {
        return Err(Error::InvalidPayload(
            "batch payload requires at least one entry".to_string(),
        ));
    }

    let mut seen = BTreeSet::new();
    for entry in &payload.entries {
        if entry.id.is_empty() {
            return Err(Error::InvalidPayload(
                "batch entry id must not be empty".to_string(),
            ));
        }
        if !seen.insert(entry.id.clone()) {
            return Err(Error::InvalidPayload(format!(
                "batch entry id '{}' is duplicated",
                entry.id
            )));
        }
    }

    Ok(())
}

#[command]
pub(crate) async fn create<R: Runtime>(
    app: AppHandle<R>,
    payload: ConfiguratePayload,
) -> Result<Value> {
    execute_create(&app, payload.normalize()?)
}

#[command]
pub(crate) async fn load<R: Runtime>(
    app: AppHandle<R>,
    payload: ConfiguratePayload,
) -> Result<Value> {
    execute_load(&app, payload.normalize()?)
}

#[command]
pub(crate) async fn save<R: Runtime>(
    app: AppHandle<R>,
    payload: ConfiguratePayload,
) -> Result<Value> {
    execute_save(&app, payload.normalize()?)
}

#[command]
pub(crate) async fn delete<R: Runtime>(
    app: AppHandle<R>,
    payload: ConfiguratePayload,
) -> Result<()> {
    execute_delete(&app, payload.normalize()?)
}

#[command]
pub(crate) async fn load_all<R: Runtime>(
    app: AppHandle<R>,
    payload: BatchPayload,
) -> Result<BatchRunResult> {
    validate_batch_ids(&payload)?;

    let mut results = BTreeMap::new();

    for entry in payload.entries {
        let entry_result = match entry
            .payload
            .normalize()
            .and_then(|p| execute_load(&app, p))
        {
            Ok(data) => BatchEntryResult::Success(BatchEntrySuccess { ok: true, data }),
            Err(error) => BatchEntryResult::Failure(BatchEntryFailure {
                ok: false,
                error: to_batch_error_value(&error),
            }),
        };

        results.insert(entry.id, entry_result);
    }

    Ok(BatchRunResult { results })
}

#[command]
pub(crate) async fn save_all<R: Runtime>(
    app: AppHandle<R>,
    payload: BatchPayload,
) -> Result<BatchRunResult> {
    validate_batch_ids(&payload)?;

    let mut results = BTreeMap::new();

    for entry in payload.entries {
        let entry_result = match entry
            .payload
            .normalize()
            .and_then(|p| execute_save(&app, p))
        {
            Ok(data) => BatchEntryResult::Success(BatchEntrySuccess { ok: true, data }),
            Err(error) => BatchEntryResult::Failure(BatchEntryFailure {
                ok: false,
                error: to_batch_error_value(&error),
            }),
        };

        results.insert(entry.id, entry_result);
    }

    Ok(BatchRunResult { results })
}

/// Reads keyring secrets and inlines them into already-loaded plain data,
/// returning the fully unlocked config **without re-reading the file from disk**.
#[command]
pub(crate) async fn unlock(payload: UnlockPayload) -> Result<Value> {
    let mut data = payload.data;
    if let Some((entries, opts)) =
        keyring_pair("unlock", &payload.keyring_entries, &payload.keyring_options)?
    {
        apply_keyring_reads(&mut data, entries, opts)?;
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_path_components() {
        for id in &[
            "myconfig",
            ".env",
            ".env.local",
            "my-config",
            "my_config",
            "name.with.dots",
            "あいう",
        ] {
            assert!(
                validate_path_component(id).is_ok(),
                "expected valid: {}",
                id
            );
        }
    }

    #[test]
    fn invalid_path_components() {
        for id in &["", ".", "..", "...", "a/b", "a\\b", "a*", "bad ", "bad."] {
            assert!(
                validate_path_component(id).is_err(),
                "expected invalid: {}",
                id
            );
        }
    }

    #[test]
    fn batch_duplicate_id_is_rejected() {
        let payload: BatchPayload = serde_json::from_value(json!({
            "entries": [
                {"id": "a", "payload": {"fileName": "a.json", "baseDir": 8, "provider": {"kind": "json"}}},
                {"id": "a", "payload": {"fileName": "b.json", "baseDir": 8, "provider": {"kind": "json"}}}
            ]
        }))
        .unwrap();

        assert!(validate_batch_ids(&payload).is_err());
    }
}
