use tauri::{
    plugin::TauriPlugin,
    Manager, Runtime,
};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod config;
mod dotpath;
mod error;
mod keyring_store;
mod locker;
mod models;
mod storage;
mod watcher;

pub use config::{Builder, PluginConfig, PluginSettings, DEFAULT_MAX_READ_BYTES};
pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::Configurate;
#[cfg(mobile)]
use mobile::Configurate;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`]
/// to access the configurate APIs.
pub trait ConfigurateExt<R: Runtime> {
    fn configurate(&self) -> &Configurate<R>;
}

impl<R: Runtime, T: Manager<R>> crate::ConfigurateExt<R> for T {
    fn configurate(&self) -> &Configurate<R> {
        self.state::<Configurate<R>>().inner()
    }
}

/// Initializes the plugin with default settings.
pub fn init<R: Runtime>() -> TauriPlugin<R, Option<PluginConfig>> {
    Builder::default().build()
}
