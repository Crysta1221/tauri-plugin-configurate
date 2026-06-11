use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{command, path::BaseDirectory, AppHandle, Emitter, Manager, Runtime};

use crate::config;
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

/// Builds the config root path under a resolved `base` directory.
///
/// `dir_name` and `current_path` must already be validated. Paths always stay
/// under `base`; `dir_name` is a relative sub-path (e.g. `configs/v2`), not a
/// replacement for the app-identifier segment.
fn resolve_root_path(
    base: &std::path::Path,
    dir_name: Option<&str>,
    current_path: Option<&str>,
) -> PathBuf {
    let root = match dir_name {
        Some(d) => base.join(d),
        None => base.to_path_buf(),
    };

    match current_path {
        Some(p) => root.join(p),
        None => root,
    }
}

fn resolve_root<R: Runtime>(
    app: &AppHandle<R>,
    base_dir: BaseDirectory,
    dir_name: Option<&str>,
    current_path: Option<&str>,
) -> Result<PathBuf> {
    config::validate_base_directory(app, base_dir)?;
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

    Ok(resolve_root_path(&base, dir_name, current_path))
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

fn keyring_secret_as_value(secret: String) -> Value {
    Value::String(secret)
}

/// Reads keyring entries and inlines the plaintext values back into `data`
/// at the correct dotpath location.
fn apply_keyring_reads(
    data: &mut Value,
    entries: &[KeyringEntry],
    opts: &KeyringOptions,
) -> Result<()> {
    for entry in entries {
        let val = if entry.is_optional {
            match keyring_store::get_optional(opts, &entry.id)? {
                Some(secret) => keyring_secret_as_value(secret),
                None => Value::Null,
            }
        } else {
            keyring_secret_as_value(keyring_store::get(opts, &entry.id)?)
        };
        dotpath::set(data, &entry.dotpath, val)?;
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum KeyringEntryUse {
    Read,
    Write,
}

fn validate_keyring_entries(entries: &[KeyringEntry], use_: KeyringEntryUse) -> Result<()> {
    for entry in entries {
        keyring_store::validate_entry_id(&entry.id)?;
        dotpath::validate_path(&entry.dotpath)?;
        if matches!(use_, KeyringEntryUse::Read) && !entry.value.is_empty() {
            return Err(Error::InvalidPayload(format!(
                "keyring entry '{}' must not include a value on read operations",
                entry.id
            )));
        }
    }
    Ok(())
}

fn validate_keyring_delete_ids(ids: &[String]) -> Result<()> {
    for id in ids {
        keyring_store::validate_entry_id(id)?;
    }
    Ok(())
}

fn write_keyring_entries(opts: &KeyringOptions, entries: &[KeyringEntry]) -> Result<()> {
    for entry in entries {
        keyring_store::set(opts, &entry.id, &entry.value)?;
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
    validate_keyring_delete_ids(delete_ids)?;

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
    use_: KeyringEntryUse,
    keyring_entries: &'a Option<Vec<KeyringEntry>>,
    keyring_options: &'a Option<KeyringOptions>,
) -> Result<Option<(&'a [KeyringEntry], &'a KeyringOptions)>> {
    match (keyring_entries.as_deref(), keyring_options.as_ref()) {
        (Some(entries), Some(opts)) => {
            validate_keyring_entries(entries, use_)?;
            Ok(Some((entries, opts)))
        }
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
    let max_read_bytes = config::max_read_bytes(app);
    let backend = storage::file_backend_for(
        &payload.provider,
        false,
        storage::read_only_registry(),
        max_read_bytes,
    )?;
    let path = resolve_file_path(app, payload)?;
    backend.read(&path)
}

fn save_plain_data<R: Runtime>(
    app: &AppHandle<R>,
    payload: &NormalizedConfiguratePayload,
    data: &Value,
) -> Result<()> {
    let registry = app
        .try_state::<Arc<storage::BackupRegistry>>()
        .map(|s| Arc::clone(s.inner()))
        .unwrap_or_else(|| Arc::new(storage::BackupRegistry::new()));
    let max_read_bytes = config::max_read_bytes(app);
    let backend = storage::file_backend_for(
        &payload.provider,
        payload.backup,
        registry,
        max_read_bytes,
    )?;
    let path = resolve_file_path(app, payload)?;
    backend.write(&path, data)
}

fn delete_plain_data<R: Runtime>(
    app: &AppHandle<R>,
    payload: &NormalizedConfiguratePayload,
) -> Result<()> {
    let path = resolve_file_path(app, payload)?;
    // Remove the config file. Treat "file not found" as success.
    match std::fs::remove_file(&path) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    Ok(())
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
    let unlocked_data = if payload.with_unlock && payload.return_data {
        Some(data.clone())
    } else {
        None
    };

    let keyring = keyring_pair(
        "create",
        KeyringEntryUse::Write,
        &payload.keyring_entries,
        &payload.keyring_options,
    )?;

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
        write_keyring_entries(opts, entries)?;
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
    validate_load_keyring_policy(&payload)?;
    let data = load_plain_data(app, &payload)?;
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

    let unlocked_data = if payload.with_unlock && payload.return_data {
        Some(data.clone())
    } else {
        None
    };

    let keyring = keyring_pair(
        "save",
        KeyringEntryUse::Write,
        &payload.keyring_entries,
        &payload.keyring_options,
    )?;

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
        write_keyring_entries(opts, entries)?;
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
        keyring_pair(
            "delete",
            KeyringEntryUse::Read,
            &payload.keyring_entries,
            &payload.keyring_options,
        )?
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
    let path = resolve_file_path(app, &payload)?;
    Ok(path.is_file())
}

fn to_batch_error_value(error: &Error) -> Value {
    serde_json::to_value(error).unwrap_or_else(|_| {
        json!({
            "kind": "unknown",
            "message": error.to_string(),
        })
    })
}

/// Maximum number of entries allowed in a single batch command.
const MAX_BATCH_ENTRIES: usize = 128;

/// Rejects `load` payloads that try to read the keyring via `withUnlock`.
/// Keyring access must go through the `unlock` command (`allow-unlock`).
fn validate_load_keyring_policy(payload: &NormalizedConfiguratePayload) -> Result<()> {
    if payload.with_unlock
        && (payload.keyring_entries.is_some() || payload.keyring_options.is_some())
    {
        return Err(Error::InvalidPayload(
            "load with withUnlock cannot access the keyring; use the unlock command instead"
                .to_string(),
        ));
    }
    Ok(())
}

fn validate_batch_ids(payload: &BatchPayload) -> Result<()> {
    if payload.entries.is_empty() {
        return Err(Error::InvalidPayload(
            "batch payload requires at least one entry".to_string(),
        ));
    }
    if payload.entries.len() > MAX_BATCH_ENTRIES {
        return Err(Error::InvalidPayload(format!(
            "batch payload exceeds maximum of {} entries",
            MAX_BATCH_ENTRIES
        )));
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
    }
}

fn change_target_id(payload: &NormalizedConfiguratePayload) -> String {
    let base_dir_key = serde_json::to_string(&payload.base_dir).unwrap_or_else(|_| "null".into());

    format!(
        "{}|{}|{}|{}|{}",
        base_dir_key,
        provider_kind(&payload.provider),
        payload.file_name,
        payload.dir_name.as_deref().unwrap_or(""),
        payload.current_path.as_deref().unwrap_or(""),
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

/// Returns an `Arc<Mutex<()>>` that serialises access to the config file path
/// within this process so multi-step operations (patch, reset) cannot interleave.
fn acquire_file_lock<R: Runtime>(
    app: &AppHandle<R>,
    payload: &NormalizedConfiguratePayload,
) -> Option<Arc<Mutex<()>>> {
    resolve_file_path(app, payload).ok().map(|p| {
        let registry = app.state::<crate::locker::FileLockRegistry>();
        registry.acquire(p)
    })
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
        let crate::models::BatchEntryPayload { id, payload } = entry;
        let entry_result = match payload.normalize().and_then(|p| {
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

        results.insert(id, entry_result);
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

    let unlocked_data = if payload.with_unlock && payload.return_data {
        Some(existing.clone())
    } else {
        None
    };

    let keyring = keyring_pair(
        "patch",
        KeyringEntryUse::Write,
        &payload.keyring_entries,
        &payload.keyring_options,
    )?;

    // Nullify secrets in the on-disk data before saving.
    if let Some((entries, _opts)) = &keyring {
        for entry in *entries {
            dotpath::nullify(&mut existing, &entry.dotpath)?;
        }
    }

    // Persist plain data first so that if it fails, the keyring is not updated.
    save_plain_data(app, &payload, &existing)?;

    // Only write secrets to the OS keyring after successful storage write.
    if let Some((entries, opts)) = keyring {
        write_keyring_entries(opts, entries)?;
    }

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
        keyring_pair(
            "unlock",
            KeyringEntryUse::Read,
            &payload.keyring_entries,
            &payload.keyring_options,
        )?
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
        let crate::models::BatchEntryPayload { id, payload } = entry;
        let entry_result = match payload.normalize().and_then(|p| {
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

        results.insert(id, entry_result);
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
#[command]
pub(crate) async fn list_configs<R: Runtime>(
    app: AppHandle<R>,
    payload: ConfiguratePayload,
) -> Result<Vec<String>> {
    let normalized = payload.normalize()?;

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
    // Delete then create = reset. Propagate errors so failures are not silently ignored.
    delete_plain_data(&app, &normalized)?;
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

fn parse_import_content(format: &str, content: &str, max_read_bytes: usize) -> Result<Value> {
    if content.len() > max_read_bytes {
        return Err(Error::InvalidPayload(format!(
            "import content exceeds maximum size of {} bytes",
            max_read_bytes
        )));
    }

    match format {
        "json" => serde_json::from_str(content).map_err(|e| Error::Storage(e.to_string())),
        "yml" | "yaml" => {
            let yaml_val: serde_yml::Value =
                serde_yml::from_str(content).map_err(|e| Error::Storage(e.to_string()))?;
            serde_json::to_value(yaml_val).map_err(|e| Error::Storage(e.to_string()))
        }
        "toml" => {
            let toml_val: toml::Value =
                toml::from_str(content).map_err(|e| Error::Storage(e.to_string()))?;
            serde_json::to_value(toml_val).map_err(|e| Error::Storage(e.to_string()))
        }
        other => Err(Error::InvalidPayload(format!(
            "unsupported import format '{}': expected json, yml, or toml",
            other
        ))),
    }
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
        None => {
            let format = source_format
                .as_deref()
                .ok_or_else(|| Error::InvalidPayload("missing sourceFormat".to_string()))?;
            let raw = content
                .as_deref()
                .ok_or_else(|| Error::InvalidPayload("missing content".to_string()))?;
            parse_import_content(format, raw, config::max_read_bytes(&app))?
        }
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
    fn resolve_root_path_stays_under_base_dir() {
        let base = PathBuf::from("/home/user/.config/com.example.app");

        let root = resolve_root_path(&base, Some("autostart"), None);
        assert_eq!(root, base.join("autostart"));
        assert!(root.starts_with(&base));

        // Replacing the identifier segment would escape the app sandbox.
        let escaped = base.parent().unwrap().join("autostart");
        assert_ne!(root, escaped);
        assert!(!escaped.starts_with(&base));
    }

    #[test]
    fn resolve_root_path_without_dir_name_uses_base() {
        let base = PathBuf::from("/home/user/.config/com.example.app");
        assert_eq!(resolve_root_path(&base, None, None), base);
    }

    #[test]
    fn resolve_root_path_appends_current_path_under_dir_name() {
        let base = PathBuf::from("/home/user/.config/com.example.app");
        let path = resolve_root_path(&base, Some("configs"), Some("v2/settings"));
        assert_eq!(path, base.join("configs").join("v2/settings"));
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

    #[test]
    fn batch_over_limit_is_rejected() {
        let entries: Vec<Value> = (0..129)
            .map(|i| {
                json!({
                    "id": format!("id{}", i),
                    "payload": {
                        "fileName": "a.json",
                        "baseDir": 8,
                        "provider": { "kind": "json" }
                    }
                })
            })
            .collect();
        let payload: BatchPayload = serde_json::from_value(json!({ "entries": entries })).unwrap();
        assert!(validate_batch_ids(&payload).is_err());
    }

    #[test]
    fn load_with_unlock_and_keyring_is_rejected() {
        let payload: ConfiguratePayload = serde_json::from_value(json!({
            "fileName": "app.json",
            "baseDir": 8,
            "provider": { "kind": "json" },
            "withUnlock": true,
            "keyringEntries": [{ "id": "tok", "dotpath": "token", "value": "" }],
            "keyringOptions": { "service": "svc", "account": "acc" }
        }))
        .unwrap();
        let normalized = payload.normalize().unwrap();
        let err = validate_load_keyring_policy(&normalized).unwrap_err();
        assert!(err.to_string().contains("unlock command"));
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

    #[test]
    fn keyring_read_rejects_non_empty_value() {
        let entries = vec![KeyringEntry {
            id: "api-key".to_string(),
            dotpath: "apiKey".to_string(),
            value: "secret".to_string(),
            is_optional: false,
        }];
        assert!(validate_keyring_entries(&entries, KeyringEntryUse::Read).is_err());
        assert!(validate_keyring_entries(&entries, KeyringEntryUse::Write).is_ok());
    }

    #[test]
    fn keyring_read_rejects_invalid_dotpath() {
        let entries = vec![KeyringEntry {
            id: "api-key".to_string(),
            dotpath: ".apiKey".to_string(),
            value: String::new(),
            is_optional: false,
        }];
        assert!(validate_keyring_entries(&entries, KeyringEntryUse::Read).is_err());
    }

    #[test]
    fn import_content_over_limit_is_rejected() {
        let max_read_bytes = config::DEFAULT_MAX_READ_BYTES;
        let content = "x".repeat(max_read_bytes + 1);
        let err = parse_import_content("json", &content, max_read_bytes).unwrap_err();
        assert!(err.to_string().contains("maximum size"));
    }
}
