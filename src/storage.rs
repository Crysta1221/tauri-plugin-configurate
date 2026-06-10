/// Storage backend trait and concrete implementations for JSON, YAML, Binary, and EncryptedBinary.
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rand::{Rng, RngExt};
use zeroize::Zeroizing;

use serde_json::Value;

use crate::error::{Error, Result};
use crate::models::NormalizedProvider;

/// Tracks paths for which backup files have been created so they can be
/// cleaned up when the application exits.
pub struct BackupRegistry(Mutex<HashSet<std::path::PathBuf>>);

impl BackupRegistry {
    pub fn new() -> Self {
        Self(Mutex::new(HashSet::new()))
    }

    fn register(&self, path: &Path) {
        if let Ok(mut set) = self.0.lock() {
            set.insert(path.to_path_buf());
        }
    }

    /// Deletes all `.bakN` files associated with every registered path.
    pub fn cleanup_all(&self) {
        let set = match self.0.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        for path in set.iter() {
            let base_ext = path
                .extension()
                .map(|e| e.to_string_lossy().into_owned())
                .unwrap_or_default();
            for n in 1..=BACKUP_COUNT {
                let ext = if base_ext.is_empty() {
                    format!("bak{}", n)
                } else {
                    format!("{}.bak{}", base_ext, n)
                };
                let _ = std::fs::remove_file(path.with_extension(&ext));
            }
        }
    }
}

/// Maximum number of rolling backup files to keep per config file.
const BACKUP_COUNT: u32 = 3;

/// Creates a rolling backup of the file at `path` (up to `BACKUP_COUNT` copies)
/// and registers the path in `registry` so backups can be cleaned up on exit.
///
/// Backups are named `<file>.<ext>.bak1`, `…bak2`, `…bak3`.
/// On each write the oldest slot is discarded and newer slots are shifted up,
/// so `.bak1` always holds the most recent previous version.
/// Silently ignores errors — backup failure must never block writes.
fn create_backup(path: &Path, registry: &BackupRegistry) {
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
    if std::fs::copy(path, bak_path(1)).is_ok() {
        registry.register(path);
    }
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
pub struct JsonBackend {
    backup: bool,
    registry: Arc<BackupRegistry>,
}

impl StorageBackend for JsonBackend {
    fn read(&self, path: &Path) -> Result<Value> {
        let bytes = std::fs::read(path)?;
        let value = serde_json::from_slice(&bytes)?;
        Ok(value)
    }

    fn write(&self, path: &Path, value: &Value) -> Result<()> {
        if self.backup {
            create_backup(path, &self.registry);
        }
        let bytes = serde_json::to_vec_pretty(value)?;
        write_file_safely(path, &bytes)
    }
}

/// YAML storage backend using `serde_yml`.
pub struct YamlBackend {
    backup: bool,
    registry: Arc<BackupRegistry>,
}

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
        if self.backup {
            create_backup(path, &self.registry);
        }
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
pub struct BinaryBackend {
    backup: bool,
    registry: Arc<BackupRegistry>,
}

impl StorageBackend for BinaryBackend {
    fn read(&self, path: &Path) -> Result<Value> {
        let bytes = std::fs::read(path)?;
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|e| Error::Storage(e.to_string()))?;
        Ok(value)
    }

    fn write(&self, path: &Path, value: &Value) -> Result<()> {
        if self.backup {
            create_backup(path, &self.registry);
        }
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
    backup: bool,
    registry: Arc<BackupRegistry>,
}

impl BinaryEncryptedBackend {
    /// Creates a new backend deriving the cipher key via `SHA-256(key_str)`.
    pub fn new(key_str: &str, backup: bool, registry: Arc<BackupRegistry>) -> Self {
        use sha2::{Digest, Sha256};
        let hash = Sha256::digest(key_str.as_bytes());
        let mut key = [0u8; 32];
        key.copy_from_slice(&hash);
        Self {
            key: Zeroizing::new(key),
            backup,
            registry,
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
        if self.backup {
            create_backup(path, &self.registry);
        }
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
    backup: bool,
    registry: Arc<BackupRegistry>,
}

impl BinaryArgon2Backend {
    pub fn new(password: &str, backup: bool, registry: Arc<BackupRegistry>) -> Self {
        Self {
            password: Zeroizing::new(password.to_string()),
            backup,
            registry,
        }
    }

    fn derive_key(&self, salt: &[u8]) -> std::result::Result<Zeroizing<[u8; 32]>, Error> {
        use argon2::Argon2;

        let argon2 = Argon2::default();
        let mut key = Zeroizing::new([0u8; 32]);
        argon2
            .hash_password_into(self.password.as_bytes(), salt, &mut *key)
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
        let cipher = XChaCha20Poly1305::new(Key::from_slice(&*key));
        drop(key);
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

        if self.backup {
            create_backup(path, &self.registry);
        }
        let json_bytes = serde_json::to_vec(value)?;

        let mut salt = [0u8; 16];
        rand::rng().fill_bytes(&mut salt);

        let key = self.derive_key(&salt)?;

        let mut nonce_bytes = [0u8; 24];
        rand::rng().fill_bytes(&mut nonce_bytes);
        let nonce = XNonce::from_slice(&nonce_bytes);

        let cipher = XChaCha20Poly1305::new(Key::from_slice(&*key));
        drop(key);
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
            } else if let Some(u) = n.as_u64() {
                // u64 values that fit in i64 range
                if u <= i64::MAX as u64 {
                    Ok(toml::Value::Integer(u as i64))
                } else {
                    Err(Error::Storage(format!(
                        "TOML cannot represent unsigned integer {} (exceeds i64::MAX)",
                        u
                    )))
                }
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
pub struct TomlBackend {
    backup: bool,
    registry: Arc<BackupRegistry>,
}

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
        if self.backup {
            create_backup(path, &self.registry);
        }
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
pub fn file_backend_for(
    provider: &NormalizedProvider,
    backup: bool,
    registry: Arc<BackupRegistry>,
) -> Result<Box<dyn StorageBackend>> {
    use crate::models::KeyDerivation;
    match provider {
        NormalizedProvider::Json => Ok(Box::new(JsonBackend { backup, registry })),
        NormalizedProvider::Yml => Ok(Box::new(YamlBackend { backup, registry })),
        NormalizedProvider::Toml => Ok(Box::new(TomlBackend { backup, registry })),
        NormalizedProvider::Binary {
            encryption_key,
            kdf,
        } => match encryption_key.as_deref() {
            Some(key) => match kdf {
                KeyDerivation::Argon2 => Ok(Box::new(BinaryArgon2Backend::new(key, backup, registry))),
                KeyDerivation::Sha256 => Ok(Box::new(BinaryEncryptedBackend::new(key, backup, registry))),
            },
            None => Ok(Box::new(BinaryBackend { backup, registry })),
        },
    }
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

    fn reg() -> Arc<BackupRegistry> {
        Arc::new(BackupRegistry::new())
    }

    #[test]
    fn json_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "test.json");
        let backend = JsonBackend { backup: false, registry: reg() };
        let data = json!({"key": "value", "num": 42});
        backend.write(&path, &data).unwrap();
        let loaded = backend.read(&path).unwrap();
        assert_eq!(loaded, data);
    }

    #[test]
    fn yaml_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "test.yaml");
        let backend = YamlBackend { backup: false, registry: reg() };
        let data = json!({"key": "value", "num": 42});
        backend.write(&path, &data).unwrap();
        let loaded = backend.read(&path).unwrap();
        assert_eq!(loaded, data);
    }

    #[test]
    fn toml_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "test.toml");
        let backend = TomlBackend { backup: false, registry: reg() };
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
        let backend = TomlBackend { backup: false, registry: reg() };
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
        let backend = BinaryBackend { backup: false, registry: reg() };
        let data = json!({"key": "value", "num": 42});
        backend.write(&path, &data).unwrap();
        let loaded = backend.read(&path).unwrap();
        assert_eq!(loaded, data);
    }

    #[test]
    fn encrypted_binary_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "test.binc");
        let backend = BinaryEncryptedBackend::new("my-test-key", false, reg());
        let data = json!({"secret": "value", "num": 42});
        backend.write(&path, &data).unwrap();
        let loaded = backend.read(&path).unwrap();
        assert_eq!(loaded, data);
    }

    #[test]
    fn argon2_encrypted_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "test.argon2.bin");
        let backend = BinaryArgon2Backend::new("my-strong-password", false, reg());
        let data = json!({"secret": "argon2-protected", "count": 99});
        backend.write(&path, &data).unwrap();
        let loaded = backend.read(&path).unwrap();
        assert_eq!(loaded, data);
    }

    #[test]
    fn argon2_wrong_key_fails() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "test.argon2-bad.bin");
        let backend = BinaryArgon2Backend::new("correct-password", false, reg());
        let data = json!({"secret": "value"});
        backend.write(&path, &data).unwrap();

        let wrong_backend = BinaryArgon2Backend::new("wrong-password", false, reg());
        assert!(wrong_backend.read(&path).is_err());
    }

    #[test]
    fn backup_is_created_on_write() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "test.json");
        let backend = JsonBackend { backup: true, registry: reg() };

        let data1 = json!({"version": 1});
        backend.write(&path, &data1).unwrap();

        let data2 = json!({"version": 2});
        backend.write(&path, &data2).unwrap();

        let backup_path = path.with_extension("json.bak1");
        assert!(backup_path.exists(), "backup file should exist");
        let backup_data: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&backup_path).unwrap()).unwrap();
        assert_eq!(backup_data, data1);
    }

    #[test]
    fn encrypted_wrong_key_fails() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "test-enc-bad.bin");
        let backend = BinaryEncryptedBackend::new("correct-key", false, reg());
        let data = json!({"secret": "value"});
        backend.write(&path, &data).unwrap();

        let wrong_backend = BinaryEncryptedBackend::new("wrong-key", false, reg());
        assert!(wrong_backend.read(&path).is_err());
    }

    #[test]
    fn backup_rotation_keeps_three_slots() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "test.json");
        let backend = JsonBackend { backup: true, registry: reg() };

        backend.write(&path, &json!({"v": 1})).unwrap();
        backend.write(&path, &json!({"v": 2})).unwrap();
        backend.write(&path, &json!({"v": 3})).unwrap();
        backend.write(&path, &json!({"v": 4})).unwrap();

        let bak1 = path.with_extension("json.bak1");
        let bak2 = path.with_extension("json.bak2");
        let bak3 = path.with_extension("json.bak3");
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
}
