//! Docker Engine / Docker Desktop detection and Linux install.

use crate::checks::{CommandExecutor, CommandOutput};
use crate::pkg::{install_packages, PackageSpec};
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

/// Whether `sg` (symlink to `newgrp`) is on PATH.
///
/// On recent Ubuntu/Debian this binary ships in `util-linux-extra`, which is
/// not always installed by default — without it, same-session docker-group
/// activation (`sg docker` / `newgrp docker`) cannot work.
pub fn sg_on_path(exec: &dyn CommandExecutor) -> bool {
    exec.run("bash", &["-c", "command -v sg"])
        .is_some_and(|s| !s.trim().is_empty())
}

/// Install `sg`/`newgrp` if missing (apt: `util-linux-extra`; rpm/arch: `util-linux`).
pub fn ensure_sg_available(platform: &Platform, exec: &dyn CommandExecutor) -> Result<(), String> {
    if sg_on_path(exec) {
        return Ok(());
    }
    if platform.os != OsKind::Linux {
        return Ok(());
    }
    install_packages(
        platform,
        exec,
        &PackageSpec {
            apt: &["util-linux-extra"],
            dnf: &["util-linux"],
            pacman: &["util-linux"],
            brew: &[],
            brew_cask: &[],
        },
    )?;
    if sg_on_path(exec) {
        Ok(())
    } else {
        Err(
            "`sg`/`newgrp` still missing after package install (need util-linux-extra on Ubuntu)"
                .into(),
        )
    }
}

/// Probe whether Docker is reachable ambiently or only via `sg docker`.
pub fn probe_docker_access(exec: &dyn CommandExecutor) -> Option<DockerAccess> {
    if exec.run("docker", &["info"]).is_some() {
        return Some(DockerAccess::Ambient);
    }
    if !sg_on_path(exec) {
        return None;
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

fn present_message(platform: &Platform, access: DockerAccess, version: String) -> String {
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
    format!("{version}{wsl_note}{sg_note}")
}

fn version_from_info(output: &str, fallback: &str) -> String {
    output
        .lines()
        .find_map(|line| line.trim_start().strip_prefix("Server Version:"))
        .map(|v| v.trim().to_string())
        .unwrap_or_else(|| fallback.into())
}

pub fn ensure_docker(
    platform: &Platform,
    exec: &dyn CommandExecutor,
    policy: &PromptPolicy,
    check_only: bool,
) -> ToolOutcome {
    if let Some(outcome) = try_present(platform, exec) {
        return outcome;
    }

    // Ambient failed. On Linux, install `sg`/`newgrp` if needed and re-probe
    // before treating Docker as missing (avoids reinstall when only the
    // group-switch tool was absent).
    if !check_only && platform.os == OsKind::Linux && ensure_sg_available(platform, exec).is_ok() {
        if let Some(outcome) = try_present(platform, exec) {
            return outcome;
        }
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
            let question = if platform.is_wsl {
                "Docker daemon not reachable in WSL. Install Docker Engine via get.docker.com? (prefer enabling Docker Desktop WSL integration if you use Desktop)"
            } else {
                "Docker missing. Install via get.docker.com and add your user to the docker group?"
            };

            if !confirm_required(policy, question) {
                return ToolOutcome::Skipped("user declined Docker install".into());
            }

            // Need sg/newgrp before post-install same-session probe.
            if let Err(e) = ensure_sg_available(platform, exec) {
                return ToolOutcome::Failed(format!(
                    "need `sg`/`newgrp` for same-session docker group access: {e}"
                ));
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
                None => {
                    let sg_hint = if sg_on_path(exec) {
                        "Log out and back in (or `newgrp docker`)"
                    } else {
                        "Install util-linux-extra (provides `sg`/`newgrp`), then log out and back in"
                    };
                    ToolOutcome::Failed(format!(
                        "Docker Engine installed and user `{user}` added to the docker group, but the daemon is not reachable in this session. {sg_hint}, verify with `docker info`, then re-run with --start."
                    ))
                }
            }
        }
    }
}

fn try_present(platform: &Platform, exec: &dyn CommandExecutor) -> Option<ToolOutcome> {
    let access = probe_docker_access(exec)?;
    let version = match access {
        DockerAccess::Ambient => exec
            .run("docker", &["info"])
            .map(|o| version_from_info(&o, "daemon reachable"))
            .unwrap_or_else(|| "daemon reachable".into()),
        DockerAccess::ViaSg => exec
            .run("sg", &["docker", "-c", "docker info"])
            .map(|o| version_from_info(&o, "daemon reachable via sg"))
            .unwrap_or_else(|| "daemon reachable via sg".into()),
    };
    Some(ToolOutcome::Present(present_message(
        platform, access, version,
    )))
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
            sg_present: bool,
        }
        impl CommandExecutor for Seq {
            fn run(&self, program: &str, args: &[&str]) -> Option<String> {
                self.calls.borrow_mut().push((
                    program.to_string(),
                    args.iter().map(|a| a.to_string()).collect(),
                ));
                match (program, args) {
                    ("docker", ["info"]) if self.docker_info => Some("ok".into()),
                    ("bash", ["-c", "command -v sg"]) if self.sg_present => {
                        Some("/usr/bin/sg".into())
                    }
                    ("sg", ["docker", "-c", "docker info"]) if self.sg_info => Some("ok".into()),
                    _ => None,
                }
            }
        }
        let ambient = Seq {
            calls: RefCell::new(Vec::new()),
            docker_info: true,
            sg_info: false,
            sg_present: false,
        };
        assert_eq!(probe_docker_access(&ambient), Some(DockerAccess::Ambient));

        let via_sg = Seq {
            calls: RefCell::new(Vec::new()),
            docker_info: false,
            sg_info: true,
            sg_present: true,
        };
        assert_eq!(probe_docker_access(&via_sg), Some(DockerAccess::ViaSg));

        let no_sg = Seq {
            calls: RefCell::new(Vec::new()),
            docker_info: false,
            sg_info: true,
            sg_present: false,
        };
        assert_eq!(probe_docker_access(&no_sg), None);

        let none = Seq {
            calls: RefCell::new(Vec::new()),
            docker_info: false,
            sg_info: false,
            sg_present: true,
        };
        assert_eq!(probe_docker_access(&none), None);
    }

    #[test]
    fn ensure_sg_installs_util_linux_extra_on_apt_when_missing() {
        struct Rec {
            calls: RefCell<Vec<String>>,
            sg_after_install: RefCell<bool>,
        }
        impl CommandExecutor for Rec {
            fn run(&self, program: &str, args: &[&str]) -> Option<String> {
                let key = format!("{program} {}", args.join(" "));
                self.calls.borrow_mut().push(key);
                if program == "bash" && args == ["-c", "command -v sg"] {
                    if *self.sg_after_install.borrow() {
                        return Some("/usr/bin/sg".into());
                    }
                    return None;
                }
                if program == "sudo" && args.first() == Some(&"apt-get") {
                    if args.contains(&"util-linux-extra") {
                        *self.sg_after_install.borrow_mut() = true;
                    }
                    return Some(String::new());
                }
                Some(String::new())
            }
        }
        let exec = Rec {
            calls: RefCell::new(Vec::new()),
            sg_after_install: RefCell::new(false),
        };
        let platform = Platform {
            os: OsKind::Linux,
            arch: "x86_64".into(),
            distro: Some(crate::platform::DistroFamily::Apt),
            is_wsl: false,
            home: PathBuf::from("/home/dev"),
        };
        ensure_sg_available(&platform, &exec).unwrap();
        let joined = exec.calls.borrow().join("\n");
        assert!(joined.contains("util-linux-extra"));
        assert!(sg_on_path(&exec));
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
