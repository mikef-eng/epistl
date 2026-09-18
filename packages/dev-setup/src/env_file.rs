//! The one safe filesystem auto-fix this issue covers: copying
//! `.env.example` to `.env` at the repo root if `.env` doesn't already
//! exist, and leaving an existing `.env` untouched otherwise.

use std::fs;
use std::io;
use std::path::Path;

/// What `ensure_env_file` did, so `main.rs` can print the right
/// confirmation line without re-deriving it from the filesystem.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvFileOutcome {
    /// `.env` didn't exist; `.env.example` was copied to `.env`.
    Created,
    /// `.env` already existed; nothing was written.
    AlreadyPresent,
}

/// Ensures `<repo_root>/.env` exists, copying it from
/// `<repo_root>/.env.example` if missing. Takes `repo_root` as a parameter
/// (rather than hardcoding a path) so tests can point this at a throwaway
/// temp directory fixture instead of this repo's real `.env`/`.env.example`.
pub fn ensure_env_file(repo_root: &Path) -> io::Result<EnvFileOutcome> {
    let env_path = repo_root.join(".env");
    if env_path.exists() {
        return Ok(EnvFileOutcome::AlreadyPresent);
    }

    let example_path = repo_root.join(".env.example");
    fs::copy(&example_path, &env_path)?;
    Ok(EnvFileOutcome::Created)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Deletes its directory (recursively) on drop, so every test gets a
    /// throwaway fixture directory without pulling in a `tempfile`
    /// dependency for what this crate otherwise has zero external deps
    /// for.
    struct TempDir {
        path: std::path::PathBuf,
    }

    impl TempDir {
        fn new(label: &str) -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "dev-setup-test-{label}-{}-{}-{nanos}",
                std::process::id(),
                n
            ));
            fs::create_dir_all(&path).expect("failed to create temp dir fixture");
            TempDir { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn copies_env_example_to_env_when_env_is_missing() {
        let dir = TempDir::new("missing");
        fs::write(dir.path.join(".env.example"), "FOO=bar\n").unwrap();

        let outcome = ensure_env_file(&dir.path).expect("ensure_env_file should succeed");

        assert_eq!(outcome, EnvFileOutcome::Created);
        let contents = fs::read_to_string(dir.path.join(".env")).unwrap();
        assert_eq!(contents, "FOO=bar\n");
    }

    #[test]
    fn leaves_existing_env_untouched() {
        let dir = TempDir::new("present");
        fs::write(dir.path.join(".env.example"), "FOO=bar\n").unwrap();
        fs::write(dir.path.join(".env"), "FOO=already-set-by-user\n").unwrap();

        let outcome = ensure_env_file(&dir.path).expect("ensure_env_file should succeed");

        assert_eq!(outcome, EnvFileOutcome::AlreadyPresent);
        let contents = fs::read_to_string(dir.path.join(".env")).unwrap();
        assert_eq!(contents, "FOO=already-set-by-user\n");
    }
}
