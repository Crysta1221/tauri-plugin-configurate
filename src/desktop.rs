use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Configurate<R>> {
    Ok(Configurate(app.clone()))
}

/// Access to the configurate APIs on desktop platforms.
pub struct Configurate<R: Runtime>(AppHandle<R>);
