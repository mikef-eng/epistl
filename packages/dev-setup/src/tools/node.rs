//! Node.js via system Node (if version OK) or fnm + Node 22.

use std::path::{Path, PathBuf};

use crate::checks::CommandExecutor;
use crate::pkg::{brew_available, install_packages, PackageSpec};
use crate::platform::{OsKind, Platform};
use crate::profile::ensure_profile_block;
use crate::prompt::{confirm_required, PromptPolicy};
use crate::tools::ToolOutcome;

/// Node major version pinned in `.node-version` and CI.
pub const NODE_MAJOR: u32 = 22;

/// Whether a `node --version` string (e.g. `v22.13.0`) satisfies RN 0.86.3's
/// engines range: `^20.19.4 || ^22.13.0 || ^24.3.0 || >=25`.
pub fn node_version_ok(version_str: &str) -> bool {
    let trimmed = version_str.trim().trim_start_matches('v');
    let parts: Vec<_> = trimmed
        .split('.')
        .filter_map(|p| p.parse::<u32>().ok())
        .collect();
    if parts.is_empty() {
        return false;
    }
    let major = parts[0];
    let minor = parts.get(1).copied().unwrap_or(0);
    let patch = parts.get(2).copied().unwrap_or(0);
    match major {
        20 => minor > 19 || (minor == 19 && patch >= 4),
        22 => minor >= 13,
        24 => minor >= 3,
        m if m >= 25 => true,
        _ => false,
    }
}

/// Candidate directories where the fnm binary may land after install.
pub fn fnm_candidate_dirs(home: &Path) -> Vec<PathBuf> {
    vec![home.join(".local/share/fnm"), home.join(".fnm")]
}

/// First candidate dir that contains an `fnm` binary, if any.
pub fn resolve_fnm_dir(home: &Path) -> Option<PathBuf> {
    fnm_candidate_dirs(home)
        .into_iter()
        .find(|d| d.join("fnm").is_file())
}

/// Shell that prepends `fnm_dir`, activates fnm, installs Node, then prints
/// absolute paths of `node` and `fnm` (one per line) for process PATH update.
pub fn fnm_install_and_capture_cmd(fnm_dir: &Path) -> String {
    format!(
        "export PATH=\"{}:$PATH\" && eval \"$(fnm env)\" && fnm install {NODE_MAJOR} && fnm default {NODE_MAJOR} && command -v node && command -v fnm",
        fnm_dir.display()
    )
}

/// Prepend directories onto the current process `PATH` (for same-session use).
pub fn prepend_process_path(dirs: &[PathBuf]) {
    if dirs.is_empty() {
        return;
    }
    let prefix = dirs
        .iter()
        .map(|d| d.display().to_string())
        .collect::<Vec<_>>()
        .join(":");
    let old = std::env::var("PATH").unwrap_or_default();
    if old.is_empty() {
        std::env::set_var("PATH", prefix);
    } else {
        std::env::set_var("PATH", format!("{prefix}:{old}"));
    }
}

pub fn ensure_node(
    platform: &Platform,
    exec: &dyn CommandExecutor,
    policy: &PromptPolicy,
    check_only: bool,
) -> ToolOutcome {
    if let Some(version) = exec.run("node", &["--version"]) {
        if node_version_ok(&version) {
            return ToolOutcome::Present(version);
        }
        // Version too old — fall through to install path.
        if check_only {
            return ToolOutcome::Absent(format!(
                "node {version} does not satisfy ^20.19.4 || ^22.13 || ^24.3 || >=25"
            ));
        }
    } else if check_only {
        return ToolOutcome::Absent("node not found".into());
    }

    if !confirm_required(
        policy,
        &format!("Node.js {NODE_MAJOR}+ missing/too-old. Install via fnm?"),
    ) {
        return ToolOutcome::Skipped("user declined fnm/node install".into());
    }

    // Install fnm if needed.
    if exec.run("fnm", &["--version"]).is_none() {
        if let Err(e) = install_fnm(platform, exec) {
            return ToolOutcome::Failed(e);
        }
    }

    let fnm_dir = resolve_fnm_dir(&platform.home).or_else(|| {
        // brew/fnm may already be on PATH without living in the usual dirs.
        if exec.run("fnm", &["--version"]).is_some() {
            Some(PathBuf::new())
        } else {
            None
        }
    });

    let Some(fnm_dir) = fnm_dir else {
        return ToolOutcome::Failed(
            "fnm installed but binary not found under ~/.local/share/fnm or ~/.fnm".into(),
        );
    };

    let install_cmd = if fnm_dir.as_os_str().is_empty() {
        format!(
            "eval \"$(fnm env)\" && fnm install {NODE_MAJOR} && fnm default {NODE_MAJOR} && command -v node && command -v fnm"
        )
    } else {
        fnm_install_and_capture_cmd(&fnm_dir)
    };

    let output = exec.run_output("bash", &["-c", &install_cmd]);
    if !output.status_ok {
        return ToolOutcome::Failed(format!(
            "fnm install/default failed: {}",
            output.failure_detail()
        ));
    }

    // Last two non-empty lines are `command -v node` and `command -v fnm`.
    let paths: Vec<&str> = output
        .stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let mut path_dirs = Vec::new();
    if !fnm_dir.as_os_str().is_empty() {
        path_dirs.push(fnm_dir.clone());
    }
    if let Some(fnm_bin) = paths.last() {
        if let Some(parent) = Path::new(fnm_bin).parent() {
            if !path_dirs.iter().any(|d| d == parent) {
                path_dirs.push(parent.to_path_buf());
            }
        }
    }
    if paths.len() >= 2 {
        if let Some(parent) = Path::new(paths[paths.len() - 2]).parent() {
            if !path_dirs.iter().any(|d| d == parent) {
                path_dirs.push(parent.to_path_buf());
            }
        }
    }
    // Prefer aliases/default/bin when present (stable after `fnm default`).
    if !fnm_dir.as_os_str().is_empty() {
        let alias_bin = fnm_dir.join("aliases/default/bin");
        if alias_bin.is_dir() {
            path_dirs.push(alias_bin);
        }
    }
    prepend_process_path(&path_dirs);

    // Persist fnm env in shell profile (merged with other tool exports).
    // `--skip-shell` leaves the binary under ~/.local/share/fnm (or ~/.fnm);
    // that dir must be on PATH before `eval "$(fnm env)"` or new shells
    // report `fnm: command not found`.
    let profile = platform.shell_profile();
    let body = "export PATH=\"$HOME/.local/share/fnm:$HOME/.fnm:$PATH\"\neval \"$(fnm env)\"\nexport PATH=\"$HOME/.local/bin:$PATH\"";
    let _ = ensure_profile_block(&profile, body);

    ToolOutcome::Installed(format!(
        "fnm + Node {NODE_MAJOR} installed (restart shell or: eval \"$(fnm env)\")"
    ))
}

fn install_fnm(platform: &Platform, exec: &dyn CommandExecutor) -> Result<(), String> {
    match platform.os {
        OsKind::Macos => {
            if !brew_available(exec) {
                return Err("Homebrew required to install fnm on macOS".into());
            }
            install_packages(
                platform,
                exec,
                &PackageSpec {
                    apt: &[],
                    dnf: &[],
                    pacman: &[],
                    brew: &["fnm"],
                    brew_cask: &[],
                },
            )
        }
        OsKind::Linux => {
            let cmd = "curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell";
            let output = exec.run_output("bash", &["-c", cmd]);
            if output.status_ok {
                Ok(())
            } else {
                Err(format!(
                    "fnm install script failed: {}",
                    output.failure_detail()
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_node_versions() {
        assert!(node_version_ok("v20.19.4"));
        assert!(node_version_ok("v22.13.0"));
        assert!(node_version_ok("v22.14.1"));
        assert!(node_version_ok("v24.3.0"));
        assert!(node_version_ok("v25.0.0"));
    }

    #[test]
    fn rejects_invalid_node_versions() {
        assert!(!node_version_ok("v18.20.0"));
        assert!(!node_version_ok("v20.19.3"));
        assert!(!node_version_ok("v22.12.0"));
        assert!(!node_version_ok("v24.2.0"));
        assert!(!node_version_ok("not-a-version"));
    }

    #[test]
    fn fnm_install_cmd_prepends_dir_and_activates() {
        let cmd = fnm_install_and_capture_cmd(Path::new("/home/dev/.local/share/fnm"));
        assert!(cmd.contains("export PATH=\"/home/dev/.local/share/fnm:$PATH\""));
        assert!(cmd.contains("eval \"$(fnm env)\""));
        assert!(cmd.contains("fnm install 22"));
        assert!(cmd.contains("fnm default 22"));
        assert!(cmd.contains("command -v node"));
        assert!(cmd.contains("command -v fnm"));
    }

    #[test]
    fn profile_body_puts_fnm_dir_on_path_before_eval() {
        // Mirrors the body written by ensure_node — new shells must find
        // `fnm` before `eval "$(fnm env)"`.
        let body = "export PATH=\"$HOME/.local/share/fnm:$HOME/.fnm:$PATH\"\neval \"$(fnm env)\"\nexport PATH=\"$HOME/.local/bin:$PATH\"";
        let eval_at = body.find("eval \"$(fnm env)\"").expect("eval line");
        let path_at = body
            .find("export PATH=\"$HOME/.local/share/fnm:")
            .expect("fnm PATH line");
        assert!(path_at < eval_at);
    }

    #[test]
    fn resolve_fnm_dir_finds_binary() {
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::{SystemTime, UNIX_EPOCH};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let home = std::env::temp_dir().join(format!(
            "dev-setup-fnm-home-{}-{}-{nanos}",
            std::process::id(),
            n
        ));
        let fnm_dir = home.join(".local/share/fnm");
        std::fs::create_dir_all(&fnm_dir).unwrap();
        std::fs::write(fnm_dir.join("fnm"), b"#!/bin/sh\n").unwrap();
        assert_eq!(resolve_fnm_dir(&home), Some(fnm_dir));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn prepend_process_path_puts_dirs_first() {
        let old = std::env::var("PATH").unwrap_or_default();
        let marker = PathBuf::from("/tmp/epistl-fnm-test-bin");
        prepend_process_path(std::slice::from_ref(&marker));
        let new = std::env::var("PATH").unwrap();
        assert!(new.starts_with("/tmp/epistl-fnm-test-bin:"));
        std::env::set_var("PATH", old);
    }
}
