/// External file-change watcher powered by `notify-debouncer-mini`.
///
/// `WatcherState` is stored in Tauri's app state and shared across all commands.
/// Call `watch(path, event)` to start monitoring a file; the watcher will
/// emit `configurate://change` events with `operation = "external_change"` when
/// the file is modified by a process outside this plugin.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify_debouncer_mini::{
    new_debouncer, notify::RecursiveMode, Debouncer, DebounceEventResult,
};
use notify_debouncer_mini::notify::RecommendedWatcher;
use tauri::{AppHandle, Emitter, Runtime};

use crate::commands::{ConfigChangeEvent, CHANGE_EVENT};
use crate::error::{Error, Result};

#[derive(Debug, Clone)]
struct WatchRegistration {
    ref_count: usize,
    event: ConfigChangeEvent,
}

#[derive(Default)]
struct PathWatchRegistry {
    by_path: HashMap<PathBuf, HashMap<String, WatchRegistration>>,
}

impl PathWatchRegistry {
    fn add(&mut self, path: PathBuf, event: ConfigChangeEvent) -> bool {
        let registrations = self.by_path.entry(path).or_default();
        let should_watch = registrations.is_empty();

        registrations
            .entry(event.target_id.clone())
            .and_modify(|registration| registration.ref_count += 1)
            .or_insert(WatchRegistration {
                ref_count: 1,
                event,
            });

        should_watch
    }

    fn remove(&mut self, path: &Path, target_id: &str) -> bool {
        let mut should_unwatch = false;

        if let Some(registrations) = self.by_path.get_mut(path) {
            if let Some(registration) = registrations.get_mut(target_id) {
                if registration.ref_count > 1 {
                    registration.ref_count -= 1;
                } else {
                    registrations.remove(target_id);
                }
            }

            if registrations.is_empty() {
                should_unwatch = true;
            }
        }

        if should_unwatch {
            self.by_path.remove(path);
        }

        should_unwatch
    }

    fn events_for(&self, path: &Path) -> Vec<ConfigChangeEvent> {
        self.by_path
            .get(path)
            .map(|registrations| {
                registrations
                    .values()
                    .map(|registration| registration.event.clone())
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// Non-generic watcher state.  The generic `R` is captured inside the debouncer
/// callback closure so the struct itself does not need a type parameter.
pub struct WatcherState {
    registry: Arc<Mutex<PathWatchRegistry>>,
    // Wrapped in Mutex to make Debouncer<RecommendedWatcher> Sync.
    debouncer: Mutex<Debouncer<RecommendedWatcher>>,
}

impl WatcherState {
    pub fn new<R: Runtime + 'static>(app: AppHandle<R>) -> Result<Self> {
        let registry = Arc::new(Mutex::new(PathWatchRegistry::default()));
        let callback_registry = Arc::clone(&registry);

        let debouncer = new_debouncer(
            Duration::from_millis(300),
            move |result: DebounceEventResult| {
                let events = match result {
                    Ok(events) => events,
                    Err(_) => return,
                };

                let emitted_events = {
                    let registry = callback_registry.lock().unwrap_or_else(|e| e.into_inner());
                    events
                        .iter()
                        .flat_map(|event| registry.events_for(&event.path))
                        .collect::<Vec<_>>()
                };

                for change_event in emitted_events {
                    let _ = app.emit(CHANGE_EVENT, change_event);
                }
            },
        )
        .map_err(|e| Error::Storage(format!("failed to create file watcher: {}", e)))?;

        Ok(WatcherState {
            registry,
            debouncer: Mutex::new(debouncer),
        })
    }

    /// Start watching `path`.  Fires `configurate://change` with the given event payload
    /// when the file is created, modified, or removed by an external process.
    pub fn watch(&self, path: PathBuf, event: ConfigChangeEvent) -> Result<()> {
        let mut debouncer = self.debouncer.lock().unwrap_or_else(|e| e.into_inner());
        let mut registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        let should_watch = registry.add(path.clone(), event.clone());

        if should_watch {
            if let Err(e) = debouncer.watcher().watch(&path, RecursiveMode::NonRecursive) {
                let _ = registry.remove(&path, &event.target_id);
                return Err(Error::Storage(format!(
                    "watch failed for '{}': {}",
                    path.display(),
                    e
                )));
            }
        }

        Ok(())
    }

    /// Stop watching one registration on `path`.  The OS watcher is removed only
    /// after the last registration for that path is gone.
    pub fn unwatch(&self, path: &Path, target_id: &str) -> Result<()> {
        let mut debouncer = self.debouncer.lock().unwrap_or_else(|e| e.into_inner());
        let mut registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        if registry.remove(path, target_id) {
            // unwatch returns Err when the path was not watched; treat that as a no-op.
            let _ = debouncer.watcher().unwatch(path);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change_event(target_id: &str) -> ConfigChangeEvent {
        ConfigChangeEvent {
            file_name: "settings.json".into(),
            operation: "external_change".into(),
            target_id: target_id.into(),
        }
    }

    #[test]
    fn registry_reference_counts_same_target() {
        let mut registry = PathWatchRegistry::default();
        let path = PathBuf::from("settings.json");

        assert!(registry.add(path.clone(), change_event("settings")));
        assert!(!registry.add(path.clone(), change_event("settings")));
        assert_eq!(registry.events_for(&path).len(), 1);

        assert!(!registry.remove(&path, "settings"));
        assert_eq!(registry.events_for(&path).len(), 1);

        assert!(registry.remove(&path, "settings"));
        assert!(registry.events_for(&path).is_empty());
    }

    #[test]
    fn registry_keeps_other_targets_active_until_last_unwatch() {
        let mut registry = PathWatchRegistry::default();
        let path = PathBuf::from("settings.json");

        assert!(registry.add(path.clone(), change_event("one")));
        assert!(!registry.add(path.clone(), change_event("two")));

        let mut target_ids = registry
            .events_for(&path)
            .into_iter()
            .map(|event| event.target_id)
            .collect::<Vec<_>>();
        target_ids.sort();
        assert_eq!(target_ids, vec!["one".to_string(), "two".to_string()]);

        assert!(!registry.remove(&path, "one"));
        let remaining = registry
            .events_for(&path)
            .into_iter()
            .map(|event| event.target_id)
            .collect::<Vec<_>>();
        assert_eq!(remaining, vec!["two".to_string()]);

        assert!(registry.remove(&path, "two"));
        assert!(registry.events_for(&path).is_empty());
    }
}
