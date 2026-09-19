//! `.env` bootstrap: root + mobile, with SeaweedFS localhost rewrite.

use std::fs;
use std::io;
use std::path::Path;

/// What `ensure_env_files` did for one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvFileOutcome {
    /// File didn't exist; example was copied (and possibly rewritten).
    Created,
    /// File already existed; nothing was written.
    AlreadyPresent,
}

/// Result of bootstrapping both env files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvBootstrap {
    pub root: EnvFileOutcome,
    pub mobile: EnvFileOutcome,
}

/// Ensures root `.env` and `apps/mobile/.env` exist.
///
/// When creating the root `.env`, rewrites `SEAWEEDFS_INTERNAL_ENDPOINT`
/// from the compose-network hostname to `http://localhost:8333` because
/// the API always runs on the host in local dev.
pub fn ensure_env_files(repo_root: &Path) -> io::Result<EnvBootstrap> {
    let root = ensure_root_env(repo_root)?;
    let mobile = ensure_copy(
        &repo_root.join("apps/mobile/.env.example"),
        &repo_root.join("apps/mobile/.env"),
    )?;
    Ok(EnvBootstrap { root, mobile })
}

/// Back-compat wrapper used by older call sites / tests.
pub fn ensure_env_file(repo_root: &Path) -> io::Result<EnvFileOutcome> {
    ensure_root_env(repo_root)
}

fn ensure_root_env(repo_root: &Path) -> io::Result<EnvFileOutcome> {
    let env_path = repo_root.join(".env");
    if env_path.exists() {
        return Ok(EnvFileOutcome::AlreadyPresent);
    }

    let example_path = repo_root.join(".env.example");
    let contents = fs::read_to_string(&example_path)?;
    let rewritten = rewrite_seaweedfs_internal(&contents);
    fs::write(&env_path, rewritten)?;
    Ok(EnvFileOutcome::Created)
}

fn ensure_copy(example: &Path, dest: &Path) -> io::Result<EnvFileOutcome> {
    if dest.exists() {
        return Ok(EnvFileOutcome::AlreadyPresent);
    }
    if !example.exists() {
        // Mobile example may be absent in minimal fixtures; treat as skip.
        return Ok(EnvFileOutcome::AlreadyPresent);
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(example, dest)?;
    Ok(EnvFileOutcome::Created)
}

/// Rewrite SEAWEEDFS_INTERNAL_ENDPOINT to localhost for host-run API.
pub fn rewrite_seaweedfs_internal(contents: &str) -> String {
    let mut out = String::with_capacity(contents.len());
    for line in contents.lines() {
        if let Some(rest) = line.strip_prefix("SEAWEEDFS_INTERNAL_ENDPOINT=") {
            let _ = rest;
            out.push_str("SEAWEEDFS_INTERNAL_ENDPOINT=http://localhost:8333");
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

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
                "dev-setup-env-{label}-{}-{}-{nanos}",
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
    fn copies_and_rewrites_seaweedfs_endpoint() {
        let dir = TempDir::new("missing");
        fs::write(
            dir.path.join(".env.example"),
            "FOO=bar\nSEAWEEDFS_INTERNAL_ENDPOINT=http://seaweedfs:8333\n",
        )
        .unwrap();
        fs::create_dir_all(dir.path.join("apps/mobile")).unwrap();
        fs::write(
            dir.path.join("apps/mobile/.env.example"),
            "EXPO_PUBLIC_API_URL=http://localhost:3000\n",
        )
        .unwrap();

        let bootstrap = ensure_env_files(&dir.path).unwrap();
        assert_eq!(bootstrap.root, EnvFileOutcome::Created);
        assert_eq!(bootstrap.mobile, EnvFileOutcome::Created);

        let contents = fs::read_to_string(dir.path.join(".env")).unwrap();
        assert!(contents.contains("SEAWEEDFS_INTERNAL_ENDPOINT=http://localhost:8333"));
        assert!(!contents.contains("seaweedfs:8333"));
        assert!(dir.path.join("apps/mobile/.env").exists());
    }

    #[test]
    fn leaves_existing_env_untouched() {
        let dir = TempDir::new("present");
        fs::write(dir.path.join(".env.example"), "FOO=bar\n").unwrap();
        fs::write(dir.path.join(".env"), "FOO=already-set-by-user\n").unwrap();

        let outcome = ensure_env_file(&dir.path).unwrap();
        assert_eq!(outcome, EnvFileOutcome::AlreadyPresent);
        let contents = fs::read_to_string(dir.path.join(".env")).unwrap();
        assert_eq!(contents, "FOO=already-set-by-user\n");
    }

    #[test]
    fn rewrite_helper() {
        let input = "SEAWEEDFS_INTERNAL_ENDPOINT=http://seaweedfs:8333\nOTHER=1\n";
        let out = rewrite_seaweedfs_internal(input);
        assert!(out.contains("http://localhost:8333"));
        assert!(out.contains("OTHER=1"));
    }
}
