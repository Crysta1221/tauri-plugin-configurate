/// Per-file advisory lock registry.
///
/// Provides a per-path `Mutex<()>` so that read-then-write operations such as
/// `patch` cannot interleave with concurrent writes to the same file within
/// the same process.  All locks are advisory—they do not affect external
/// processes.
///
/// Stale entries (where the registry holds the only remaining `Arc` reference)
/// are periodically purged to prevent unbounded memory growth.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Purge stale entries every N calls to `acquire`.
const CLEANUP_INTERVAL: u32 = 64;

pub struct FileLockRegistry {
    map: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
    call_count: Mutex<u32>,
}

impl FileLockRegistry {
    pub fn new() -> Self {
        FileLockRegistry {
            map: Mutex::new(HashMap::new()),
            call_count: Mutex::new(0),
        }
    }

    /// Returns (or creates) the per-path `Arc<Mutex<()>>` for `path`.
    ///
    /// Every `CLEANUP_INTERVAL` calls, stale entries whose `Arc` is only held
    /// by the registry (strong_count == 1) are removed to reclaim memory.
    pub fn acquire(&self, path: PathBuf) -> Arc<Mutex<()>> {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());

        // Periodic cleanup of stale entries.
        {
            let mut count = self.call_count.lock().unwrap_or_else(|e| e.into_inner());
            *count += 1;
            if *count >= CLEANUP_INTERVAL {
                *count = 0;
                map.retain(|_, arc| Arc::strong_count(arc) > 1);
            }
        }

        map.entry(path)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_entries_are_cleaned_up() {
        let registry = FileLockRegistry::new();

        // Acquire and immediately drop a lock.
        let _ = registry.acquire(PathBuf::from("stale.json"));
        assert_eq!(
            registry.map.lock().unwrap().len(),
            1,
            "entry should exist before cleanup"
        );

        // Trigger cleanup by calling acquire CLEANUP_INTERVAL times.
        // Cleanup runs on the CLEANUP_INTERVAL-th call, then that call
        // also inserts its own (new) entry.  Re-acquire the same path to
        // avoid adding an extra entry after cleanup.
        for i in 1..CLEANUP_INTERVAL {
            let _ = registry.acquire(PathBuf::from(format!("tmp-{}.json", i)));
        }
        // The cleanup fired on call #64. It purged all stale entries
        // (strong_count == 1), then the 64th call inserted "tmp-63.json".
        // That entry is also immediately dropped, but it was inserted
        // *after* cleanup ran, so it remains until the next cycle.
        // Verify that the original stale entry was removed.
        let map = registry.map.lock().unwrap();
        assert!(
            !map.contains_key(&PathBuf::from("stale.json")),
            "stale entry should be purged after cleanup"
        );
        // Only the post-cleanup entry remains (tmp-63.json).
        assert_eq!(map.len(), 1, "only the post-cleanup entry should remain");
    }

    #[test]
    fn active_entries_survive_cleanup() {
        let registry = FileLockRegistry::new();

        // Acquire and hold the lock.
        let _held = registry.acquire(PathBuf::from("active.json"));

        // Trigger cleanup.
        for i in 1..CLEANUP_INTERVAL {
            let _ = registry.acquire(PathBuf::from(format!("tmp-{}.json", i)));
        }

        let map = registry.map.lock().unwrap();
        assert!(
            map.contains_key(&PathBuf::from("active.json")),
            "actively held lock should survive cleanup"
        );
    }
}
