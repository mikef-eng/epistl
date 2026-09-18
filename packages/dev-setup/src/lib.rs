//! Library half of the `dev-setup` binary crate (issue #203): a
//! contributor/agent-facing tool that checks a macOS/Linux dev machine
//! against what README's "Running the stack locally" section requires.
//! Logic lives here (not in `main.rs`) so it's unit-testable without
//! spawning the real binary.

pub mod checks;
pub mod env_file;
pub mod linux_install;
pub mod os_check;
pub mod start;

use std::path::{Path, PathBuf};

pub use checks::{
    check_docker, check_moon, check_node, check_rustup, check_sccache, check_toolchain,
    is_required, run_all_checks, CommandExecutor, SystemExecutor, ToolCheck, ToolStatus,
};
pub use env_file::{ensure_env_file, EnvFileOutcome};
pub use linux_install::{
    apt_available, docker_action, format_linux_action, moon_action, node_action, rustup_action,
    sccache_action, LinuxAction,
};
pub use os_check::check_os;
pub use start::{format_step_outcome, maybe_run_start, RealSleeper, Sleeper, StepOutcome};

/// Whether `checks` reports `name` as `Present` -- used by `--start` to
/// decide whether Docker/moon are available before attempting to shell
/// out to either, reusing the environment-check report rather than
/// re-probing.
pub fn check_status(checks: &[ToolCheck], name: &str) -> bool {
    checks
        .iter()
        .find(|check| check.name == name)
        .map(|check| check.status.is_present())
        .unwrap_or(false)
}

/// Whether `--install` was passed on the command line -- the opt-in gate
/// for the Linux (apt-based) auto-install path this issue adds. Takes
/// `args` as a parameter (rather than reading `std::env::args()` itself)
/// so tests can inject arg vectors directly instead of depending on how
/// the test binary itself was invoked.
pub fn has_install_flag<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().any(|a| a.as_ref() == "--install")
}

/// The repo root, derived from where this crate lives on disk
/// (`packages/dev-setup`) rather than the process's current working
/// directory -- so this works whether the binary is invoked via `moon run
/// dev-setup:run` (project-rooted) or `cargo run` from within
/// `packages/dev-setup` directly.
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("packages/dev-setup is expected to be nested two directories under the repo root")
        .to_path_buf()
}

/// Formats one `ToolCheck` as a single report line, e.g.
/// `"rustup: Present (rustup 1.27.1)"` or `"docker: Absent"`.
pub fn format_check_line(check: &ToolCheck) -> String {
    match &check.status {
        ToolStatus::Present(Some(version)) => format!("{}: Present ({version})", check.name),
        ToolStatus::Present(None) => format!("{}: Present", check.name),
        ToolStatus::Absent => format!("{}: Absent", check.name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_root_points_at_the_actual_repo_root() {
        let root = repo_root();
        assert!(root.join("Cargo.toml").is_file());
        assert!(root.join(".env.example").is_file());
        assert!(root.join("packages/dev-setup/Cargo.toml").is_file());
    }

    #[test]
    fn format_check_line_variants() {
        let present_with_version = ToolCheck {
            name: "rustup",
            status: ToolStatus::Present(Some("rustup 1.27.1".to_string())),
        };
        assert_eq!(
            format_check_line(&present_with_version),
            "rustup: Present (rustup 1.27.1)"
        );

        let present_no_version = ToolCheck {
            name: "docker",
            status: ToolStatus::Present(None),
        };
        assert_eq!(format_check_line(&present_no_version), "docker: Present");

        let absent = ToolCheck {
            name: "sccache",
            status: ToolStatus::Absent,
        };
        assert_eq!(format_check_line(&absent), "sccache: Absent");
    }

    #[test]
    fn has_install_flag_detects_the_flag_among_other_args() {
        assert!(has_install_flag(["dev-setup", "--install"]));
        assert!(!has_install_flag(["dev-setup"]));
        assert!(!has_install_flag(["dev-setup", "--other-flag"]));
    }

    #[test]
    fn check_status_variants() {
        let checks = vec![
            ToolCheck {
                name: "docker",
                status: ToolStatus::Present(None),
            },
            ToolCheck {
                name: "moon",
                status: ToolStatus::Absent,
            },
        ];

        assert!(check_status(&checks, "docker"));
        assert!(!check_status(&checks, "moon"));
        // A name that isn't in the report at all is treated as absent,
        // not a panic.
        assert!(!check_status(&checks, "sccache"));
    }
}
