//! Library half of the `dev-setup` binary (issues #222–#224): interactive
//! installer + detect-only checker for Epistl's local toolchain.

pub mod checks;
pub mod env_file;
pub mod environment;
pub mod flags;
pub mod pkg;
pub mod platform;
pub mod profile;
pub mod prompt;
pub mod start;
pub mod tools;

use std::path::{Path, PathBuf};

pub use checks::{
    check_docker, check_moon, check_node, check_rustup, check_sccache, check_toolchain,
    is_required, run_all_checks, CommandExecutor, CommandOutput, SystemExecutor, ToolCheck,
    ToolStatus,
};
pub use env_file::{ensure_env_file, ensure_env_files, EnvBootstrap, EnvFileOutcome};
pub use environment::{Environment, SystemEnvironment};
pub use flags::Flags;
pub use platform::{DistroFamily, OsKind, Platform};
pub use prompt::PromptPolicy;
pub use start::{format_step_outcome, maybe_run_start, RealSleeper, Sleeper, StepOutcome};
pub use tools::{format_outcome, ToolOutcome};

/// Whether `checks` reports `name` as Present.
pub fn check_status(checks: &[ToolCheck], name: &str) -> bool {
    checks
        .iter()
        .find(|check| check.name == name)
        .map(|check| check.status.is_present())
        .unwrap_or(false)
}

/// The repo root, derived from this crate's manifest location.
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("packages/dev-setup is expected to be nested two directories under the repo root")
        .to_path_buf()
}

/// Formats one `ToolCheck` as a single report line.
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
        assert!(!check_status(&checks, "sccache"));
    }
}
