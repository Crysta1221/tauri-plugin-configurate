/// Storage backend trait and concrete implementations for JSON, YAML, Binary, and EncryptedBinary.
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rand::RngCore;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde_json::{Map, Number, Value};

use crate::dotpath;
use crate::error::{Error, Result};
use crate::models::{NormalizedProvider, SqliteColumn, SqliteValueType};

const SQLITE_JSON_BLOB_COLUMN: &str = "__config_json_blob";

/// Writes bytes to `path` using a temporary sibling file and rename.
///
/// This minimizes the chance of leaving a partially-written destination file
/// when a write is interrupted.
fn write_file_safely(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let file_name = path
        .file_name()
        .ok_or_else(|| Error::Storage(format!("invalid file path: {}", path.display())))?
        .to_string_lossy();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| Error::Storage(format!("system time error: {}", e)))?
        .as_nanos();
    // Include a random 32-bit suffix to avoid collisions on systems where the
    // clock resolution is coarser than nanoseconds or when multiple threads
    // write the same file concurrently.
    let random_suffix: u32 = rand::rng().next_u32();
    let tmp_name = format!(".{}.{}-{}.tmp", file_name, nanos, random_suffix);
    let tmp_path = path.with_file_name(tmp_name);

    {
        let mut tmp = std::fs::File::create(&tmp_path)?;
        tmp.write_all(bytes)?;
        tmp.sync_all()?;
    }

    if let Err(rename_err) = std::fs::rename(&tmp_path, path) {
        // On Windows, `rename` fails when the destination already exists.
        // Attempt to delete the destination and retry once.
        // If the retry also fails, report the error but do NOT delete the
        // temporary file — it holds the newly-written data and leaving it
        // around is safer than silently discarding it.
        if path.exists() {
            std::fs::remove_file(path)?;
            // On second failure, return the error; tmp file is preserved.
            std::fs::rename(&tmp_path, path)?;
        } else {
            // Destination doesn't exist; rename failed for another reason.
            // Preserve the tmp file (don't delete) and surface the error.
            return Err(rename_err.into());
        }
    }

    Ok(())
}

/// Abstraction over different file storage formats.
pub trait StorageBackend {
    /// Reads the file at `path` and deserializes it into a `serde_json::Value`.
    fn read(&self, path: &Path) -> Result<Value>;

    /// Serializes `value` and writes it to `path`, creating the file if necessary.
    fn write(&self, path: &Path, value: &Value) -> Result<()>;
}

/// JSON storage backend using `serde_json`.
pub struct JsonBackend;

impl StorageBackend for JsonBackend {
    fn read(&self, path: &Path) -> Result<Value> {
        let bytes = std::fs::read(path)?;
        let value = serde_json::from_slice(&bytes)?;
        Ok(value)
    }

    fn write(&self, path: &Path, value: &Value) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(value)?;
        write_file_safely(path, &bytes)
    }
}

/// YAML storage backend using `serde_yml`.
pub struct YamlBackend;

impl StorageBackend for YamlBackend {
    fn read(&self, path: &Path) -> Result<Value> {
        let bytes = std::fs::read(path)?;
        let yaml_val: serde_yml::Value =
            serde_yml::from_slice(&bytes).map_err(|e| Error::Storage(e.to_string()))?;
        // Direct conversion via serde avoids an intermediate JSON string round-trip.
        let value: Value =
            serde_json::to_value(yaml_val).map_err(|e| Error::Storage(e.to_string()))?;
        Ok(value)
    }

    fn write(&self, path: &Path, value: &Value) -> Result<()> {
        let yaml_val: serde_yml::Value =
            serde_yml::to_value(value).map_err(|e| Error::Storage(e.to_string()))?;
        let bytes = serde_yml::to_string(&yaml_val).map_err(|e| Error::Storage(e.to_string()))?;
        write_file_safely(path, bytes.as_bytes())
    }
}

/// Unencrypted binary storage backend.
///
/// Stores a compact (non-pretty) JSON representation of the value.
/// Use `BinaryEncryptedBackend` when confidentiality is required.
///
/// NOTE: This format differs from the bincode-wrapped format used before v0.2.3.
/// Existing unencrypted binary files written by earlier versions must be
/// re-created after upgrading.
pub struct BinaryBackend;

impl StorageBackend for BinaryBackend {
    fn read(&self, path: &Path) -> Result<Value> {
        let bytes = std::fs::read(path)?;
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|e| Error::Storage(e.to_string()))?;
        Ok(value)
    }

    fn write(&self, path: &Path, value: &Value) -> Result<()> {
        let bytes = serde_json::to_vec(value)?;
        write_file_safely(path, &bytes)
    }
}

/// Encrypted binary storage backend using **XChaCha20-Poly1305**.
///
/// On-disk format: `[24-byte random nonce][ciphertext + 16-byte Poly1305 tag]`
///
/// The 32-byte cipher key is derived from the caller-supplied key string via
/// SHA-256, so any high-entropy string (e.g. a random key stored in the OS
/// keyring) is suitable. The Poly1305 tag provides authenticated encryption:
/// any tampering with the ciphertext is detected at read time.
pub struct BinaryEncryptedBackend {
    key: [u8; 32],
}

impl BinaryEncryptedBackend {
    /// Creates a new backend deriving the cipher key via `SHA-256(key_str)`.
    pub fn new(key_str: &str) -> Self {
        use sha2::{Digest, Sha256};
        let hash = Sha256::digest(key_str.as_bytes());
        let mut key = [0u8; 32];
        key.copy_from_slice(&hash);
        Self { key }
    }
}

impl StorageBackend for BinaryEncryptedBackend {
    fn read(&self, path: &Path) -> Result<Value> {
        use chacha20poly1305::aead::{Aead, KeyInit};
        use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};

        let bytes = std::fs::read(path)?;
        if bytes.len() < 24 {
            return Err(Error::Storage(
                "encrypted file is too short (missing nonce)".to_string(),
            ));
        }

        let nonce = XNonce::from_slice(&bytes[..24]);
        let ciphertext = &bytes[24..];

        let cipher = XChaCha20Poly1305::new(Key::from_slice(&self.key));
        let plaintext = cipher.decrypt(nonce, ciphertext).map_err(|_| {
            Error::Storage("decryption failed: wrong key or corrupted data".to_string())
        })?;

        let value: Value =
            serde_json::from_slice(&plaintext).map_err(|e| Error::Storage(e.to_string()))?;
        Ok(value)
    }

    fn write(&self, path: &Path, value: &Value) -> Result<()> {
        use chacha20poly1305::aead::{Aead, KeyInit};
        use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};

        let json_bytes = serde_json::to_vec(value)?;

        let mut nonce_bytes = [0u8; 24];
        rand::rng().fill_bytes(&mut nonce_bytes);
        let nonce = XNonce::from_slice(&nonce_bytes);

        let cipher = XChaCha20Poly1305::new(Key::from_slice(&self.key));
        let ciphertext = cipher
            .encrypt(nonce, json_bytes.as_slice())
            .map_err(|e| Error::Storage(format!("encryption failed: {}", e)))?;

        // Prepend the nonce so it is available for decryption.
        let mut output = Vec::with_capacity(24 + ciphertext.len());
        output.extend_from_slice(&nonce_bytes);
        output.extend_from_slice(&ciphertext);

        write_file_safely(path, &output)
    }
}

/// Returns a boxed file backend for the given normalized provider.
///
/// Returns an error if called with `NormalizedProvider::Sqlite`, which must be
/// handled by the dedicated SQLite read/write APIs.
pub fn file_backend_for(provider: &NormalizedProvider) -> Result<Box<dyn StorageBackend>> {
    match provider {
        NormalizedProvider::Json => Ok(Box::new(JsonBackend)),
        NormalizedProvider::Yml => Ok(Box::new(YamlBackend)),
        NormalizedProvider::Binary { encryption_key } => match encryption_key.as_deref() {
            Some(key) => Ok(Box::new(BinaryEncryptedBackend::new(key))),
            None => Ok(Box::new(BinaryBackend)),
        },
        NormalizedProvider::Sqlite { .. } => Err(Error::InvalidPayload(
            "sqlite provider must be handled by sqlite read/write APIs".to_string(),
        )),
    }
}

fn sanitize_ident(name: &str, what: &str) -> Result<String> {
    if name.is_empty() {
        return Err(Error::InvalidPayload(format!("{} must not be empty", what)));
    }
    if !name
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    {
        return Err(Error::InvalidPayload(format!(
            "invalid {} '{}': only [A-Za-z0-9_] is allowed",
            what, name
        )));
    }
    Ok(name.to_string())
}

fn sql_type_for(value_type: &SqliteValueType) -> &'static str {
    match value_type {
        SqliteValueType::String => "TEXT",
        SqliteValueType::Number => "REAL",
        SqliteValueType::Boolean => "INTEGER",
    }
}

fn ensure_sqlite_parent_dir(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    Ok(())
}

fn ensure_sqlite_table(
    conn: &Connection,
    table_name: &str,
    schema_columns: &[SqliteColumn],
) -> Result<()> {
    let table_name = sanitize_ident(table_name, "tableName")?;

    if schema_columns.is_empty() {
        let sql = format!(
            "CREATE TABLE IF NOT EXISTS \"{}\" (
                \"config_key\" TEXT PRIMARY KEY,
                \"{}\" TEXT
            )",
            table_name, SQLITE_JSON_BLOB_COLUMN
        );
        conn.execute(&sql, [])
            .map_err(|e| Error::Storage(e.to_string()))?;
        return Ok(());
    }

    let mut column_defs: Vec<String> = Vec::with_capacity(schema_columns.len());
    for column in schema_columns {
        let name = sanitize_ident(&column.column_name, "schema column name")?;
        column_defs.push(format!("\"{}\" {}", name, sql_type_for(&column.value_type)));
    }

    let sql = format!(
        "CREATE TABLE IF NOT EXISTS \"{}\" (
            \"config_key\" TEXT PRIMARY KEY,
            {}
        )",
        table_name,
        column_defs.join(",")
    );

    conn.execute(&sql, [])
        .map_err(|e| Error::Storage(e.to_string()))?;

    let pragma_sql = format!("PRAGMA table_info(\"{}\")", table_name);
    let mut stmt = conn
        .prepare(&pragma_sql)
        .map_err(|e| Error::Storage(e.to_string()))?;

    let existing_cols_iter = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| Error::Storage(e.to_string()))?;

    let mut existing = std::collections::BTreeSet::new();
    for col in existing_cols_iter {
        existing.insert(col.map_err(|e| Error::Storage(e.to_string()))?);
    }

    for column in schema_columns {
        let name = sanitize_ident(&column.column_name, "schema column name")?;
        if existing.contains(&name) {
            continue;
        }
        let alter = format!(
            "ALTER TABLE \"{}\" ADD COLUMN \"{}\" {}",
            table_name,
            name,
            sql_type_for(&column.value_type)
        );
        conn.execute(&alter, [])
            .map_err(|e| Error::Storage(e.to_string()))?;
    }

    Ok(())
}

fn json_to_sql_value(
    value: Option<&Value>,
    value_type: &SqliteValueType,
    is_keyring: bool,
) -> SqlValue {
    if is_keyring {
        return SqlValue::Null;
    }

    match value {
        None | Some(Value::Null) => SqlValue::Null,
        Some(Value::Bool(b)) => SqlValue::Integer(if *b { 1 } else { 0 }),
        Some(Value::Number(num)) => SqlValue::Real(num.as_f64().unwrap_or(0.0)),
        Some(Value::String(s)) => match value_type {
            SqliteValueType::Number => s
                .parse::<f64>()
                .map(SqlValue::Real)
                .unwrap_or_else(|_| SqlValue::Text(s.clone())),
            SqliteValueType::Boolean => match s.as_str() {
                "true" => SqlValue::Integer(1),
                "false" => SqlValue::Integer(0),
                _ => SqlValue::Text(s.clone()),
            },
            SqliteValueType::String => SqlValue::Text(s.clone()),
        },
        Some(Value::Array(arr)) => SqlValue::Text(serde_json::to_string(arr).unwrap_or_default()),
        Some(Value::Object(obj)) => SqlValue::Text(serde_json::to_string(obj).unwrap_or_default()),
    }
}

fn sql_to_json_value(
    value_ref: ValueRef<'_>,
    value_type: &SqliteValueType,
    is_keyring: bool,
) -> Value {
    if is_keyring {
        return Value::Null;
    }

    match value_ref {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(v) => match value_type {
            SqliteValueType::Boolean => Value::Bool(v != 0),
            SqliteValueType::Number => {
                Value::Number(Number::from_f64(v as f64).unwrap_or_else(|| Number::from(0)))
            }
            SqliteValueType::String => Value::String(v.to_string()),
        },
        ValueRef::Real(v) => match value_type {
            SqliteValueType::Boolean => Value::Bool(v != 0.0),
            SqliteValueType::Number => {
                Value::Number(Number::from_f64(v).unwrap_or_else(|| Number::from(0)))
            }
            SqliteValueType::String => Value::String(v.to_string()),
        },
        ValueRef::Text(bytes) => {
            let text = String::from_utf8_lossy(bytes).to_string();
            let trimmed = text.trim_start();
            if trimmed.starts_with('{') || trimmed.starts_with('[') {
                if let Ok(json_val) = serde_json::from_str::<Value>(&text) {
                    return json_val;
                }
            }
            Value::String(text)
        }
        ValueRef::Blob(bytes) => Value::String(String::from_utf8_lossy(bytes).to_string()),
    }
}

/// Writes one config entry into SQLite.
pub fn write_sqlite(
    db_path: &Path,
    table_name: &str,
    config_key: &str,
    value: &Value,
    schema_columns: &[SqliteColumn],
) -> Result<()> {
    ensure_sqlite_parent_dir(db_path)?;
    let conn = Connection::open(db_path).map_err(|e| Error::Storage(e.to_string()))?;

    ensure_sqlite_table(&conn, table_name, schema_columns)?;

    let table_name = sanitize_ident(table_name, "tableName")?;

    if schema_columns.is_empty() {
        let json_text = serde_json::to_string(value).map_err(|e| Error::Storage(e.to_string()))?;
        let sql = format!(
            "INSERT INTO \"{}\" (\"config_key\", \"{}\") VALUES (?, ?)
            ON CONFLICT(\"config_key\") DO UPDATE SET \"{}\"=excluded.\"{}\"",
            table_name, SQLITE_JSON_BLOB_COLUMN, SQLITE_JSON_BLOB_COLUMN, SQLITE_JSON_BLOB_COLUMN
        );
        conn.execute(&sql, [config_key, json_text.as_str()])
            .map_err(|e| Error::Storage(e.to_string()))?;
        return Ok(());
    }

    let mut col_names = Vec::with_capacity(schema_columns.len());
    let mut bind_values: Vec<SqlValue> = Vec::with_capacity(schema_columns.len() + 1);
    bind_values.push(SqlValue::Text(config_key.to_string()));

    for column in schema_columns {
        let column_name = sanitize_ident(&column.column_name, "schema column name")?;
        col_names.push(column_name);
        let dot_val = dotpath::get(value, &column.dotpath);
        bind_values.push(json_to_sql_value(
            dot_val,
            &column.value_type,
            column.is_keyring,
        ));
    }

    let insert_columns = std::iter::once("\"config_key\"".to_string())
        .chain(col_names.iter().map(|n| format!("\"{}\"", n)))
        .collect::<Vec<_>>()
        .join(",");

    let placeholders = (0..(col_names.len() + 1))
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");

    let update_clause = col_names
        .iter()
        .map(|n| format!("\"{}\"=excluded.\"{}\"", n, n))
        .collect::<Vec<_>>()
        .join(",");

    let sql = format!(
        "INSERT INTO \"{}\" ({}) VALUES ({})
        ON CONFLICT(\"config_key\") DO UPDATE SET {}",
        table_name, insert_columns, placeholders, update_clause
    );

    conn.execute(&sql, params_from_iter(bind_values.iter()))
        .map_err(|e| Error::Storage(e.to_string()))?;

    Ok(())
}

/// Reads one config entry from SQLite.
pub fn read_sqlite(
    db_path: &Path,
    table_name: &str,
    config_key: &str,
    schema_columns: &[SqliteColumn],
) -> Result<Value> {
    let conn = Connection::open(db_path).map_err(|e| Error::Storage(e.to_string()))?;
    ensure_sqlite_table(&conn, table_name, schema_columns)?;

    let table_name = sanitize_ident(table_name, "tableName")?;

    if schema_columns.is_empty() {
        let sql = format!(
            "SELECT \"{}\" FROM \"{}\" WHERE \"config_key\" = ?1",
            SQLITE_JSON_BLOB_COLUMN, table_name
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| Error::Storage(e.to_string()))?;
        let mut rows = stmt
            .query([config_key])
            .map_err(|e| Error::Storage(e.to_string()))?;
        if let Some(row) = rows.next().map_err(|e| Error::Storage(e.to_string()))? {
            let json_text: Option<String> =
                row.get(0).map_err(|e| Error::Storage(e.to_string()))?;
            let json_text = json_text.ok_or_else(|| {
                Error::Storage(format!(
                    "sqlite config '{}' has no stored JSON value",
                    config_key
                ))
            })?;
            return serde_json::from_str::<Value>(&json_text)
                .map_err(|e| Error::Storage(e.to_string()));
        }

        return Err(Error::Storage(format!(
            "sqlite config '{}' was not found",
            config_key
        )));
    }

    let select_columns = schema_columns
        .iter()
        .map(|c| sanitize_ident(&c.column_name, "schema column name"))
        .collect::<Result<Vec<_>>>()?
        .iter()
        .map(|n| format!("\"{}\"", n))
        .collect::<Vec<_>>()
        .join(",");

    let sql = format!(
        "SELECT {} FROM \"{}\" WHERE \"config_key\" = ?1",
        select_columns, table_name
    );

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| Error::Storage(e.to_string()))?;
    let mut rows = stmt
        .query([config_key])
        .map_err(|e| Error::Storage(e.to_string()))?;

    let Some(row) = rows.next().map_err(|e| Error::Storage(e.to_string()))? else {
        return Err(Error::Storage(format!(
            "sqlite config '{}' was not found",
            config_key
        )));
    };

    let mut out = Value::Object(Map::new());
    for (idx, column) in schema_columns.iter().enumerate() {
        let value_ref = row
            .get_ref(idx)
            .map_err(|e| Error::Storage(e.to_string()))?;
        let json_val = sql_to_json_value(value_ref, &column.value_type, column.is_keyring);
        dotpath::set(&mut out, &column.dotpath, json_val)
            .map_err(|e| Error::Storage(e.to_string()))?;
    }

    Ok(out)
}

/// Deletes one config entry from SQLite by config key.
pub fn delete_sqlite(
    db_path: &Path,
    table_name: &str,
    config_key: &str,
    schema_columns: &[SqliteColumn],
) -> Result<()> {
    let conn = Connection::open(db_path).map_err(|e| Error::Storage(e.to_string()))?;
    ensure_sqlite_table(&conn, table_name, schema_columns)?;
    let table_name = sanitize_ident(table_name, "tableName")?;
    let sql = format!("DELETE FROM \"{}\" WHERE \"config_key\" = ?1", table_name);
    conn.execute(&sql, [config_key])
        .map_err(|e| Error::Storage(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn tmp_path(dir: &TempDir, name: &str) -> std::path::PathBuf {
        dir.path().join(name)
    }

    #[test]
    fn json_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "test.json");
        let backend = JsonBackend;
        let data = json!({"key": "value", "num": 42});
        backend.write(&path, &data).unwrap();
        let loaded = backend.read(&path).unwrap();
        assert_eq!(loaded, data);
    }

    #[test]
    fn yaml_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "test.yaml");
        let backend = YamlBackend;
        let data = json!({"key": "value", "num": 42});
        backend.write(&path, &data).unwrap();
        let loaded = backend.read(&path).unwrap();
        assert_eq!(loaded, data);
    }

    #[test]
    fn binary_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "test.bin");
        let backend = BinaryBackend;
        let data = json!({"key": "value", "num": 42});
        backend.write(&path, &data).unwrap();
        let loaded = backend.read(&path).unwrap();
        assert_eq!(loaded, data);
    }

    #[test]
    fn encrypted_binary_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "test.binc");
        let backend = BinaryEncryptedBackend::new("my-test-key");
        let data = json!({"secret": "value", "num": 42});
        backend.write(&path, &data).unwrap();
        let loaded = backend.read(&path).unwrap();
        assert_eq!(loaded, data);
    }

    #[test]
    fn sqlite_roundtrip_with_schema_columns() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "cfg.db");

        let columns = vec![
            SqliteColumn {
                column_name: "theme".to_string(),
                dotpath: "theme".to_string(),
                value_type: SqliteValueType::String,
                is_keyring: false,
            },
            SqliteColumn {
                column_name: "enabled".to_string(),
                dotpath: "enabled".to_string(),
                value_type: SqliteValueType::Boolean,
                is_keyring: false,
            },
            SqliteColumn {
                column_name: "secret".to_string(),
                dotpath: "secret".to_string(),
                value_type: SqliteValueType::String,
                is_keyring: true,
            },
        ];

        let value = json!({
            "theme": "dark",
            "enabled": true,
            "secret": null,
        });

        write_sqlite(&path, "configurate_configs", "app.json", &value, &columns).unwrap();
        let loaded = read_sqlite(&path, "configurate_configs", "app.json", &columns).unwrap();
        assert_eq!(loaded["theme"], "dark");
        assert_eq!(loaded["enabled"], true);
        assert_eq!(loaded["secret"], Value::Null);
    }
}
