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
        let mut map = serializer.serialize_map(Some(2))?;
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
        map.end()
    }
}
