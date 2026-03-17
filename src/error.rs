use serde::{ser::Serializer, Serialize};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),

    /// Errors originating from storage serialization/deserialization.
    #[error("storage error: {0}")]
    Storage(String),

    /// Errors originating from the OS keyring.
    #[error("keyring error: {0}")]
    Keyring(String),

    /// Errors when resolving a dotpath inside a JSON value.
    #[error("dotpath error: {0}")]
    Dotpath(String),

    /// Invalid payload sent from the frontend (wrong field combination, bad value, etc.).
    #[error("invalid payload: {0}")]
    InvalidPayload(String),

    /// Errors from serde_json.
    #[error(transparent)]
    Json(#[from] serde_json::Error),

    #[cfg(mobile)]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
}

impl From<keyring::Error> for Error {
    fn from(e: keyring::Error) -> Self {
        Error::Keyring(e.to_string())
    }
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        use serde::ser::SerializeMap;

        // For IO errors, include a stable `io_kind` sub-field so the frontend
        // can distinguish "not found" from "permission denied" without parsing
        // the human-readable message string.
        let io_kind: Option<&'static str> = if let Error::Io(e) = self {
            Some(match e.kind() {
                std::io::ErrorKind::NotFound => "not_found",
                std::io::ErrorKind::PermissionDenied => "permission_denied",
                std::io::ErrorKind::AlreadyExists => "already_exists",
                std::io::ErrorKind::WouldBlock => "would_block",
                std::io::ErrorKind::InvalidInput => "invalid_input",
                std::io::ErrorKind::TimedOut => "timed_out",
                std::io::ErrorKind::Interrupted => "interrupted",
                std::io::ErrorKind::OutOfMemory => "out_of_memory",
                _ => "other",
            })
        } else {
            None
        };

        let field_count = if io_kind.is_some() { 3 } else { 2 };
        let mut map = serializer.serialize_map(Some(field_count))?;
        let kind = match self {
            Error::Io(_) => "io",
            Error::Storage(_) => "storage",
            Error::Keyring(_) => "keyring",
            Error::Dotpath(_) => "dotpath",
            Error::InvalidPayload(_) => "invalid_payload",
            Error::Json(_) => "json",
            #[cfg(mobile)]
            Error::PluginInvoke(_) => "plugin_invoke",
        };
        map.serialize_entry("kind", kind)?;
        map.serialize_entry("message", &self.to_string())?;
        if let Some(ik) = io_kind {
            map.serialize_entry("io_kind", ik)?;
        }
        map.end()
    }
}
