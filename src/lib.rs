use tauri::{
  plugin::{Builder, TauriPlugin},
  Manager, Runtime,
};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod dotpath;
mod error;
mod keyring_store;
mod models;
mod storage;

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

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("configurate")
        .invoke_handler(tauri::generate_handler![
            commands::create,
            commands::load,
            commands::save,
            commands::delete,
            commands::unlock,
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let configurate = mobile::init(app, api)?;
            #[cfg(desktop)]
            let configurate = desktop::init(app, api)?;
            app.manage(configurate);
            Ok(())
        })
        .build()
}
