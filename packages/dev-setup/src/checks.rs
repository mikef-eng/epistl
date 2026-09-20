//! Detect-only reporting for the core tools README's "Running the stack
//! locally" section requires: rustup, cargo/rustc, node, moon, docker,
//! sccache. Actually installing/upgrading any of these is out of scope
//! for this issue (see follow-up, OS-specific issues).
//!
//! All detection goes through the `CommandExecutor` trait below rather
//! than shelling out directly, so unit tests can substitute a fake
//! executor instead of depending on the real `PATH` of whatever machine
//! runs `cargo test`.

use std::process::Command;

/// Full result of a command invocation, including stderr on failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutput {
    pub status_ok: bool,
    pub stdout: String,
    pub stderr: String,
}

impl CommandOutput {
    /// Prefer stderr, then stdout, for failure diagnostics.
    pub fn failure_detail(&self) -> String {
        let err = self.stderr.trim();
        if !err.is_empty() {
            return err.to_string();
        }
        let out = self.stdout.trim();
        if !out.is_empty() {
            return out.to_string();
        }
        "no output".to_string()
    }

    /// Trimmed stdout, or stderr if stdout is empty (same as successful `run`).
    pub fn text(&self) -> String {
        let stdout = self.stdout.trim();
        if !stdout.is_empty() {
            stdout.to_string()
        } else {
            self.stderr.trim().to_string()
        }
    }

    fn success_text(&self) -> String {
        self.text()
    }
}

/// Runs an external command and reports whether it succeeded, abstracting
/// over the real `PATH` lookup so tests can inject canned
/// present/absent/version responses instead.
pub trait CommandExecutor {
    /// Runs `program args...`. Returns `Some(trimmed_stdout)` if the
    /// program was found on `PATH` and exited successfully, `None`
    /// otherwise (not found, or a non-zero exit).
    fn run(&self, program: &str, args: &[&str]) -> Option<String>;

    /// Like [`run`](Self::run), but keeps stdout/stderr and exit status so
    /// callers can surface failure diagnostics. Default maps from [`run`]
    /// (empty stderr on failure); real executors override this.
    fn run_output(&self, program: &str, args: &[&str]) -> CommandOutput {
        match self.run(program, args) {
            Some(stdout) => CommandOutput {
                status_ok: true,
                stdout,
                stderr: String::new(),
            },
            None => CommandOutput {
                status_ok: false,
                stdout: String::new(),
                stderr: String::new(),
            },
        }
    }
}

/// The real executor, backed by `std::process::Command` /
/// the actual system `PATH`.
pub struct SystemExecutor;

impl CommandExecutor for SystemExecutor {
    fn run(&self, program: &str, args: &[&str]) -> Option<String> {
        let output = self.run_output(program, args);
        if output.status_ok {
            Some(output.success_text())
        } else {
            None
        }
    }

    fn run_output(&self, program: &str, args: &[&str]) -> CommandOutput {
        match Command::new(program).args(args).output() {
            Ok(output) => CommandOutput {
                status_ok: output.status.success(),
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            },
            Err(e) => CommandOutput {
                status_ok: false,
                stdout: String::new(),
                stderr: e.to_string(),
            },
        }
    }
}

/// Whether a tool was found, and its version string if one was available.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolStatus {
    Present(Option<String>),
    Absent,
}

impl ToolStatus {
    pub fn is_present(&self) -> bool {
        matches!(self, ToolStatus::Present(_))
    }
}

/// One line of the final report: a human-readable tool name plus its
/// detected status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCheck {
    pub name: &'static str,
    pub status: ToolStatus,
}

/// Whether this check's absence alone should fail the overall exit
/// status. All core tools including sccache are required (sccache is
/// enforced by `.cargo/config.toml`'s `rustc-wrapper`).
pub fn is_required(_name: &str) -> bool {
    true
}

fn check_simple_tool(
    exec: &dyn CommandExecutor,
    name: &'static str,
    program: &str,
    version_args: &[&str],
) -> ToolCheck {
    let status = match exec.run(program, version_args) {
        Some(version) if !version.is_empty() => ToolStatus::Present(Some(version)),
        Some(_) => ToolStatus::Present(None),
        None => ToolStatus::Absent,
    };
    ToolCheck { name, status }
}

pub fn check_rustup(exec: &dyn CommandExecutor) -> ToolCheck {
    check_simple_tool(exec, "rustup", "rustup", &["--version"])
}

/// `cargo`/`rustc` are reported as a single "toolchain" line: both must be
/// found for it to count as Present, matching the issue's "rustup +
/// toolchain" pairing in the overall exit-status requirement.
pub fn check_toolchain(exec: &dyn CommandExecutor) -> ToolCheck {
    let cargo_version = exec.run("cargo", &["--version"]);
    let rustc_version = exec.run("rustc", &["--version"]);
    let status = match (cargo_version, rustc_version) {
        (Some(cargo_version), Some(rustc_version)) => {
            ToolStatus::Present(Some(format!("{cargo_version}; {rustc_version}")))
        }
        _ => ToolStatus::Absent,
    };
    ToolCheck {
        name: "cargo/rustc",
        status,
    }
}

pub fn check_node(exec: &dyn CommandExecutor) -> ToolCheck {
    check_simple_tool(exec, "node", "node", &["--version"])
}

pub fn check_moon(exec: &dyn CommandExecutor) -> ToolCheck {
    check_simple_tool(exec, "moon", "moon", &["--version"])
}

/// Checked via `docker info` (not just `docker --version`) so a
/// present-but-not-running daemon is distinguished from an absent
/// binary: `docker --version` succeeds even with the daemon down, but
/// `docker info` only succeeds once the daemon actually answers.
pub fn check_docker(exec: &dyn CommandExecutor) -> ToolCheck {
    let status = match exec.run("docker", &["info"]) {
        Some(output) => {
            let version = output
                .lines()
                .find_map(|line| line.trim_start().strip_prefix("Server Version:"))
                .map(|v| v.trim().to_string());
            ToolStatus::Present(version)
        }
        None => ToolStatus::Absent,
    };
    ToolCheck {
        name: "docker",
        status,
    }
}

pub fn check_sccache(exec: &dyn CommandExecutor) -> ToolCheck {
    check_simple_tool(exec, "sccache", "sccache", &["--version"])
}

/// Runs every check in report order.
pub fn run_all_checks(exec: &dyn CommandExecutor) -> Vec<ToolCheck> {
    vec![
        check_rustup(exec),
        check_toolchain(exec),
        check_node(exec),
        check_moon(exec),
        check_docker(exec),
        check_sccache(exec),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// A canned executor: `responses` maps a program name to the output
    /// it should "return" as found; a program with no entry is reported
    /// absent, same as a real `PATH` miss.
    struct FakeExecutor {
        responses: HashMap<&'static str, &'static str>,
    }

    impl FakeExecutor {
        fn new(responses: &[(&'static str, &'static str)]) -> Self {
            FakeExecutor {
                responses: responses.iter().copied().collect(),
            }
        }
    }

    impl CommandExecutor for FakeExecutor {
        fn run(&self, program: &str, _args: &[&str]) -> Option<String> {
            self.responses.get(program).map(|s| s.to_string())
        }
    }

    #[test]
    fn reports_present_with_version_when_found() {
        let exec = FakeExecutor::new(&[("rustup", "rustup 1.27.1")]);
        let check = check_rustup(&exec);
        assert_eq!(
            check.status,
            ToolStatus::Present(Some("rustup 1.27.1".to_string()))
        );
    }

    #[test]
    fn reports_absent_when_not_found() {
        let exec = FakeExecutor::new(&[]);
        let check = check_rustup(&exec);
        assert_eq!(check.status, ToolStatus::Absent);
    }

    #[test]
    fn toolchain_requires_both_cargo_and_rustc() {
        let both = FakeExecutor::new(&[("cargo", "cargo 1.82.0"), ("rustc", "rustc 1.82.0")]);
        assert!(check_toolchain(&both).status.is_present());

        let cargo_only = FakeExecutor::new(&[("cargo", "cargo 1.82.0")]);
        assert_eq!(check_toolchain(&cargo_only).status, ToolStatus::Absent);

        let neither = FakeExecutor::new(&[]);
        assert_eq!(check_toolchain(&neither).status, ToolStatus::Absent);
    }

    #[test]
    fn node_present_and_absent() {
        let exec = FakeExecutor::new(&[("node", "v22.4.0")]);
        assert!(check_node(&exec).status.is_present());

        let exec = FakeExecutor::new(&[]);
        assert_eq!(check_node(&exec).status, ToolStatus::Absent);
    }

    #[test]
    fn moon_present_and_absent() {
        let exec = FakeExecutor::new(&[("moon", "moon 1.30.0")]);
        assert!(check_moon(&exec).status.is_present());

        let exec = FakeExecutor::new(&[]);
        assert_eq!(check_moon(&exec).status, ToolStatus::Absent);
    }

    #[test]
    fn sccache_present_and_absent() {
        let exec = FakeExecutor::new(&[("sccache", "sccache 0.18.0")]);
        assert!(check_sccache(&exec).status.is_present());

        let exec = FakeExecutor::new(&[]);
        assert_eq!(check_sccache(&exec).status, ToolStatus::Absent);
    }

    #[test]
    fn docker_present_extracts_server_version() {
        let exec = FakeExecutor::new(&[(
            "docker",
            "Client:\n Version: 27.0.3\nServer:\n Server Version: 27.0.3\n Storage Driver: overlay2\n",
        )]);
        let check = check_docker(&exec);
        assert_eq!(
            check.status,
            ToolStatus::Present(Some("27.0.3".to_string()))
        );
    }

    #[test]
    fn docker_absent_when_binary_or_daemon_unreachable() {
        // `FakeExecutor` returning `None` here stands in for both an
        // absent `docker` binary *and* a present-but-not-running daemon:
        // in both cases `docker info` (unlike `docker --version`) fails,
        // which is exactly why `check_docker` runs `info`, not
        // `--version`.
        let exec = FakeExecutor::new(&[]);
        assert_eq!(check_docker(&exec).status, ToolStatus::Absent);
    }

    /// An executor whose response depends on the *args*, not just the
    /// program name -- unlike `FakeExecutor` above. Needed to actually
    /// prove `check_docker` calls `docker info` (daemon-aware) rather than
    /// `docker --version` (which succeeds even with the daemon down):
    /// `FakeExecutor` alone can't distinguish those two call sites since
    /// it ignores `args` entirely.
    struct DaemonDownExecutor;

    impl CommandExecutor for DaemonDownExecutor {
        fn run(&self, program: &str, args: &[&str]) -> Option<String> {
            match (program, args) {
                ("docker", ["--version"]) => {
                    Some("Docker version 27.0.3, build abc1234".to_string())
                }
                ("docker", ["info"]) => None,
                _ => None,
            }
        }
    }

    #[test]
    fn docker_reports_absent_when_daemon_is_down_even_though_the_binary_is_present() {
        // `docker --version` would succeed here (binary present), but
        // `check_docker` must still report `Absent` because it checks
        // `docker info`, which fails while the daemon isn't running. This
        // is the concrete behavior the "info, not --version" distinction
        // in the issue's acceptance criteria is for.
        let check = check_docker(&DaemonDownExecutor);
        assert_eq!(check.status, ToolStatus::Absent);
    }

    #[test]
    fn all_core_tools_are_required_including_sccache() {
        assert!(is_required("rustup"));
        assert!(is_required("cargo/rustc"));
        assert!(is_required("node"));
        assert!(is_required("moon"));
        assert!(is_required("docker"));
        assert!(is_required("sccache"));
    }

    #[test]
    fn failure_detail_prefers_stderr() {
        let out = CommandOutput {
            status_ok: false,
            stdout: "stdout noise".into(),
            stderr: "permission denied".into(),
        };
        assert_eq!(out.failure_detail(), "permission denied");
        let empty = CommandOutput {
            status_ok: false,
            stdout: String::new(),
            stderr: String::new(),
        };
        assert_eq!(empty.failure_detail(), "no output");
    }
}
