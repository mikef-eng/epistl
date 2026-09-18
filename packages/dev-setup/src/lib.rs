//! Library half of the `dev-setup` binary crate (issue #203): a
//! contributor/agent-facing tool that checks a macOS/Linux dev machine
//! against what README's "Running the stack locally" section requires.
//! Logic lives here (not in `main.rs`) so it's unit-testable without
//! spawning the real binary.

pub mod checks;
pub mod env_file;
pub mod os_check;

use std::path::{Path, PathBuf};

pub use checks::{
    check_docker, check_moon, check_node, check_rustup, check_sccache, check_toolchain,
    is_required, run_all_checks, CommandExecutor, SystemExecutor, ToolCheck, ToolStatus,
};
pub use env_file::{ensure_env_file, EnvFileOutcome};
pub use os_check::check_os;

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
}
