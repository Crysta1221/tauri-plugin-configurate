use serde::Deserialize;
use tauri::{
    plugin::{Builder as PluginBuilder, TauriPlugin},
    Manager, Runtime,
};

use crate::error::{Error, Result};
use crate::locker;
use crate::storage;
use crate::watcher;

#[cfg(desktop)]
use crate::desktop;
#[cfg(mobile)]
use crate::mobile;

/// Default maximum bytes read from a config file or import content string.
pub const DEFAULT_MAX_READ_BYTES: usize = 16 * 1024 * 1024;

/// Resolved plugin settings stored in Tauri state.
#[derive(Debug, Clone, Copy)]
pub struct PluginSettings {
    pub max_read_bytes: usize,
}

/// Plugin configuration from `tauri.conf.json` (`plugins.configurate`).
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginConfig {
    /// Maximum bytes read from a config file or import content string.
    pub max_read_bytes: Option<usize>,
}

/// Builder for [`tauri_plugin_configurate`].
#[derive(Debug, Clone)]
pub struct Builder {
    max_read_bytes: usize,
}

impl Default for Builder {
    fn default() -> Self {
        Self {
            max_read_bytes: DEFAULT_MAX_READ_BYTES,
        }
    }
}

impl Builder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the maximum bytes read from config files and import content.
    ///
    /// `tauri.conf.json` (`plugins.configurate.maxReadBytes`) overrides this
    /// value when present.
    pub fn max_read_bytes(mut self, bytes: usize) -> Self {
        self.max_read_bytes = bytes;
        self
    }

    pub fn build<R: Runtime>(self) -> TauriPlugin<R, Option<PluginConfig>> {
        let builder = self;
        PluginBuilder::<R, Option<PluginConfig>>::new("configurate")
            .invoke_handler(tauri::generate_handler![
                crate::commands::create,
                crate::commands::load,
                crate::commands::save,
                crate::commands::patch,
                crate::commands::delete,
                crate::commands::exists,
                crate::commands::load_all,
                crate::commands::save_all,
                crate::commands::patch_all,
                crate::commands::unlock,
                crate::commands::watch_file,
                crate::commands::unwatch_file,
                crate::commands::list_configs,
                crate::commands::reset,
                crate::commands::export_config,
                crate::commands::import_config,
            ])
            .setup(move |app, api| {
                let settings = resolve_settings(&builder, api.config().as_ref())?;
                validate_max_read_bytes(settings.max_read_bytes)?;

                #[cfg(mobile)]
                let configurate = mobile::init(app, api)?;
                #[cfg(desktop)]
                let configurate = desktop::init(app, api)?;

                app.manage(configurate);
                app.manage(settings);
                app.manage(locker::FileLockRegistry::new());
                app.manage(std::sync::Arc::new(storage::BackupRegistry::new()));
                let watcher_state = watcher::WatcherState::new(app.clone())?;
                app.manage(watcher_state);
                Ok(())
            })
            .on_event(|app, event| {
                if let tauri::RunEvent::Exit = event {
                    if let Some(registry) =
                        app.try_state::<std::sync::Arc<storage::BackupRegistry>>()
                    {
                        registry.cleanup_all();
                    }
                }
            })
            .build()
    }
}

pub(crate) fn resolve_settings(
    builder: &Builder,
    file: Option<&PluginConfig>,
) -> Result<PluginSettings> {
    Ok(PluginSettings {
        max_read_bytes: file
            .and_then(|config| config.max_read_bytes)
            .unwrap_or(builder.max_read_bytes),
    })
}

fn validate_max_read_bytes(bytes: usize) -> Result<()> {
    if bytes == 0 {
        return Err(Error::InvalidPayload(
            "maxReadBytes must be greater than 0".to_string(),
        ));
    }
    Ok(())
}

pub(crate) fn max_read_bytes<R: Runtime>(app: &tauri::AppHandle<R>) -> usize {
    app.try_state::<PluginSettings>()
        .map(|settings| settings.max_read_bytes)
        .unwrap_or(DEFAULT_MAX_READ_BYTES)
}
