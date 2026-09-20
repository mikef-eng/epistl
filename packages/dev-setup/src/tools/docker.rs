//! Docker Engine / Docker Desktop detection and Linux install.

use crate::checks::{CommandExecutor, CommandOutput};
use crate::platform::{OsKind, Platform};
use crate::prompt::{confirm_required, PromptPolicy};
use crate::tools::ToolOutcome;

/// How the current process can talk to the Docker daemon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DockerAccess {
    /// `docker` works with the ambient session credentials.
    Ambient,
    /// Ambient session lacks the `docker` group; `sg docker` works.
    ViaSg,
}

/// Probe whether Docker is reachable ambiently or only via `sg docker`.
pub fn probe_docker_access(exec: &dyn CommandExecutor) -> Option<DockerAccess> {
    if exec.run("docker", &["info"]).is_some() {
        return Some(DockerAccess::Ambient);
    }
    if exec.run("sg", &["docker", "-c", "docker info"]).is_some() {
        return Some(DockerAccess::ViaSg);
    }
    None
}

/// Join argv for `sg docker -c '…'` with light shell quoting.
pub fn shell_join(args: &[&str]) -> String {
    args.iter()
        .map(|a| {
            if a.chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_./:=@,".contains(c))
            {
                (*a).to_string()
            } else {
                format!("'{}'", a.replace('\'', "'\\''"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Run `docker <args>`, using `sg docker -c` when `access` is [`ViaSg`](DockerAccess::ViaSg).
pub fn run_docker(
    exec: &dyn CommandExecutor,
    access: DockerAccess,
    args: &[&str],
) -> CommandOutput {
    match access {
        DockerAccess::Ambient => exec.run_output("docker", args),
        DockerAccess::ViaSg => {
            let cmdline = format!("docker {}", shell_join(args));
            exec.run_output("sg", &["docker", "-c", &cmdline])
        }
    }
}

pub fn ensure_docker(
    platform: &Platform,
    exec: &dyn CommandExecutor,
    policy: &PromptPolicy,
    check_only: bool,
) -> ToolOutcome {
    // Prefer daemon-aware check (`docker info`), same as checks.rs.
    if let Some(access) = probe_docker_access(exec) {
        let version = match access {
            DockerAccess::Ambient => exec
                .run("docker", &["info"])
                .and_then(|output| {
                    output
                        .lines()
                        .find_map(|line| line.trim_start().strip_prefix("Server Version:"))
                        .map(|v| v.trim().to_string())
                })
                .unwrap_or_else(|| "daemon reachable".into()),
            DockerAccess::ViaSg => exec
                .run("sg", &["docker", "-c", "docker info"])
                .and_then(|output| {
                    output
                        .lines()
                        .find_map(|line| line.trim_start().strip_prefix("Server Version:"))
                        .map(|v| v.trim().to_string())
                })
                .unwrap_or_else(|| "daemon reachable via sg".into()),
        };
        let wsl_note = if platform.is_wsl {
            " (WSL — Docker Desktop socket OK)"
        } else {
            ""
        };
        let sg_note = if access == DockerAccess::ViaSg {
            " [session uses sg docker]"
        } else {
            ""
        };
        return ToolOutcome::Present(format!("{version}{wsl_note}{sg_note}"));
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
            let install_out = exec.run_output("sh", &["-c", install]);
            if !install_out.status_ok {
                return ToolOutcome::Failed(format!(
                    "get.docker.com install script failed: {}",
                    install_out.failure_detail()
                ));
            }

            let user = std::env::var("USER").unwrap_or_else(|_| "USER".into());
            let group_cmd = format!("sudo usermod -aG docker {user}");
            let _ = exec.run("sh", &["-c", &group_cmd]);

            // Try to start the service (may fail in WSL without systemd).
            let _ = exec.run("sudo", &["systemctl", "enable", "--now", "docker"]);

            match probe_docker_access(exec) {
                Some(DockerAccess::Ambient) => ToolOutcome::Installed(format!(
                    "Docker Engine installed. User `{user}` was added to the docker group."
                )),
                Some(DockerAccess::ViaSg) => ToolOutcome::Installed(format!(
                    "Docker Engine installed. User `{user}` was added to the docker group; this session will use `sg docker` until you log out/in (or `newgrp docker`)."
                )),
                None => ToolOutcome::Failed(format!(
                    "Docker Engine installed and user `{user}` added to the docker group, but the daemon is not reachable in this session. Log out and back in (or `newgrp docker`), verify with `docker info`, then re-run with --start."
                )),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
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

    #[test]
    fn probe_prefers_ambient_then_sg() {
        struct Seq {
            calls: RefCell<Vec<(String, Vec<String>)>>,
            docker_info: bool,
            sg_info: bool,
        }
        impl CommandExecutor for Seq {
            fn run(&self, program: &str, args: &[&str]) -> Option<String> {
                self.calls.borrow_mut().push((
                    program.to_string(),
                    args.iter().map(|a| a.to_string()).collect(),
                ));
                match (program, args) {
                    ("docker", ["info"]) if self.docker_info => Some("ok".into()),
                    ("sg", ["docker", "-c", "docker info"]) if self.sg_info => Some("ok".into()),
                    _ => None,
                }
            }
        }
        let ambient = Seq {
            calls: RefCell::new(Vec::new()),
            docker_info: true,
            sg_info: false,
        };
        assert_eq!(probe_docker_access(&ambient), Some(DockerAccess::Ambient));

        let via_sg = Seq {
            calls: RefCell::new(Vec::new()),
            docker_info: false,
            sg_info: true,
        };
        assert_eq!(probe_docker_access(&via_sg), Some(DockerAccess::ViaSg));

        let none = Seq {
            calls: RefCell::new(Vec::new()),
            docker_info: false,
            sg_info: false,
        };
        assert_eq!(probe_docker_access(&none), None);
    }

    #[test]
    fn run_docker_via_sg_wraps_cmdline() {
        struct Rec {
            calls: RefCell<Vec<(String, Vec<String>)>>,
        }
        impl CommandExecutor for Rec {
            fn run(&self, program: &str, args: &[&str]) -> Option<String> {
                self.calls.borrow_mut().push((
                    program.to_string(),
                    args.iter().map(|a| a.to_string()).collect(),
                ));
                Some(String::new())
            }
        }
        let exec = Rec {
            calls: RefCell::new(Vec::new()),
        };
        let _ = run_docker(
            &exec,
            DockerAccess::ViaSg,
            &["compose", "--project-directory", "/repo", "up", "-d"],
        );
        let calls = exec.calls.borrow();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "sg");
        assert_eq!(calls[0].1[0], "docker");
        assert_eq!(calls[0].1[1], "-c");
        assert_eq!(
            calls[0].1[2],
            "docker compose --project-directory /repo up -d"
        );
    }

    #[test]
    fn shell_join_quotes_spaces() {
        assert_eq!(shell_join(&["a", "b c"]), "a 'b c'");
    }
}
