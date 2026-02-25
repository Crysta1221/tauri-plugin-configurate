/// Storage backend trait and concrete implementations for JSON, YAML, Binary, and EncryptedBinary.
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rand::RngCore;
use serde_json::Value;

use crate::error::{Error, Result};
use crate::models::StorageFormat;

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
    let random_suffix: u32 = rand::thread_rng().next_u32();
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

    /// Returns the canonical file extension for this backend (without leading dot).
    fn extension(&self) -> &'static str;
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

    fn extension(&self) -> &'static str {
        "json"
    }
}

/// YAML storage backend using `serde_yaml`.
pub struct YamlBackend;

impl StorageBackend for YamlBackend {
    fn read(&self, path: &Path) -> Result<Value> {
        let bytes = std::fs::read(path)?;
        let yaml_val: serde_yaml::Value =
            serde_yaml::from_slice(&bytes).map_err(|e| Error::Storage(e.to_string()))?;
        // Direct conversion via serde avoids an intermediate JSON string round-trip.
        let value: Value =
            serde_json::to_value(yaml_val).map_err(|e| Error::Storage(e.to_string()))?;
        Ok(value)
    }

    fn write(&self, path: &Path, value: &Value) -> Result<()> {
        let yaml_val: serde_yaml::Value =
            serde_yaml::to_value(value).map_err(|e| Error::Storage(e.to_string()))?;
        let bytes =
            serde_yaml::to_string(&yaml_val).map_err(|e| Error::Storage(e.to_string()))?;
        write_file_safely(path, bytes.as_bytes())
    }

    fn extension(&self) -> &'static str {
        "yaml"
    }
}

/// Unencrypted binary storage backend using `bincode`.
/// The on-disk format is a bincode-encoded `Vec<u8>` of the JSON bytes.
///
/// NOTE: This format is not encrypted. Use `BinaryEncryptedBackend` when
/// confidentiality is required.
pub struct BinaryBackend;

impl StorageBackend for BinaryBackend {
    fn read(&self, path: &Path) -> Result<Value> {
        let bytes = std::fs::read(path)?;
        let json_bytes: Vec<u8> =
            bincode::deserialize(&bytes).map_err(|e| Error::Storage(e.to_string()))?;
        let value: Value =
            serde_json::from_slice(&json_bytes).map_err(|e| Error::Storage(e.to_string()))?;
        Ok(value)
    }

    fn write(&self, path: &Path, value: &Value) -> Result<()> {
        let json_bytes = serde_json::to_vec(value)?;
        let bytes =
            bincode::serialize(&json_bytes).map_err(|e| Error::Storage(e.to_string()))?;
        write_file_safely(path, &bytes)
    }

    fn extension(&self) -> &'static str {
        "bin"
    }
}

/// Encrypted binary storage backend using **XChaCha20-Poly1305**.
///
/// On-disk format: `[24-byte random nonce][ciphertext + 16-byte Poly1305 tag]`
///
/// The 32-byte cipher key is derived from the caller-supplied key string via
/// SHA-256, so any high-entropy string (e.g. a random key stored in the OS
/// keyring) is suitable.  The Poly1305 tag provides authenticated encryption:
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
        let plaintext = cipher
            .decrypt(nonce, ciphertext)
            .map_err(|_| Error::Storage("decryption failed: wrong key or corrupted data".to_string()))?;

        let value: Value =
            serde_json::from_slice(&plaintext).map_err(|e| Error::Storage(e.to_string()))?;
        Ok(value)
    }

    fn write(&self, path: &Path, value: &Value) -> Result<()> {
        use chacha20poly1305::aead::{Aead, KeyInit};
        use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};

        let json_bytes = serde_json::to_vec(value)?;

        let mut nonce_bytes = [0u8; 24];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
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

    fn extension(&self) -> &'static str {
        "binc"
    }
}

/// Returns a boxed `StorageBackend` for the given `StorageFormat`.
/// When `encryption_key` is `Some` and format is `Binary`, an authenticated
/// XChaCha20-Poly1305 backend is returned; otherwise the plain binary backend
/// is used for backward compatibility.
pub fn backend_for(
    format: &StorageFormat,
    encryption_key: Option<&str>,
) -> Box<dyn StorageBackend> {
    match format {
        StorageFormat::Json => Box::new(JsonBackend),
        StorageFormat::Yaml => Box::new(YamlBackend),
        StorageFormat::Binary => match encryption_key {
            Some(key) => Box::new(BinaryEncryptedBackend::new(key)),
            None => Box::new(BinaryBackend),
        },
    }
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
    fn encrypted_wrong_key_errors() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "test.binc");
        let writer = BinaryEncryptedBackend::new("correct-key");
        let reader = BinaryEncryptedBackend::new("wrong-key");
        let data = json!({"secret": "value"});
        writer.write(&path, &data).unwrap();
        assert!(reader.read(&path).is_err());
    }

    #[test]
    fn encrypted_extension_is_binc() {
        assert_eq!(BinaryEncryptedBackend::new("k").extension(), "binc");
    }

    #[test]
    fn encrypted_too_short_errors() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "short.binc");
        std::fs::write(&path, b"short").unwrap();
        let backend = BinaryEncryptedBackend::new("key");
        assert!(backend.read(&path).is_err());
    }

    #[test]
    fn write_creates_parent_dirs() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nested").join("path").join("test.json");
        let backend = JsonBackend;
        backend.write(&path, &json!({"x": 1})).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn write_is_idempotent() {
        let dir = TempDir::new().unwrap();
        let path = tmp_path(&dir, "idempotent.json");
        let backend = JsonBackend;
        backend.write(&path, &json!({"v": 1})).unwrap();
        backend.write(&path, &json!({"v": 2})).unwrap();
        let loaded = backend.read(&path).unwrap();
        assert_eq!(loaded["v"], 2);
    }
}
