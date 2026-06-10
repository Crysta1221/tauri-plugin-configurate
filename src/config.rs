use serde::Deserialize;
use tauri::{
    path::BaseDirectory,
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

/// Default maximum bytes read from a config file or import content string (16 MiB).
pub const DEFAULT_MAX_READ_BYTES: usize = 16_777_216;

/// Policy for which [`BaseDirectory`] values IPC payloads may use.
#[derive(Debug, Clone)]
pub enum BaseDirPolicy {
    /// Only directories in the inner set are allowed (`BaseDirectory` discriminant values).
    Restricted(Vec<u16>),
    /// Any [`BaseDirectory`] is allowed (opt-out of the default restriction).
    Unrestricted,
}

fn base_dir_id(dir: BaseDirectory) -> u16 {
    dir as u16
}

/// Resolved plugin settings stored in Tauri state.
#[derive(Debug, Clone)]
pub struct PluginSettings {
    pub max_read_bytes: usize,
    pub allowed_base_dirs: BaseDirPolicy,
}

/// Plugin configuration from `tauri.conf.json` (`plugins.configurate`).
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginConfig {
    /// Maximum bytes read from a config file or import content string.
    pub max_read_bytes: Option<usize>,
}

/// Default allowlist: app-scoped and bundle resource directories only.
pub fn default_allowed_base_directories() -> Vec<BaseDirectory> {
    vec![
        BaseDirectory::AppConfig,
        BaseDirectory::AppData,
        BaseDirectory::AppLocalData,
        BaseDirectory::AppCache,
        BaseDirectory::AppLog,
        BaseDirectory::Resource,
        BaseDirectory::Temp,
    ]
}

/// Builder for [`tauri_plugin_configurate`].
#[derive(Debug, Clone)]
pub struct Builder {
    max_read_bytes: usize,
    allowed_base_dirs: BaseDirPolicy,
}

impl Default for Builder {
    fn default() -> Self {
        Self {
            max_read_bytes: DEFAULT_MAX_READ_BYTES,
            allowed_base_dirs: BaseDirPolicy::Restricted(
                default_allowed_base_directories()
                    .into_iter()
                    .map(base_dir_id)
                    .collect(),
            ),
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

    /// Replaces the default app-scoped [`BaseDirectory`] allowlist.
    pub fn allowed_base_directories(
        mut self,
        dirs: impl IntoIterator<Item = BaseDirectory>,
    ) -> Self {
        self.allowed_base_dirs =
            BaseDirPolicy::Restricted(dirs.into_iter().map(base_dir_id).collect());
        self
    }

    /// Allows any [`BaseDirectory`] in IPC payloads (disables the default restriction).
    pub fn allow_any_base_directory(mut self) -> Self {
        self.allowed_base_dirs = BaseDirPolicy::Unrestricted;
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
        allowed_base_dirs: builder.allowed_base_dirs.clone(),
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

pub(crate) fn validate_base_directory<R: Runtime>(
    app: &tauri::AppHandle<R>,
    base_dir: BaseDirectory,
) -> Result<()> {
    let policy = app
        .try_state::<PluginSettings>()
        .map(|settings| settings.allowed_base_dirs.clone())
        .unwrap_or_else(|| {
            BaseDirPolicy::Restricted(
                default_allowed_base_directories()
                    .into_iter()
                    .map(base_dir_id)
                    .collect(),
            )
        });

    validate_base_directory_policy(&policy, base_dir)
}

pub(crate) fn validate_base_directory_policy(
    policy: &BaseDirPolicy,
    base_dir: BaseDirectory,
) -> Result<()> {
    match policy {
        BaseDirPolicy::Unrestricted => Ok(()),
        BaseDirPolicy::Restricted(allowed) if allowed.contains(&base_dir_id(base_dir)) => {
            Ok(())
        }
        BaseDirPolicy::Restricted(_) => Err(Error::InvalidPayload(format!(
            "baseDir '{}' is not allowed by plugin configuration; \
             use an app-scoped directory (e.g. AppConfig) or call \
             Builder::allowed_base_directories / allow_any_base_directory",
            base_dir.variable()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_policy() -> BaseDirPolicy {
        BaseDirPolicy::Restricted(
            default_allowed_base_directories()
                .into_iter()
                .map(base_dir_id)
                .collect(),
        )
    }

    #[test]
    fn default_policy_allows_app_config() {
        let policy = default_policy();
        assert!(validate_base_directory_policy(&policy, BaseDirectory::AppConfig).is_ok());
    }

    #[test]
    fn default_policy_rejects_home() {
        let policy = default_policy();
        assert!(validate_base_directory_policy(&policy, BaseDirectory::Home).is_err());
    }

    #[test]
    fn unrestricted_policy_allows_home() {
        assert!(validate_base_directory_policy(&BaseDirPolicy::Unrestricted, BaseDirectory::Home)
            .is_ok());
    }
}
