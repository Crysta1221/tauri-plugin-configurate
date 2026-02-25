use serde::de::DeserializeOwned;
use tauri::{
  plugin::{PluginApi, PluginHandle},
  AppHandle, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_configurate);

/// Initializes the plugin on mobile platforms.
pub fn init<R: Runtime, C: DeserializeOwned>(
  _app: &AppHandle<R>,
  api: PluginApi<R, C>,
) -> crate::Result<Configurate<R>> {
  #[cfg(target_os = "android")]
  let handle = api.register_android_plugin("", "ConfiguratePlugin")?;
  #[cfg(target_os = "ios")]
  let handle = api.register_ios_plugin(init_plugin_configurate)?;
  Ok(Configurate(handle))
}

/// Access to the configurate APIs on mobile platforms.
pub struct Configurate<R: Runtime>(PluginHandle<R>);
