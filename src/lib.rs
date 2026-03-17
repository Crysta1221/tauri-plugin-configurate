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
mod locker;
mod models;
mod storage;
mod watcher;

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
            commands::patch,
            commands::delete,
            commands::exists,
            commands::load_all,
            commands::save_all,
            commands::patch_all,
            commands::unlock,
            commands::watch_file,
            commands::unwatch_file,
            commands::list_configs,
            commands::reset,
            commands::export_config,
            commands::import_config,
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let configurate = mobile::init(app, api)?;
            #[cfg(desktop)]
            let configurate = desktop::init(app, api)?;
            app.manage(configurate);
            app.manage(locker::FileLockRegistry::new());
            app.manage(std::sync::Arc::new(storage::BackupRegistry::new()));
            let watcher_state = watcher::WatcherState::new(app.clone())?;
            app.manage(watcher_state);
            Ok(())
        })
        .on_event(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(registry) = app.try_state::<std::sync::Arc<storage::BackupRegistry>>() {
                    registry.cleanup_all();
                }
            }
        })
        .build()
}
