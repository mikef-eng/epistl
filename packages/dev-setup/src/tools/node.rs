//! Node.js via system Node (if version OK) or fnm + Node 22.

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

    // Install and default Node 22.
    let install_cmd = format!("fnm install {NODE_MAJOR} && fnm default {NODE_MAJOR}");
    if exec.run("sh", &["-c", &install_cmd]).is_none() {
        // Try with env eval in case fnm just landed on PATH via profile.
        let with_env =
            format!("eval \"$(fnm env)\" && fnm install {NODE_MAJOR} && fnm default {NODE_MAJOR}");
        if exec.run("bash", &["-c", &with_env]).is_none() {
            return ToolOutcome::Failed("fnm install/default failed".into());
        }
    }

    // Persist fnm env in shell profile.
    let profile = platform.shell_profile();
    let body = "eval \"$(fnm env)\"\nexport PATH=\"$HOME/.local/bin:$PATH\"";
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
            match exec.run("bash", &["-c", cmd]) {
                Some(_) => Ok(()),
                None => Err("fnm install script failed".into()),
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
}
