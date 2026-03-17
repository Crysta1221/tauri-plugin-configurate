use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{command, path::BaseDirectory, AppHandle, Emitter, Manager, Runtime};

use crate::dotpath;
use crate::error::{Error, Result};
use crate::keyring_store;
use crate::models::{
    BatchEntryFailure, BatchEntryResult, BatchEntrySuccess, BatchPayload, BatchRunResult,
    ConfiguratePayload, KeyringEntry, KeyringOptions, NormalizedConfiguratePayload,
    NormalizedProvider, UnlockPayload,
};
use crate::storage;

/// Event payload emitted after configuration changes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigChangeEvent {
    pub file_name: String,
    pub operation: String,
    pub target_id: String,
}

pub(crate) const CHANGE_EVENT: &str = "configurate://change";

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
        if entry.is_optional {
            // Optional field: treat "not found" as absent (null), not an error.
            match keyring_store::get_optional(opts, &entry.id)? {
                Some(secret) => {
                    let val: Value =
                        serde_json::from_str(&secret).unwrap_or(Value::String(secret));
                    dotpath::set(data, &entry.dotpath, val)?;
                }
                None => {
                    // Entry absent from keyring — leave the field as null.
                }
            }
        } else {
            let secret = keyring_store::get(opts, &entry.id)?;
            // The stored value might itself be a JSON object (for nested keyring fields).
            let val: Value = serde_json::from_str(&secret).unwrap_or(Value::String(secret));
            dotpath::set(data, &entry.dotpath, val)?;
        }
    }
    Ok(())
}

fn cleanup_stale_keyring_entries(
    delete_ids: &[String],
    opts: Option<&KeyringOptions>,
) -> Result<()> {
    if delete_ids.is_empty() {
        return Ok(());
    }

    let opts = opts.ok_or_else(|| {
        Error::InvalidPayload("keyringDeleteIds provided without keyringOptions".to_string())
    })?;
    let mut failures: Vec<String> = Vec::new();
    let mut seen = BTreeSet::new();

    for id in delete_ids {
        if !seen.insert(id.clone()) {
            continue;
        }
        if let Err(e) = keyring_store::delete(opts, id) {
            failures.push(format!("'{}': {}", id, e));
        }
    }

    if failures.is_empty() {
        return Ok(());
    }

    Err(Error::Keyring(format!(
        "some stale keyring entries could not be removed ({}). The config data \
         was written successfully, but orphaned entries may remain in the OS \
         keyring.",
        failures.join("; ")
    )))
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

    let keyring = keyring_pair("create", &payload.keyring_entries, &payload.keyring_options)?;

    // Nullify secrets in the on-disk data before saving.
    if let Some((entries, _opts)) = &keyring {
        for entry in *entries {
            dotpath::nullify(&mut data, &entry.dotpath)?;
        }
    }

    // Persist plain data first so that if it fails, the keyring is not updated.
    save_plain_data(app, &payload, &data)?;

    // Only write secrets to the OS keyring after successful storage write.
    if let Some((entries, opts)) = keyring {
        for entry in entries {
            keyring_store::set(opts, &entry.id, &entry.value)?;
        }
    }

    cleanup_stale_keyring_entries(
        &payload.keyring_delete_ids,
        payload.keyring_options.as_ref(),
    )?;
    if payload.return_data {
        Ok(unlocked_data.unwrap_or(data))
    } else {
        Ok(Value::Null)
    }
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

    let keyring = keyring_pair("save", &payload.keyring_entries, &payload.keyring_options)?;

    // Nullify secrets in the on-disk data before saving.
    if let Some((entries, _opts)) = &keyring {
        for entry in *entries {
            dotpath::nullify(&mut data, &entry.dotpath)?;
        }
    }

    // Persist plain data first so that if it fails, the keyring is not updated.
    save_plain_data(app, &payload, &data)?;

    // Only write secrets to the OS keyring after successful storage write.
    if let Some((entries, opts)) = keyring {
        for entry in entries {
            keyring_store::set(opts, &entry.id, &entry.value)?;
        }
    }

    cleanup_stale_keyring_entries(
        &payload.keyring_delete_ids,
        payload.keyring_options.as_ref(),
    )?;
    if payload.return_data {
        Ok(unlocked_data.unwrap_or(data))
    } else {
        Ok(Value::Null)
    }
}

fn execute_delete<R: Runtime>(
    app: &AppHandle<R>,
    payload: NormalizedConfiguratePayload,
) -> Result<()> {
    // Delete storage first so that if it fails the keyring entries are
    // preserved and the user can retry without data loss.
    // If storage deletion succeeds but keyring cleanup fails later, the
    // worst case is orphaned (but harmless) entries in the OS keyring.
    delete_plain_data(app, &payload)?;

    if let Some((entries, opts)) =
        keyring_pair("delete", &payload.keyring_entries, &payload.keyring_options)?
    {
        let mut failures: Vec<String> = Vec::new();
        for entry in entries {
            if let Err(e) = keyring_store::delete(opts, &entry.id) {
                failures.push(format!("'{}': {}", entry.id, e));
            }
        }
        if !failures.is_empty() {
            return Err(Error::Keyring(format!(
                "config file was deleted but some keyring entries could not be removed ({}). \
                 The orphaned entries are harmless but can be cleaned up manually via the OS \
                 keyring manager.",
                failures.join("; ")
            )));
        }
    }

    Ok(())
}

fn execute_exists<R: Runtime>(
    app: &AppHandle<R>,
    payload: NormalizedConfiguratePayload,
) -> Result<bool> {
    match &payload.provider {
        NormalizedProvider::Sqlite { table_name, .. } => {
            let db_path = resolve_sqlite_db_path(app, &payload)?;
            storage::exists_sqlite(
                &db_path,
                table_name,
                &payload.file_name,
                &payload.schema_columns,
            )
        }
        _ => {
            let path = resolve_file_path(app, &payload)?;
            Ok(path.is_file())
        }
    }
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

fn provider_kind(provider: &NormalizedProvider) -> &'static str {
    match provider {
        NormalizedProvider::Json => "json",
        NormalizedProvider::Yml => "yml",
        NormalizedProvider::Toml => "toml",
        NormalizedProvider::Binary { .. } => "binary",
        NormalizedProvider::Sqlite { .. } => "sqlite",
    }
}

fn change_target_id(payload: &NormalizedConfiguratePayload) -> String {
    let base_dir_key = serde_json::to_string(&payload.base_dir).unwrap_or_else(|_| "null".into());
    let (db_name, table_name) = match &payload.provider {
        NormalizedProvider::Sqlite { db_name, table_name } => {
            (db_name.as_str(), table_name.as_str())
        }
        _ => ("", ""),
    };

    format!(
        "{}|{}|{}|{}|{}|{}|{}",
        base_dir_key,
        provider_kind(&payload.provider),
        payload.file_name,
        payload.dir_name.as_deref().unwrap_or(""),
        payload.current_path.as_deref().unwrap_or(""),
        db_name,
        table_name
    )
}

fn build_change_event(
    payload: &NormalizedConfiguratePayload,
    operation: &str,
) -> ConfigChangeEvent {
    ConfigChangeEvent {
        file_name: payload.file_name.clone(),
        operation: operation.to_string(),
        target_id: change_target_id(payload),
    }
}

fn emit_change<R: Runtime>(app: &AppHandle<R>, event: ConfigChangeEvent) {
    let _ = app.emit(CHANGE_EVENT, event);
}

/// Returns an `Arc<Mutex<()>>` that serialises file-system access to `path`
/// within this process.  SQLite operations are excluded because SQLite manages
/// its own concurrency via WAL locking.
fn acquire_file_lock<R: Runtime>(
    app: &AppHandle<R>,
    payload: &NormalizedConfiguratePayload,
) -> Option<Arc<Mutex<()>>> {
    if matches!(payload.provider, NormalizedProvider::Sqlite { .. }) {
        return None;
    }
    if let Ok(path) = resolve_file_path(app, payload) {
        let registry = app.state::<crate::locker::FileLockRegistry>();
        Some(registry.acquire(path))
    } else {
        None
    }
}

#[command]
pub(crate) async fn create<R: Runtime>(
    app: AppHandle<R>,
    payload: ConfiguratePayload,
) -> Result<Value> {
    let normalized = payload.normalize()?;
    let change_event = build_change_event(&normalized, "create");
    let lock = acquire_file_lock(&app, &normalized);
    let _guard = lock.as_ref().map(|l| l.lock().unwrap_or_else(|e| e.into_inner()));
    let result = execute_create(&app, normalized)?;
    drop(_guard);
    emit_change(&app, change_event);
    Ok(result)
}

#[command]
pub(crate) async fn load<R: Runtime>(
    app: AppHandle<R>,
    payload: ConfiguratePayload,
) -> Result<Value> {
    let normalized = payload.normalize()?;
    let lock = acquire_file_lock(&app, &normalized);
    let _guard = lock.as_ref().map(|l| l.lock().unwrap_or_else(|e| e.into_inner()));
    execute_load(&app, normalized)
}

#[command]
pub(crate) async fn save<R: Runtime>(
    app: AppHandle<R>,
    payload: ConfiguratePayload,
) -> Result<Value> {
    let normalized = payload.normalize()?;
    let change_event = build_change_event(&normalized, "save");
    let lock = acquire_file_lock(&app, &normalized);
    let _guard = lock.as_ref().map(|l| l.lock().unwrap_or_else(|e| e.into_inner()));
    let result = execute_save(&app, normalized)?;
    drop(_guard);
    emit_change(&app, change_event);
    Ok(result)
}

#[command]
pub(crate) async fn delete<R: Runtime>(
    app: AppHandle<R>,
    payload: ConfiguratePayload,
) -> Result<()> {
    let normalized = payload.normalize()?;
    let change_event = build_change_event(&normalized, "delete");
    let lock = acquire_file_lock(&app, &normalized);
    let _guard = lock.as_ref().map(|l| l.lock().unwrap_or_else(|e| e.into_inner()));
    execute_delete(&app, normalized)?;
    drop(_guard);
    emit_change(&app, change_event);
    Ok(())
}

#[command]
pub(crate) async fn exists<R: Runtime>(
    app: AppHandle<R>,
    payload: ConfiguratePayload,
) -> Result<bool> {
    let normalized = payload.normalize()?;
    let lock = acquire_file_lock(&app, &normalized);
    let _guard = lock.as_ref().map(|l| l.lock().unwrap_or_else(|e| e.into_inner()));
    execute_exists(&app, normalized)
}

#[command]
pub(crate) async fn load_all<R: Runtime>(
    app: AppHandle<R>,
    payload: BatchPayload,
) -> Result<BatchRunResult> {
    validate_batch_ids(&payload)?;

    let mut results = BTreeMap::new();

    for entry in payload.entries {
        let entry_result = match entry.payload.normalize().and_then(|p| {
            let lock = acquire_file_lock(&app, &p);
            let _guard = lock.as_ref().map(|l| l.lock().unwrap_or_else(|e| e.into_inner()));
            execute_load(&app, p)
        }) {
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
    let mut change_events = Vec::new();

    for entry in payload.entries {
        let entry_id = entry.id.clone();
        let entry_result = match entry.payload.normalize().and_then(|p| {
            let change_event = build_change_event(&p, "save");
            let lock = acquire_file_lock(&app, &p);
            let _guard = lock.as_ref().map(|l| l.lock().unwrap_or_else(|e| e.into_inner()));
            let result = execute_save(&app, p)?;
            change_events.push(change_event);
            Ok(result)
        }) {
            Ok(data) => BatchEntryResult::Success(BatchEntrySuccess { ok: true, data }),
            Err(error) => BatchEntryResult::Failure(BatchEntryFailure {
                ok: false,
                error: to_batch_error_value(&error),
            }),
        };

        results.insert(entry_id, entry_result);
    }

    for change_event in change_events {
        emit_change(&app, change_event);
    }

    Ok(BatchRunResult { results })
}

/// Deep-merges `patch` into `base`. Object keys are merged recursively;
/// all other values are replaced.
fn deep_merge(base: &mut Value, patch: Value) {
    match (base, patch) {
        (Value::Object(base_map), Value::Object(patch_map)) => {
            for (key, patch_val) in patch_map {
                let entry = base_map
                    .entry(key)
                    .or_insert(Value::Null);
                deep_merge(entry, patch_val);
            }
        }
        (base, patch) => {
            *base = patch;
        }
    }
}

fn execute_patch<R: Runtime>(
    app: &AppHandle<R>,
    mut payload: NormalizedConfiguratePayload,
) -> Result<Value> {
    let mut existing = match load_plain_data(app, &payload) {
        Ok(data) => data,
        Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            if payload.create_if_missing {
                Value::Object(serde_json::Map::new())
            } else {
                return Err(Error::InvalidPayload(format!(
                    "config '{}' does not exist; use create() or save() to create it \
                     first, or call .createIfMissing() on the patch entry",
                    payload.file_name
                )));
            }
        }
        Err(e) => return Err(e),
    };

    let patch_data = payload
        .data
        .take()
        .unwrap_or(Value::Object(serde_json::Map::new()));

    deep_merge(&mut existing, patch_data);

    let unlocked_data = if payload.with_unlock {
        Some(existing.clone())
    } else {
        None
    };

    if let Some((entries, opts)) =
        keyring_pair("patch", &payload.keyring_entries, &payload.keyring_options)?
    {
        apply_keyring_writes(&mut existing, entries, opts)?;
    }

    save_plain_data(app, &payload, &existing)?;
    cleanup_stale_keyring_entries(
        &payload.keyring_delete_ids,
        payload.keyring_options.as_ref(),
    )?;
    if payload.return_data {
        Ok(unlocked_data.unwrap_or(existing))
    } else {
        Ok(Value::Null)
    }
}

#[command]
pub(crate) async fn patch<R: Runtime>(
    app: AppHandle<R>,
    payload: ConfiguratePayload,
) -> Result<Value> {
    let normalized = payload.normalize()?;
    let change_event = build_change_event(&normalized, "patch");
    // Patch is a read-then-write; lock the file for the full duration.
    let lock = acquire_file_lock(&app, &normalized);
    let _guard = lock.as_ref().map(|l| l.lock().unwrap_or_else(|e| e.into_inner()));
    let result = execute_patch(&app, normalized)?;
    drop(_guard);
    emit_change(&app, change_event);
    Ok(result)
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

#[command]
pub(crate) async fn patch_all<R: Runtime>(
    app: AppHandle<R>,
    payload: BatchPayload,
) -> Result<BatchRunResult> {
    validate_batch_ids(&payload)?;

    let mut results = BTreeMap::new();
    let mut change_events = Vec::new();

    for entry in payload.entries {
        let entry_id = entry.id.clone();
        let entry_result = match entry.payload.normalize().and_then(|p| {
            let change_event = build_change_event(&p, "patch");
            let lock = acquire_file_lock(&app, &p);
            let _guard = lock.as_ref().map(|l| l.lock().unwrap_or_else(|e| e.into_inner()));
            let result = execute_patch(&app, p)?;
            change_events.push(change_event);
            Ok(result)
        }) {
            Ok(data) => BatchEntryResult::Success(BatchEntrySuccess { ok: true, data }),
            Err(error) => BatchEntryResult::Failure(BatchEntryFailure {
                ok: false,
                error: to_batch_error_value(&error),
            }),
        };

        results.insert(entry_id, entry_result);
    }

    for change_event in change_events {
        emit_change(&app, change_event);
    }

    Ok(BatchRunResult { results })
}

/// Begins watching a file for external changes and emits `configurate://change`
/// events with `operation = "external_change"` when the file is modified by
/// an external process.
#[command]
pub(crate) async fn watch_file<R: Runtime>(
    app: AppHandle<R>,
    payload: ConfiguratePayload,
) -> Result<()> {
    let normalized = payload.normalize()?;
    // Only file-based providers support watching.
    if matches!(normalized.provider, NormalizedProvider::Sqlite { .. }) {
        return Err(Error::InvalidPayload(
            "watch_file is not supported for the SQLite provider".to_string(),
        ));
    }
    let path = resolve_file_path(&app, &normalized)?;
    let change_event = build_change_event(&normalized, "external_change");
    let watcher = app.state::<crate::watcher::WatcherState>();
    watcher.watch(path, change_event)
}

/// Stops watching a file that was previously registered via `watch_file`.
#[command]
pub(crate) async fn unwatch_file<R: Runtime>(
    app: AppHandle<R>,
    payload: ConfiguratePayload,
) -> Result<()> {
    let normalized = payload.normalize()?;
    if matches!(normalized.provider, NormalizedProvider::Sqlite { .. }) {
        return Ok(());
    }
    let path = resolve_file_path(&app, &normalized)?;
    let target_id = change_target_id(&normalized);
    let watcher = app.state::<crate::watcher::WatcherState>();
    watcher.unwatch(&path, &target_id)
}

/// Returns `true` if `name` is a rotating-backup file (ends with `.bakN`
/// where N is one or more ASCII digits).  Avoids false-positives for names
/// that merely *contain* the substring `.bak` (e.g. `my.bakery.json`).
fn is_backup_filename(name: &str) -> bool {
    if let Some(pos) = name.rfind(".bak") {
        let suffix = &name[pos + 4..];
        !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit())
    } else {
        false
    }
}

/// Lists config files (by file name) in the resolved root directory.
///
/// For file-based providers, scans the directory for files matching the
/// provider's extension.  For SQLite, queries `config_key` values from the
/// table.
#[command]
pub(crate) async fn list_configs<R: Runtime>(
    app: AppHandle<R>,
    payload: ConfiguratePayload,
) -> Result<Vec<String>> {
    let normalized = payload.normalize()?;

    match &normalized.provider {
        NormalizedProvider::Sqlite { table_name, .. } => {
            let db_path = resolve_sqlite_db_path(&app, &normalized)?;
            storage::list_sqlite(&db_path, table_name)
        }
        _ => {
            let root = resolve_root(
                &app,
                normalized.base_dir,
                normalized.dir_name.as_deref(),
                normalized.current_path.as_deref(),
            )?;
            let ext = match &normalized.provider {
                NormalizedProvider::Json => Some("json"),
                NormalizedProvider::Yml => Some("yml"),
                NormalizedProvider::Toml => Some("toml"),
                NormalizedProvider::Binary { .. } => None,
                NormalizedProvider::Sqlite { .. } => unreachable!(),
            };
            let mut names = Vec::new();
            if root.is_dir() {
                for entry in std::fs::read_dir(&root)? {
                    let entry = entry?;
                    let path = entry.path();
                    if !path.is_file() {
                        continue;
                    }
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        // Skip backup files (e.g. config.json.bak1).
                        if is_backup_filename(name) {
                            continue;
                        }
                        // Skip temp files.
                        if name.starts_with('.') && name.ends_with(".tmp") {
                            continue;
                        }
                        match ext {
                            Some(e) => {
                                if path.extension().is_some_and(|x| x == e) {
                                    names.push(name.to_string());
                                }
                            }
                            None => names.push(name.to_string()),
                        }
                    }
                }
            }
            names.sort();
            Ok(names)
        }
    }
}

/// Resets a config by deleting the existing data and re-creating it with
/// the provided default data.
#[command]
pub(crate) async fn reset<R: Runtime>(
    app: AppHandle<R>,
    payload: ConfiguratePayload,
) -> Result<Value> {
    let normalized = payload.normalize()?;
    let change_event = build_change_event(&normalized, "reset");
    let lock = acquire_file_lock(&app, &normalized);
    let _guard = lock.as_ref().map(|l| l.lock().unwrap_or_else(|e| e.into_inner()));
    // Delete then create = reset.
    let _ = delete_plain_data(&app, &normalized);
    let result = execute_create(&app, normalized)?;
    drop(_guard);
    emit_change(&app, change_event);
    Ok(result)
}

/// Export payload sent from TypeScript side.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPayload {
    pub source: ConfiguratePayload,
    pub target_format: String,
}

/// Exports a config from its current provider format to a different format
/// string (JSON / YML / TOML).
#[command]
pub(crate) async fn export_config<R: Runtime>(
    app: AppHandle<R>,
    payload: ExportPayload,
) -> Result<String> {
    let normalized = payload.source.normalize()?;
    let lock = acquire_file_lock(&app, &normalized);
    let _guard = lock.as_ref().map(|l| l.lock().unwrap_or_else(|e| e.into_inner()));
    let data = match normalized.data.clone() {
        Some(data) => data,
        None => execute_load(&app, normalized)?,
    };

    match payload.target_format.as_str() {
        "json" => serde_json::to_string_pretty(&data)
            .map_err(|e| Error::Storage(e.to_string())),
        "yml" | "yaml" => serde_yml::to_string(&data)
            .map_err(|e| Error::Storage(e.to_string())),
        "toml" => {
            let toml_val = storage::json_to_toml(&data)?;
            toml::to_string_pretty(&toml_val)
                .map_err(|e| Error::Storage(e.to_string()))
        }
        other => Err(Error::InvalidPayload(format!(
            "unsupported export format '{}': expected json, yml, or toml",
            other
        ))),
    }
}

/// Import payload sent from TypeScript side.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPayload {
    pub target: ConfiguratePayload,
    pub source_format: Option<String>,
    pub content: Option<String>,
    #[serde(default)]
    pub parse_only: bool,
}

/// Imports config data from a string in the given format, saving it to the
/// target config location.
#[command]
pub(crate) async fn import_config<R: Runtime>(
    app: AppHandle<R>,
    payload: ImportPayload,
) -> Result<Value> {
    let ImportPayload {
        target,
        source_format,
        content,
        parse_only,
    } = payload;

    let data: Value = match target.data.clone() {
        Some(data) => data,
        None => match source_format
            .as_deref()
            .ok_or_else(|| Error::InvalidPayload("missing sourceFormat".to_string()))?
        {
            "json" => serde_json::from_str(
                &content
                    .as_deref()
                    .ok_or_else(|| Error::InvalidPayload("missing content".to_string()))?,
            )
            .map_err(|e| Error::Storage(e.to_string()))?,
            "yml" | "yaml" => {
                let yaml_val: serde_yml::Value = serde_yml::from_str(
                    &content
                        .as_deref()
                        .ok_or_else(|| Error::InvalidPayload("missing content".to_string()))?,
                )
                .map_err(|e| Error::Storage(e.to_string()))?;
                serde_json::to_value(yaml_val)
                    .map_err(|e| Error::Storage(e.to_string()))?
            }
            "toml" => {
                let toml_val: toml::Value = toml::from_str(
                    &content
                        .as_deref()
                        .ok_or_else(|| Error::InvalidPayload("missing content".to_string()))?,
                )
                .map_err(|e| Error::Storage(e.to_string()))?;
                serde_json::to_value(toml_val)
                    .map_err(|e| Error::Storage(e.to_string()))?
            }
            other => {
                return Err(Error::InvalidPayload(format!(
                    "unsupported import format '{}': expected json, yml, or toml",
                    other
                )))
            }
        },
    };

    if parse_only {
        return Ok(data);
    }

    let mut normalized = target.normalize()?;
    normalized.data = Some(data);
    let change_event = build_change_event(&normalized, "import");
    let lock = acquire_file_lock(&app, &normalized);
    let _guard = lock.as_ref().map(|l| l.lock().unwrap_or_else(|e| e.into_inner()));
    let result = execute_save(&app, normalized)?;
    drop(_guard);
    emit_change(&app, change_event);
    Ok(result)
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

    #[test]
    fn deep_merge_adds_new_keys() {
        let mut base = json!({"a": 1});
        deep_merge(&mut base, json!({"b": 2}));
        assert_eq!(base, json!({"a": 1, "b": 2}));
    }

    #[test]
    fn deep_merge_overwrites_scalar() {
        let mut base = json!({"a": 1});
        deep_merge(&mut base, json!({"a": 99}));
        assert_eq!(base, json!({"a": 99}));
    }

    #[test]
    fn deep_merge_nested_objects() {
        let mut base = json!({"db": {"host": "localhost", "port": 5432}});
        deep_merge(&mut base, json!({"db": {"port": 3306, "name": "mydb"}}));
        assert_eq!(
            base,
            json!({"db": {"host": "localhost", "port": 3306, "name": "mydb"}})
        );
    }

    #[test]
    fn deep_merge_replaces_non_object_with_object() {
        let mut base = json!({"a": "string"});
        deep_merge(&mut base, json!({"a": {"nested": true}}));
        assert_eq!(base, json!({"a": {"nested": true}}));
    }

    #[test]
    fn validate_dir_name_accepts_multi_segment() {
        assert!(validate_dir_name("com/example/app").is_ok());
        assert!(validate_dir_name("my-app").is_ok());
    }

    #[test]
    fn validate_dir_name_rejects_empty_segments() {
        assert!(validate_dir_name("").is_err());
        assert!(validate_dir_name("a//b").is_err());
        assert!(validate_dir_name("/a").is_err());
    }

    #[test]
    fn validate_current_path_basic() {
        assert!(validate_current_path("sub/path").is_ok());
        assert!(validate_current_path("").is_err());
        assert!(validate_current_path("a/..").is_err());
    }

    #[test]
    fn batch_empty_is_rejected() {
        let payload: BatchPayload = serde_json::from_value(json!({
            "entries": []
        }))
        .unwrap();
        assert!(validate_batch_ids(&payload).is_err());
    }

    #[test]
    fn batch_empty_id_is_rejected() {
        let payload: BatchPayload = serde_json::from_value(json!({
            "entries": [
                {"id": "", "payload": {"fileName": "a.json", "baseDir": 8, "provider": {"kind": "json"}}}
            ]
        }))
        .unwrap();
        assert!(validate_batch_ids(&payload).is_err());
    }

    // ── is_backup_filename ───────────────────────────────────────────────────

    #[test]
    fn backup_filename_matches_bak_with_digits() {
        // Exact backup suffixes produced by create_backup().
        assert!(is_backup_filename("config.json.bak1"));
        assert!(is_backup_filename("config.json.bak2"));
        assert!(is_backup_filename("config.json.bak3"));
        assert!(is_backup_filename("settings.toml.bak10"));
    }

    #[test]
    fn backup_filename_no_false_positive_for_bak_in_name() {
        // Files whose names *contain* ".bak" but are not backup files.
        assert!(!is_backup_filename("my.bakery.json"));
        assert!(!is_backup_filename("feedback.json"));
        assert!(!is_backup_filename("config.bak")); // no trailing digit(s)
        assert!(!is_backup_filename("archive.bak.json"));
    }

    #[test]
    fn backup_filename_rejects_plain_name() {
        assert!(!is_backup_filename("config.json"));
        assert!(!is_backup_filename("settings.toml"));
    }

    // ── list_configs file filtering ──────────────────────────────────────────

    #[test]
    fn list_configs_filter_excludes_backups_and_tmp() {
        use std::fs;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // Regular files that should be included.
        fs::write(root.join("alpha.json"), b"{}").unwrap();
        fs::write(root.join("beta.json"), b"{}").unwrap();

        // Backup files that must be excluded.
        fs::write(root.join("alpha.json.bak1"), b"{}").unwrap();
        fs::write(root.join("alpha.json.bak2"), b"{}").unwrap();

        // Temp file that must be excluded.
        fs::write(root.join(".alpha.json.tmp"), b"{}").unwrap();

        // File with ".bak" in the name but NOT a backup (should be included for Binary).
        fs::write(root.join("my.bakery.bin"), b"data").unwrap();

        let mut names: Vec<String> = Vec::new();
        for entry in fs::read_dir(root).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if is_backup_filename(name) {
                    continue;
                }
                if name.starts_with('.') && name.ends_with(".tmp") {
                    continue;
                }
                // Simulate JSON-extension filter.
                if path.extension().is_some_and(|x| x == "json") {
                    names.push(name.to_string());
                }
            }
        }
        names.sort();
        assert_eq!(names, vec!["alpha.json", "beta.json"]);
    }

    #[test]
    fn list_configs_filter_does_not_exclude_bakery_name() {
        // Ensures "my.bakery.json" is NOT mistakenly treated as a backup file.
        assert!(!is_backup_filename("my.bakery.json"));
    }
}
