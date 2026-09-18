//! Injectable environment-variable / filesystem lookups (issue #204).
//!
//! The Android Studio / Android NDK guide-only checks detect via env
//! vars (`ANDROID_HOME`/`ANDROID_SDK_ROOT`) and filesystem paths, not by
//! running a command, so they can't go through `checks::CommandExecutor`.
//! This trait plays the same role for those lookups that
//! `CommandExecutor` plays for shelling out: real code goes through
//! `SystemEnvironment`, tests substitute a fake so they never depend on
//! whatever env vars/paths happen to be set on the machine running
//! `cargo test`.

use std::path::Path;

pub trait Environment {
    /// Returns the named environment variable's value, or `None` if unset.
    fn var(&self, name: &str) -> Option<String>;

    /// Whether `path` exists (file or directory).
    fn path_exists(&self, path: &Path) -> bool;

    /// Whether `path` is a directory containing at least one entry --
    /// used to check for at least one installed NDK version under
    /// `<ANDROID_HOME>/ndk`.
    fn dir_has_entries(&self, path: &Path) -> bool;
}

/// The real environment, backed by `std::env` and `std::fs`.
pub struct SystemEnvironment;

impl Environment for SystemEnvironment {
    fn var(&self, name: &str) -> Option<String> {
        std::env::var(name).ok()
    }

    fn path_exists(&self, path: &Path) -> bool {
        path.exists()
    }

    fn dir_has_entries(&self, path: &Path) -> bool {
        std::fs::read_dir(path)
            .map(|mut entries| entries.next().is_some())
            .unwrap_or(false)
    }
}
