/// Storage backend trait and concrete implementations for JSON, YAML, Binary, and EncryptedBinary.
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rand::{Rng, RngExt};
use zeroize::Zeroizing;

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde_json::{Map, Number, Value};

use crate::dotpath;
use crate::error::{Error, Result};
use crate::models::{NormalizedProvider, SqliteColumn, SqliteValueType};

const SQLITE_JSON_BLOB_COLUMN: &str = "__config_json_blob";

/// Maximum number of rolling backup files to keep per config file.
const BACKUP_COUNT: u32 = 3;

/// Creates a rolling backup of the file at `path` (up to `BACKUP_COUNT` copies).
///
/// Backups are named `<file>.<ext>.bak1`, `…bak2`, `…bak3`.
/// On each write the oldest slot is discarded and newer slots are shifted up,
/// so `.bak1` always holds the most recent previous version.
/// Silently ignores errors — backup failure must never block writes.
fn create_backup(path: &Path) {
    if !path.is_file() {
        return;
    }

    let base_ext = path
        .extension()
        .map(|ext| ext.to_string_lossy().into_owned())
        .unwrap_or_default();

    let bak_path = |n: u32| -> std::path::PathBuf {
        let ext = if base_ext.is_empty() {
            format!("bak{}", n)
        } else {
            format!("{}.bak{}", base_ext, n)
        };
        path.with_extension(&ext)
    };

    // Rotate: remove oldest, shift bak(n-1) → bak(n).
    let _ = std::fs::remove_file(bak_path(BACKUP_COUNT));
    for n in (1..BACKUP_COUNT).rev() {
        let _ = std::fs::rename(bak_path(n), bak_path(n + 1));
    }
    let _ = std::fs::copy(path, bak_path(1));
}

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
    let random_suffix: u32 = rand::rng().random();
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
        create_backup(path);
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
        create_backup(path);
        // serde_json::Value implements Serialize, so serialize directly to YAML
        // without an intermediate serde_yml::Value allocation.
        let bytes = serde_yml::to_string(value).map_err(|e| Error::Storage(e.to_string()))?;
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
        create_backup(path);
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
    /// Derived 32-byte cipher key, zeroed on drop via `Zeroizing`.
    key: Zeroizing<[u8; 32]>,
}

impl BinaryEncryptedBackend {
    /// Creates a new backend deriving the cipher key via `SHA-256(key_str)`.
    pub fn new(key_str: &str) -> Self {
        use sha2::{Digest, Sha256};
        let hash = Sha256::digest(key_str.as_bytes());
        let mut key = [0u8; 32];
        key.copy_from_slice(&hash);
        Self {
            key: Zeroizing::new(key),
        }
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

        let cipher = XChaCha20Poly1305::new(Key::from_slice(&self.key[..]));
        let plaintext = cipher.decrypt(nonce, ciphertext).map_err(|_| {
            Error::Storage("decryption failed: wrong key or corrupted data".to_string())
        })?;

        let value: Value =
            serde_json::from_slice(&plaintext).map_err(|e| Error::Storage(e.to_string()))?;
        Ok(value)
    }

    fn write(&self, path: &Path, value: &Value) -> Result<()> {
        create_backup(path);
        use chacha20poly1305::aead::{Aead, KeyInit};
        use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};

        let json_bytes = serde_json::to_vec(value)?;

        let mut nonce_bytes = [0u8; 24];
        rand::rng().fill_bytes(&mut nonce_bytes);
        let nonce = XNonce::from_slice(&nonce_bytes);

        let cipher = XChaCha20Poly1305::new(Key::from_slice(&self.key[..]));
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

/// Encrypted binary storage backend using **XChaCha20-Poly1305** with
/// **Argon2id** key derivation.
///
/// On-disk format: `[16-byte salt][24-byte nonce][ciphertext + 16-byte tag]`
///
/// The 32-byte cipher key is derived via Argon2id(password, salt) with moderate
/// parameters (m=19456 KiB, t=2, p=1). A random 16-byte salt is generated on
/// every write so that identical passwords produce different ciphertext.
pub struct BinaryArgon2Backend {
    /// Raw password string, zeroed on drop via `Zeroizing`.
    password: Zeroizing<String>,
}

impl BinaryArgon2Backend {
    pub fn new(password: &str) -> Self {
        Self {
            password: Zeroizing::new(password.to_string()),
        }
    }

    fn derive_key(&self, salt: &[u8]) -> std::result::Result<[u8; 32], Error> {
        use argon2::Argon2;

        let argon2 = Argon2::default();
        let mut key = [0u8; 32];
        argon2
            .hash_password_into(self.password.as_bytes(), salt, &mut key)
            .map_err(|e| Error::Storage(format!("argon2 key derivation failed: {}", e)))?;
        Ok(key)
    }
}

impl StorageBackend for BinaryArgon2Backend {
    fn read(&self, path: &Path) -> Result<Value> {
        use chacha20poly1305::aead::{Aead, KeyInit};
        use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};

        let bytes = std::fs::read(path)?;
        // 16 salt + 24 nonce + at least 16 tag = 56 minimum
        if bytes.len() < 56 {
            return Err(Error::Storage(
                "argon2-encrypted file is too short".to_string(),
            ));
        }

        let salt = &bytes[..16];
        let nonce = XNonce::from_slice(&bytes[16..40]);
        let ciphertext = &bytes[40..];

        let key = self.derive_key(salt)?;
        let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
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

        create_backup(path);
        let json_bytes = serde_json::to_vec(value)?;

        let mut salt = [0u8; 16];
        rand::rng().fill_bytes(&mut salt);

        let key = self.derive_key(&salt)?;

        let mut nonce_bytes = [0u8; 24];
        rand::rng().fill_bytes(&mut nonce_bytes);
        let nonce = XNonce::from_slice(&nonce_bytes);

        let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
        let ciphertext = cipher
            .encrypt(nonce, json_bytes.as_slice())
            .map_err(|e| Error::Storage(format!("encryption failed: {}", e)))?;

        let mut output = Vec::with_capacity(16 + 24 + ciphertext.len());
        output.extend_from_slice(&salt);
        output.extend_from_slice(&nonce_bytes);
        output.extend_from_slice(&ciphertext);

        write_file_safely(path, &output)
    }
}

/// Converts a `serde_json::Value` into a `toml::Value`.
///
/// `null` object fields are silently omitted because TOML has no null type.
/// `null` values inside arrays are rejected to avoid silently changing array
/// length and element positions.
fn json_to_toml_value(value: &Value) -> Result<toml::Value> {
    match value {
        Value::Null => Err(Error::Storage(
            "TOML does not support null values in this position".to_string(),
        )),
        Value::Bool(b) => Ok(toml::Value::Boolean(*b)),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(toml::Value::Integer(i))
            } else {
                n.as_f64()
                    .filter(|f| f.is_finite())
                    .map(toml::Value::Float)
                    .ok_or_else(|| {
                        Error::Storage("TOML does not support this numeric value".to_string())
                    })
            }
        }
        Value::String(s) => Ok(toml::Value::String(s.clone())),
        Value::Array(arr) => {
            let mut items = Vec::with_capacity(arr.len());
            for value in arr {
                if value.is_null() {
                    return Err(Error::Storage(
                        "TOML does not support null values inside arrays".to_string(),
                    ));
                }
                items.push(json_to_toml_value(value)?);
            }
            Ok(toml::Value::Array(items))
        }
        Value::Object(map) => {
            let mut toml_map = toml::map::Map::new();
            for (k, v) in map {
                if v.is_null() {
                    continue;
                }
                toml_map.insert(k.clone(), json_to_toml_value(v)?);
            }
            Ok(toml::Value::Table(toml_map))
        }
    }
}

/// TOML storage backend.
///
/// Reads and writes configs in TOML format.  TOML has no null type so `null`
/// JSON values are silently omitted on write and will be absent on the next
/// read.  Use `optional()` schema fields to express nullable config values.
pub struct TomlBackend;

impl StorageBackend for TomlBackend {
    fn read(&self, path: &Path) -> Result<Value> {
        let bytes = std::fs::read(path)?;
        let text = String::from_utf8(bytes)
            .map_err(|e| Error::Storage(format!("TOML file is not valid UTF-8: {}", e)))?;
        let toml_val: toml::Value =
            toml::from_str(&text).map_err(|e| Error::Storage(e.to_string()))?;
        let json_val =
            serde_json::to_value(toml_val).map_err(|e| Error::Storage(e.to_string()))?;
        Ok(json_val)
    }

    fn write(&self, path: &Path, value: &Value) -> Result<()> {
        create_backup(path);
        let toml_val = json_to_toml_value(value)?;
        if !matches!(toml_val, toml::Value::Table(_)) {
            return Err(Error::Storage(
                "TOML top-level value must be a table (object)".to_string(),
            ));
        }
        let text =
            toml::to_string_pretty(&toml_val).map_err(|e| Error::Storage(e.to_string()))?;
        write_file_safely(path, text.as_bytes())
    }
}

/// Returns a boxed file backend for the given normalized provider.
pub fn file_backend_for(provider: &NormalizedProvider) -> Result<Box<dyn StorageBackend>> {
    use crate::models::KeyDerivation;
    match provider {
        NormalizedProvider::Json => Ok(Box::new(JsonBackend)),
        NormalizedProvider::Yml => Ok(Box::new(YamlBackend)),
        NormalizedProvider::Toml => Ok(Box::new(TomlBackend)),
        NormalizedProvider::Binary {
            encryption_key,
            kdf,
        } => match encryption_key.as_deref() {
            Some(key) => match kdf {
                KeyDerivation::Argon2 => Ok(Box::new(BinaryArgon2Backend::new(key))),
                KeyDerivation::Sha256 => Ok(Box::new(BinaryEncryptedBackend::new(key))),
            },
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

/// When `migrate_schema` is true, runs `PRAGMA table_info` and `ALTER TABLE ADD COLUMN`
/// to bring the table up to date with `schema_columns`. Pass `false` for read/delete
/// paths where DDL migration is unnecessary.
/// Validates all SQLite identifiers (table name and column names) upfront.
///
/// Returns the sanitized table name. Column names are validated as a side-effect;
/// callers can use `column.column_name` directly afterwards since `sanitize_ident`
/// is a validation-only function (it never transforms the input).
fn validate_sqlite_idents(table_name: &str, schema_columns: &[SqliteColumn]) -> Result<String> {
    let table = sanitize_ident(table_name, "tableName")?;
    for column in schema_columns {
        sanitize_ident(&column.column_name, "schema column name")?;
    }
    Ok(table)
}

/// When `migrate_schema` is true, runs `PRAGMA table_info` and `ALTER TABLE ADD COLUMN`
/// to bring the table up to date with `schema_columns`. Pass `false` for read/delete
/// paths where DDL migration is unnecessary.
///
/// Callers MUST call `validate_sqlite_idents` before invoking this function;
/// identifiers are used directly without re-validation.
fn ensure_sqlite_table(
    conn: &Connection,
    table_name: &str,
    schema_columns: &[SqliteColumn],
    migrate_schema: bool,
) -> Result<()> {
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
        column_defs.push(format!("\"{}\" {}", column.column_name, sql_type_for(&column.value_type)));
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

    if !migrate_schema {
        return Ok(());
    }

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
        if existing.contains(&column.column_name) {
            continue;
        }
        let alter = format!(
            "ALTER TABLE \"{}\" ADD COLUMN \"{}\" {}",
            table_name,
            column.column_name,
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

/// Opens a SQLite connection and applies one-time settings (WAL mode).
fn open_sqlite_conn(db_path: &Path) -> Result<Connection> {
    let conn = Connection::open(db_path).map_err(|e| Error::Storage(e.to_string()))?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
        .map_err(|e| Error::Storage(e.to_string()))?;
    Ok(conn)
}

/// Writes one config entry into SQLite.
pub fn write_sqlite(
    db_path: &Path,
    table_name: &str,
    config_key: &str,
    value: &Value,
    schema_columns: &[SqliteColumn],
) -> Result<()> {
    let table_name = validate_sqlite_idents(table_name, schema_columns)?;

    ensure_sqlite_parent_dir(db_path)?;
    let conn = open_sqlite_conn(db_path)?;

    ensure_sqlite_table(&conn, &table_name, schema_columns, true)?;

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
        col_names.push(column.column_name.clone());
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
    let table_name = validate_sqlite_idents(table_name, schema_columns)?;

    if !db_path.exists() {
        return Err(Error::Storage(format!(
            "sqlite config '{}' was not found (database does not exist)",
            config_key
        )));
    }

    let conn = open_sqlite_conn(db_path)?;
    ensure_sqlite_table(&conn, &table_name, schema_columns, false)?;

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
        .map(|c| format!("\"{}\"" , c.column_name))
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

/// Returns whether one config entry exists in SQLite.
pub fn exists_sqlite(
    db_path: &Path,
    table_name: &str,
    config_key: &str,
    schema_columns: &[SqliteColumn],
) -> Result<bool> {
    let table_name = validate_sqlite_idents(table_name, schema_columns)?;

    if !db_path.exists() {
        return Ok(false);
    }

    let conn = open_sqlite_conn(db_path)?;

    let table_exists: i64 = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [table_name.as_str()],
            |row| row.get(0),
        )
        .map_err(|e| Error::Storage(e.to_string()))?;
    if table_exists == 0 {
        return Ok(false);
    }

    let sql = format!(
        "SELECT EXISTS(SELECT 1 FROM \"{}\" WHERE \"config_key\" = ?1)",
        table_name
    );
    let exists: i64 = conn
        .query_row(&sql, [config_key], |row| row.get(0))
        .map_err(|e| Error::Storage(e.to_string()))?;

    Ok(exists != 0)
}

/// Deletes one config entry from SQLite by config key.
pub fn delete_sqlite(
    db_path: &Path,
    table_name: &str,
    config_key: &str,
    schema_columns: &[SqliteColumn],
) -> Result<()> {
    let table_name = validate_sqlite_idents(table_name, schema_columns)?;

    // If the database file does not exist, there is nothing to delete.
    if !db_path.exists() {
        return Ok(());
    }

    let conn = open_sqlite_conn(db_path)?;
    ensure_sqlite_table(&conn, &table_name, schema_columns, false)?;
    let sql = format!("DELETE FROM \"{}\" WHERE \"config_key\" = ?1", table_name);
    conn.execute(&sql, [config_key.to_string()])
        .map_err(|e| Error::Storage(e.to_string()))?;
    Ok(())
}

/// Lists all config keys in a SQLite table.
pub fn list_sqlite(
    db_path: &Path,
    table_name: &str,
) -> Result<Vec<String>> {
    if !db_path.exists() {
        return Ok(Vec::new());
    }

    let table = sanitize_ident(table_name, "tableName")?;
    let conn = open_sqlite_conn(db_path)?;

    // Check if the table exists.
    let table_exists: i64 = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [table.as_str()],
            |row| row.get(0),
        )
        .map_err(|e| Error::Storage(e.to_string()))?;
    if table_exists == 0 {
        return Ok(Vec::new());
    }

    let sql = format!(
        "SELECT \"config_key\" FROM \"{}\" ORDER BY \"config_key\"",
        table
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| Error::Storage(e.to_string()))?;
    let keys = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| Error::Storage(e.to_string()))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(keys)
}

/// Public wrapper for `json_to_toml_value`, used by the export command.
pub fn json_to_toml(value: &Value) -> Result<toml::Value> {
    json_to_toml_value(value)
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
    fn toml_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "test.toml");
        let backend = TomlBackend;
        let data = json!({
            "key": "value",
            "nested": {"enabled": true},
            "ports": [8080, 8081]
        });
        backend.write(&path, &data).unwrap();
        let loaded = backend.read(&path).unwrap();
        assert_eq!(loaded, data);
    }

    #[test]
    fn toml_array_null_is_rejected() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "test-null.toml");
        let backend = TomlBackend;
        let data = json!({"items": [1, null, 2]});

        let err = backend.write(&path, &data).unwrap_err();
        assert!(
            err.to_string()
                .contains("TOML does not support null values inside arrays")
        );
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

    #[test]
    fn sqlite_roundtrip_array_value_in_string_column() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "cfg-array.db");

        let columns = vec![SqliteColumn {
            column_name: "tags".to_string(),
            dotpath: "tags".to_string(),
            value_type: SqliteValueType::String,
            is_keyring: false,
        }];

        let value = json!({
            "tags": ["alpha", "beta", "gamma"],
        });

        write_sqlite(&path, "configurate_configs", "array.json", &value, &columns).unwrap();
        let loaded = read_sqlite(&path, "configurate_configs", "array.json", &columns).unwrap();
        assert_eq!(loaded["tags"], json!(["alpha", "beta", "gamma"]));
    }

    #[test]
    fn sqlite_exists_checks_presence_without_side_effects() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "cfg-exists.db");
        let columns: Vec<SqliteColumn> = Vec::new();

        assert!(!exists_sqlite(&path, "configurate_configs", "app.json", &columns).unwrap());

        let value = json!({ "theme": "dark" });
        write_sqlite(&path, "configurate_configs", "app.json", &value, &columns).unwrap();

        assert!(exists_sqlite(&path, "configurate_configs", "app.json", &columns).unwrap());
        assert!(!exists_sqlite(&path, "configurate_configs", "missing.json", &columns).unwrap());
    }

    #[test]
    fn argon2_encrypted_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "test.argon2.bin");
        let backend = BinaryArgon2Backend::new("my-strong-password");
        let data = json!({"secret": "argon2-protected", "count": 99});
        backend.write(&path, &data).unwrap();
        let loaded = backend.read(&path).unwrap();
        assert_eq!(loaded, data);
    }

    #[test]
    fn argon2_wrong_key_fails() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "test.argon2-bad.bin");
        let backend = BinaryArgon2Backend::new("correct-password");
        let data = json!({"secret": "value"});
        backend.write(&path, &data).unwrap();

        let wrong_backend = BinaryArgon2Backend::new("wrong-password");
        assert!(wrong_backend.read(&path).is_err());
    }

    #[test]
    fn backup_is_created_on_write() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "test.json");
        let backend = JsonBackend;

        let data1 = json!({"version": 1});
        backend.write(&path, &data1).unwrap();

        let data2 = json!({"version": 2});
        backend.write(&path, &data2).unwrap();

        // Backups now use the rotating scheme: .bak1 is the most recent backup.
        let backup_path = path.with_extension("json.bak1");
        assert!(backup_path.exists(), "backup file should exist");
        let backup_data: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&backup_path).unwrap()).unwrap();
        assert_eq!(backup_data, data1);
    }

    #[test]
    fn sqlite_delete_removes_entry() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "cfg-del.db");
        let columns: Vec<SqliteColumn> = Vec::new();

        let value = json!({ "theme": "dark" });
        write_sqlite(&path, "configurate_configs", "app.json", &value, &columns).unwrap();
        assert!(exists_sqlite(&path, "configurate_configs", "app.json", &columns).unwrap());

        delete_sqlite(&path, "configurate_configs", "app.json", &columns).unwrap();
        assert!(!exists_sqlite(&path, "configurate_configs", "app.json", &columns).unwrap());
    }

    #[test]
    fn sqlite_delete_nonexistent_is_ok() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "cfg-del-none.db");
        let columns: Vec<SqliteColumn> = Vec::new();

        // Deleting from a non-existent database should succeed.
        assert!(delete_sqlite(&path, "configurate_configs", "missing.json", &columns).is_ok());
    }

    #[test]
    fn encrypted_wrong_key_fails() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "test-enc-bad.bin");
        let backend = BinaryEncryptedBackend::new("correct-key");
        let data = json!({"secret": "value"});
        backend.write(&path, &data).unwrap();

        let wrong_backend = BinaryEncryptedBackend::new("wrong-key");
        assert!(wrong_backend.read(&path).is_err());
    }

    #[test]
    fn sqlite_json_blob_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "cfg-blob.db");
        let columns: Vec<SqliteColumn> = Vec::new();

        let value = json!({
            "nested": {"deep": {"value": true}},
            "array": [1, 2, 3],
            "null_field": null,
        });
        write_sqlite(&path, "configurate_configs", "blob.json", &value, &columns).unwrap();
        let loaded = read_sqlite(&path, "configurate_configs", "blob.json", &columns).unwrap();
        assert_eq!(loaded, value);
    }

    #[test]
    fn backup_rotation_keeps_three_slots() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "test.json");
        let backend = JsonBackend;

        // Write v1, v2, v3, v4 — only the last 3 should remain as backups.
        backend.write(&path, &json!({"v": 1})).unwrap();
        backend.write(&path, &json!({"v": 2})).unwrap();
        backend.write(&path, &json!({"v": 3})).unwrap();
        backend.write(&path, &json!({"v": 4})).unwrap();

        // bak1 = most recent backup (v3), bak2 = v2, bak3 = v1
        let bak1 = path.with_extension("json.bak1");
        let bak2 = path.with_extension("json.bak2");
        let bak3 = path.with_extension("json.bak3");
        // bak4 should not exist
        let bak4 = path.with_extension("json.bak4");

        assert!(bak1.exists(), "bak1 should exist");
        assert!(bak2.exists(), "bak2 should exist");
        assert!(bak3.exists(), "bak3 should exist");
        assert!(!bak4.exists(), "bak4 should not exist");

        let b1: Value = serde_json::from_slice(&std::fs::read(&bak1).unwrap()).unwrap();
        let b2: Value = serde_json::from_slice(&std::fs::read(&bak2).unwrap()).unwrap();
        assert_eq!(b1["v"], 3);
        assert_eq!(b2["v"], 2);
    }

    #[test]
    fn sqlite_schema_migration_adds_column() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "cfg-migrate.db");

        let columns_v1 = vec![SqliteColumn {
            column_name: "theme".to_string(),
            dotpath: "theme".to_string(),
            value_type: SqliteValueType::String,
            is_keyring: false,
        }];

        let value = json!({"theme": "dark"});
        write_sqlite(&path, "test_table", "app", &value, &columns_v1).unwrap();

        // Now add a second column (schema migration).
        let columns_v2 = vec![
            SqliteColumn {
                column_name: "theme".to_string(),
                dotpath: "theme".to_string(),
                value_type: SqliteValueType::String,
                is_keyring: false,
            },
            SqliteColumn {
                column_name: "font_size".to_string(),
                dotpath: "font_size".to_string(),
                value_type: SqliteValueType::Number,
                is_keyring: false,
            },
        ];

        let value2 = json!({"theme": "light", "font_size": 14});
        write_sqlite(&path, "test_table", "app", &value2, &columns_v2).unwrap();
        let loaded = read_sqlite(&path, "test_table", "app", &columns_v2).unwrap();
        assert_eq!(loaded["theme"], "light");
        assert_eq!(loaded["font_size"], 14.0);
    }
}
