//! Docker Engine / Docker Desktop detection and Linux install.

use crate::checks::CommandExecutor;
use crate::platform::{OsKind, Platform};
use crate::prompt::{confirm_required, PromptPolicy};
use crate::tools::ToolOutcome;

pub fn ensure_docker(
    platform: &Platform,
    exec: &dyn CommandExecutor,
    policy: &PromptPolicy,
    check_only: bool,
) -> ToolOutcome {
    // Prefer daemon-aware check (`docker info`), same as checks.rs.
    if let Some(output) = exec.run("docker", &["info"]) {
        let version = output
            .lines()
            .find_map(|line| line.trim_start().strip_prefix("Server Version:"))
            .map(|v| v.trim().to_string())
            .unwrap_or_else(|| "daemon reachable".into());
        let wsl_note = if platform.is_wsl {
            " (WSL — Docker Desktop socket OK)"
        } else {
            ""
        };
        return ToolOutcome::Present(format!("{version}{wsl_note}"));
    }

    if check_only {
        return ToolOutcome::Absent(
            "docker daemon not reachable (is Docker installed and running?)".into(),
        );
    }

    match platform.os {
        OsKind::Macos => ToolOutcome::Guided(
            "Install Docker Desktop for Mac from https://www.docker.com/products/docker-desktop/ then re-run"
                .into(),
        ),
        OsKind::Linux => {
            // On WSL without a working socket, still offer Engine install,
            // but mention Desktop as the preferred path.
            let question = if platform.is_wsl {
                "Docker daemon not reachable in WSL. Install Docker Engine via get.docker.com? (prefer enabling Docker Desktop WSL integration if you use Desktop)"
            } else {
                "Docker missing. Install via get.docker.com and add your user to the docker group?"
            };

            if !confirm_required(policy, question) {
                return ToolOutcome::Skipped("user declined Docker install".into());
            }

            let install = "curl -fsSL https://get.docker.com | sh";
            if exec.run("sh", &["-c", install]).is_none() {
                return ToolOutcome::Failed("get.docker.com install script failed".into());
            }

            let user = std::env::var("USER").unwrap_or_else(|_| "USER".into());
            let group_cmd = format!("sudo usermod -aG docker {user}");
            let _ = exec.run("sh", &["-c", &group_cmd]);

            // Try to start the service (may fail in WSL without systemd).
            let _ = exec.run("sudo", &["systemctl", "enable", "--now", "docker"]);

            ToolOutcome::Installed(format!(
                "Docker Engine installed. Log out and back in (or `newgrp docker`) so group membership applies, then verify with `docker info`. User `{user}` was added to the docker group."
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct InfoExec;

    impl CommandExecutor for InfoExec {
        fn run(&self, program: &str, args: &[&str]) -> Option<String> {
            match (program, args) {
                ("docker", ["info"]) => Some("Server:\n Server Version: 27.0.3\n".into()),
                _ => None,
            }
        }
    }

    #[test]
    fn present_when_daemon_up() {
        let platform = Platform {
            os: OsKind::Linux,
            arch: "x86_64".into(),
            distro: Some(crate::platform::DistroFamily::Apt),
            is_wsl: true,
            home: PathBuf::from("/home/dev"),
        };
        let out = ensure_docker(
            &platform,
            &InfoExec,
            &PromptPolicy::testing(true, false),
            true,
        );
        match out {
            ToolOutcome::Present(m) => {
                assert!(m.contains("27.0.3"));
                assert!(m.contains("WSL"));
            }
            other => panic!("expected Present, got {other:?}"),
        }
    }

    #[test]
    fn macos_guides_to_desktop() {
        let platform = Platform {
            os: OsKind::Macos,
            arch: "aarch64".into(),
            distro: None,
            is_wsl: false,
            home: PathBuf::from("/Users/dev"),
        };
        struct Empty;
        impl CommandExecutor for Empty {
            fn run(&self, _: &str, _: &[&str]) -> Option<String> {
                None
            }
        }
        let out = ensure_docker(
            &platform,
            &Empty,
            &PromptPolicy::testing(true, false),
            false,
        );
        assert!(matches!(out, ToolOutcome::Guided(_)));
    }
}
