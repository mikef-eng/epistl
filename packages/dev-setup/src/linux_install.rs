//! Linux-specific auto-install logic (issue #205).
//!
//! Gated by `apt`/`apt-get` presence as a documented heuristic for
//! "Debian/Ubuntu-family" -- not a hard distro-ID check. When apt is
//! present and `--install` is passed, rustup, moon, and sccache are
//! installed (if absent) via their official non-interactive installers.
//! Node.js and Docker are always guide-only on Linux, with or without
//! `--install`, on any distro. Any non-apt distro falls back to
//! guide-only for all five tools rather than attempting distro-specific
//! branching this tool can't maintain -- see the issue's "Out of scope".
//!
//! Only triggered from `main.rs` when `std::env::consts::OS == "linux"`;
//! nothing here changes macOS behavior.

use crate::checks::CommandExecutor;

/// rustup's own official non-interactive installer script.
pub const RUSTUP_INSTALL_CMD: &str =
    "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y";

/// moon's own official installer script.
pub const MOON_INSTALL_CMD: &str = "curl -fsSL https://moonrepo.dev/install/moon.sh | bash";

/// sccache has no shell-script installer; it ships as a crate, and this
/// repo already requires the Rust toolchain, so `cargo install` is its
/// "official installer" equivalent here.
pub const SCCACHE_INSTALL_CMD: &str = "cargo install sccache --locked";

pub const NODE_INSTALL_DOCS_URL: &str = "https://nodejs.org/en/download";
pub const DOCKER_INSTALL_DOCS_URL: &str = "https://docs.docker.com/engine/install/";

const UNRECOGNIZED_PACKAGE_MANAGER_REASON: &str =
    "apt/apt-get not found (unrecognized/unsupported package manager)";

/// Whether `apt`/`apt-get` is present on this machine -- the marker this
/// tool uses to gate the Linux auto-install path. Checked via `--version`
/// through the same `CommandExecutor` abstraction as every other tool
/// check, so tests never depend on the real `PATH`.
pub fn apt_available(exec: &dyn CommandExecutor) -> bool {
    exec.run("apt-get", &["--version"]).is_some() || exec.run("apt", &["--version"]).is_some()
}

/// What this tool recommends (or already did) for one absent tool on
/// Linux. Only meaningful for tools `checks.rs` reports `Absent`; present
/// tools have nothing to report here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinuxAction {
    /// `--install` was passed, apt is present, and the installer command
    /// ran successfully.
    Installed,
    /// `--install` was passed, apt is present, but the installer command
    /// itself failed (non-zero exit / not found).
    InstallFailed,
    /// apt is present, but a prerequisite is also absent, so nothing was
    /// attempted (currently only sccache depending on rustup/cargo).
    BlockedOn(&'static str),
    /// apt is present, but `--install` wasn't passed: this is the command
    /// that would run instead -- same disclosure pattern as the macOS
    /// `brew install` behavior.
    WouldRun(&'static str),
    /// This tool is never auto-installed on Linux (Node.js, Docker), or
    /// apt itself isn't present: where to go instead, and why.
    GuideOnly(String),
}

/// Decides (and, when appropriate, runs) the action for rustup.
pub fn rustup_action(
    exec: &dyn CommandExecutor,
    apt_present: bool,
    install_flag: bool,
) -> LinuxAction {
    if !apt_present {
        return LinuxAction::GuideOnly(format!(
            "{UNRECOGNIZED_PACKAGE_MANAGER_REASON}; install rustup yourself: https://rustup.rs"
        ));
    }
    if !install_flag {
        return LinuxAction::WouldRun(RUSTUP_INSTALL_CMD);
    }
    match exec.run("sh", &["-c", RUSTUP_INSTALL_CMD]) {
        Some(_) => LinuxAction::Installed,
        None => LinuxAction::InstallFailed,
    }
}

/// Decides (and, when appropriate, runs) the action for moon.
pub fn moon_action(
    exec: &dyn CommandExecutor,
    apt_present: bool,
    install_flag: bool,
) -> LinuxAction {
    if !apt_present {
        return LinuxAction::GuideOnly(format!(
            "{UNRECOGNIZED_PACKAGE_MANAGER_REASON}; install moon yourself: https://moonrepo.dev/docs/install"
        ));
    }
    if !install_flag {
        return LinuxAction::WouldRun(MOON_INSTALL_CMD);
    }
    match exec.run("bash", &["-c", MOON_INSTALL_CMD]) {
        Some(_) => LinuxAction::Installed,
        None => LinuxAction::InstallFailed,
    }
}

/// Decides (and, when appropriate, runs) the action for sccache. Checks
/// `cargo`'s own presence internally (via the same `exec`) rather than
/// taking it as a parameter, since sccache installs via `cargo install`
/// and is blocked -- not attempted -- when cargo/rustup is absent.
pub fn sccache_action(
    exec: &dyn CommandExecutor,
    apt_present: bool,
    install_flag: bool,
) -> LinuxAction {
    if !apt_present {
        return LinuxAction::GuideOnly(format!(
            "{UNRECOGNIZED_PACKAGE_MANAGER_REASON}; install sccache yourself: https://github.com/mozilla/sccache#installation"
        ));
    }
    let cargo_present = exec.run("cargo", &["--version"]).is_some();
    if !cargo_present {
        return LinuxAction::BlockedOn("rustup");
    }
    if !install_flag {
        return LinuxAction::WouldRun(SCCACHE_INSTALL_CMD);
    }
    match exec.run("cargo", &["install", "sccache", "--locked"]) {
        Some(_) => LinuxAction::Installed,
        None => LinuxAction::InstallFailed,
    }
}

/// Node.js is always guide-only on Linux, apt-based distro or not, with
/// or without `--install`.
pub fn node_action(apt_present: bool) -> LinuxAction {
    LinuxAction::GuideOnly(guide_only_message(
        apt_present,
        "Node.js",
        NODE_INSTALL_DOCS_URL,
    ))
}

/// Docker is always guide-only on Linux, apt-based distro or not, with or
/// without `--install`.
pub fn docker_action(apt_present: bool) -> LinuxAction {
    LinuxAction::GuideOnly(guide_only_message(
        apt_present,
        "Docker",
        DOCKER_INSTALL_DOCS_URL,
    ))
}

fn guide_only_message(apt_present: bool, tool_label: &str, docs_url: &str) -> String {
    if apt_present {
        format!("install {tool_label} yourself: {docs_url}")
    } else {
        format!("{UNRECOGNIZED_PACKAGE_MANAGER_REASON}; install {tool_label} yourself: {docs_url}")
    }
}

/// Formats one `LinuxAction` as a single report line, for printing
/// alongside (below) the normal `ToolCheck` report line for the same
/// tool.
pub fn format_linux_action(name: &str, action: &LinuxAction) -> String {
    match action {
        LinuxAction::Installed => format!("  -> {name}: installed via --install"),
        LinuxAction::InstallFailed => {
            format!("  -> {name}: --install attempted but the installer failed; try the command yourself")
        }
        LinuxAction::BlockedOn(dep) => {
            format!("  -> {name}: blocked on {dep} (install {dep} first, then retry)")
        }
        LinuxAction::WouldRun(cmd) => {
            format!("  -> {name}: re-run with --install to run this, or run it yourself: {cmd}")
        }
        LinuxAction::GuideOnly(msg) => format!("  -> {name}: {msg}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// A canned executor: `responses` maps `(program, args)` to whether
    /// that exact invocation should "succeed" (mirroring `checks.rs`'s
    /// `FakeExecutor`, but keyed on args too since install commands are
    /// distinguished by their args, e.g. `apt-get --version` vs.
    /// `apt --version`). The real installer scripts are never invoked --
    /// this executor never shells out to anything.
    struct FakeExecutor {
        // Maps program name to whether it should be reported present.
        present: HashMap<&'static str, bool>,
    }

    impl FakeExecutor {
        fn new(present: &[&'static str]) -> Self {
            FakeExecutor {
                present: present.iter().map(|p| (*p, true)).collect(),
            }
        }
    }

    impl CommandExecutor for FakeExecutor {
        fn run(&self, program: &str, _args: &[&str]) -> Option<String> {
            if self.present.get(program).copied().unwrap_or(false) {
                Some(format!("{program} ok"))
            } else {
                None
            }
        }
    }

    /// Unlike `FakeExecutor` above (which ignores `args` and matches on
    /// program name alone), this executor only reports success for an
    /// *exact* `(program, args)` match, and records every call it
    /// receives. This is what actually proves the code invokes the
    /// official installer command verbatim (not just "some command named
    /// sh"/"some command named cargo"), and lets tests assert an install
    /// command was never invoked at all -- not just that the returned
    /// action happened to be the right enum variant.
    struct RecordingExecutor {
        allow: Vec<(&'static str, Vec<&'static str>)>,
        calls: std::cell::RefCell<Vec<(String, Vec<String>)>>,
    }

    impl RecordingExecutor {
        fn new(allow: Vec<(&'static str, Vec<&'static str>)>) -> Self {
            RecordingExecutor {
                allow,
                calls: std::cell::RefCell::new(Vec::new()),
            }
        }

        fn was_called_with(&self, program: &str, args: &[&str]) -> bool {
            self.calls.borrow().iter().any(|(p, a)| {
                p == program
                    && a.as_slice() == args.iter().map(|s| s.to_string()).collect::<Vec<_>>()
            })
        }
    }

    impl CommandExecutor for RecordingExecutor {
        fn run(&self, program: &str, args: &[&str]) -> Option<String> {
            self.calls.borrow_mut().push((
                program.to_string(),
                args.iter().map(|s| s.to_string()).collect(),
            ));
            let matched = self
                .allow
                .iter()
                .any(|(p, a)| *p == program && a.as_slice() == args);
            if matched {
                Some(format!("{program} ok"))
            } else {
                None
            }
        }
    }

    #[test]
    fn apt_available_true_when_apt_get_present() {
        let exec = FakeExecutor::new(&["apt-get"]);
        assert!(apt_available(&exec));
    }

    #[test]
    fn apt_available_true_when_only_apt_present() {
        let exec = FakeExecutor::new(&["apt"]);
        assert!(apt_available(&exec));
    }

    #[test]
    fn apt_available_false_when_neither_present() {
        let exec = FakeExecutor::new(&[]);
        assert!(!apt_available(&exec));
    }

    #[test]
    fn rustup_install_runs_when_apt_present_and_install_flag_set() {
        let exec = FakeExecutor::new(&["apt-get", "sh"]);
        let action = rustup_action(&exec, true, true);
        assert_eq!(action, LinuxAction::Installed);
    }

    #[test]
    fn rustup_install_reports_failure_when_installer_command_fails() {
        let exec = FakeExecutor::new(&["apt-get"]);
        let action = rustup_action(&exec, true, true);
        assert_eq!(action, LinuxAction::InstallFailed);
    }

    #[test]
    fn rustup_only_prints_command_without_install_flag() {
        let exec = FakeExecutor::new(&["apt-get", "sh"]);
        let action = rustup_action(&exec, true, false);
        assert_eq!(action, LinuxAction::WouldRun(RUSTUP_INSTALL_CMD));
    }

    #[test]
    fn rustup_never_runs_installer_when_install_flag_set_but_apt_absent() {
        let exec = FakeExecutor::new(&["sh"]);
        let action = rustup_action(&exec, false, true);
        assert!(matches!(action, LinuxAction::GuideOnly(_)));
    }

    #[test]
    fn rustup_guide_only_message_explains_unsupported_package_manager_when_apt_absent() {
        let exec = FakeExecutor::new(&["sh"]);
        let action = rustup_action(&exec, false, true);
        match action {
            LinuxAction::GuideOnly(msg) => {
                let lower = msg.to_lowercase();
                assert!(
                    lower.contains("unsupported") || lower.contains("unrecognized"),
                    "expected an unsupported/unrecognized package manager explanation, got: {msg}"
                );
                assert!(msg.contains("rustup.rs"));
            }
            other => panic!("expected GuideOnly, got {other:?}"),
        }
    }

    #[test]
    fn rustup_install_with_flag_invokes_the_exact_official_installer_command() {
        let exec = RecordingExecutor::new(vec![("sh", vec!["-c", RUSTUP_INSTALL_CMD])]);
        let action = rustup_action(&exec, true, true);
        assert_eq!(action, LinuxAction::Installed);
        assert!(exec.was_called_with("sh", &["-c", RUSTUP_INSTALL_CMD]));
    }

    #[test]
    fn rustup_would_run_without_install_flag_never_actually_invokes_the_installer() {
        let exec = RecordingExecutor::new(vec![("sh", vec!["-c", RUSTUP_INSTALL_CMD])]);
        let action = rustup_action(&exec, true, false);
        assert_eq!(action, LinuxAction::WouldRun(RUSTUP_INSTALL_CMD));
        assert!(
            exec.calls.borrow().is_empty(),
            "the installer must never run without --install, but got calls: {:?}",
            exec.calls.borrow()
        );
    }

    #[test]
    fn moon_install_runs_when_apt_present_and_install_flag_set() {
        let exec = FakeExecutor::new(&["apt-get", "bash"]);
        let action = moon_action(&exec, true, true);
        assert_eq!(action, LinuxAction::Installed);
    }

    #[test]
    fn moon_only_prints_command_without_install_flag() {
        let exec = FakeExecutor::new(&["apt-get", "bash"]);
        let action = moon_action(&exec, true, false);
        assert_eq!(action, LinuxAction::WouldRun(MOON_INSTALL_CMD));
    }

    #[test]
    fn moon_guide_only_when_apt_absent() {
        let exec = FakeExecutor::new(&["bash"]);
        let action = moon_action(&exec, false, true);
        assert!(matches!(action, LinuxAction::GuideOnly(_)));
    }

    #[test]
    fn moon_guide_only_message_explains_unsupported_package_manager_when_apt_absent() {
        let exec = FakeExecutor::new(&["bash"]);
        let action = moon_action(&exec, false, true);
        match action {
            LinuxAction::GuideOnly(msg) => {
                let lower = msg.to_lowercase();
                assert!(
                    lower.contains("unsupported") || lower.contains("unrecognized"),
                    "expected an unsupported/unrecognized package manager explanation, got: {msg}"
                );
                assert!(msg.contains("moonrepo.dev"));
            }
            other => panic!("expected GuideOnly, got {other:?}"),
        }
    }

    #[test]
    fn moon_install_with_flag_invokes_the_exact_official_installer_command() {
        let exec = RecordingExecutor::new(vec![("bash", vec!["-c", MOON_INSTALL_CMD])]);
        let action = moon_action(&exec, true, true);
        assert_eq!(action, LinuxAction::Installed);
        assert!(exec.was_called_with("bash", &["-c", MOON_INSTALL_CMD]));
    }

    #[test]
    fn moon_would_run_without_install_flag_never_actually_invokes_the_installer() {
        let exec = RecordingExecutor::new(vec![("bash", vec!["-c", MOON_INSTALL_CMD])]);
        let action = moon_action(&exec, true, false);
        assert_eq!(action, LinuxAction::WouldRun(MOON_INSTALL_CMD));
        assert!(
            exec.calls.borrow().is_empty(),
            "the installer must never run without --install, but got calls: {:?}",
            exec.calls.borrow()
        );
    }

    #[test]
    fn sccache_install_runs_when_apt_present_cargo_present_and_install_flag_set() {
        let exec = FakeExecutor::new(&["apt-get", "cargo"]);
        let action = sccache_action(&exec, true, true);
        assert_eq!(action, LinuxAction::Installed);
    }

    #[test]
    fn sccache_only_prints_command_without_install_flag() {
        let exec = FakeExecutor::new(&["apt-get", "cargo"]);
        let action = sccache_action(&exec, true, false);
        assert_eq!(action, LinuxAction::WouldRun(SCCACHE_INSTALL_CMD));
    }

    #[test]
    fn sccache_blocked_on_rustup_when_cargo_absent_even_with_install_flag() {
        let exec = FakeExecutor::new(&["apt-get"]);
        let action = sccache_action(&exec, true, true);
        assert_eq!(action, LinuxAction::BlockedOn("rustup"));
    }

    #[test]
    fn sccache_guide_only_when_apt_absent() {
        let exec = FakeExecutor::new(&["cargo"]);
        let action = sccache_action(&exec, false, true);
        assert!(matches!(action, LinuxAction::GuideOnly(_)));
    }

    #[test]
    fn sccache_guide_only_message_explains_unsupported_package_manager_when_apt_absent() {
        let exec = FakeExecutor::new(&["cargo"]);
        let action = sccache_action(&exec, false, true);
        match action {
            LinuxAction::GuideOnly(msg) => {
                let lower = msg.to_lowercase();
                assert!(
                    lower.contains("unsupported") || lower.contains("unrecognized"),
                    "expected an unsupported/unrecognized package manager explanation, got: {msg}"
                );
                assert!(msg.contains("github.com/mozilla/sccache"));
            }
            other => panic!("expected GuideOnly, got {other:?}"),
        }
    }

    #[test]
    fn sccache_install_with_flag_invokes_the_exact_official_installer_command() {
        let exec = RecordingExecutor::new(vec![
            ("cargo", vec!["--version"]),
            ("cargo", vec!["install", "sccache", "--locked"]),
        ]);
        let action = sccache_action(&exec, true, true);
        assert_eq!(action, LinuxAction::Installed);
        assert!(exec.was_called_with("cargo", &["install", "sccache", "--locked"]));
    }

    #[test]
    fn sccache_would_run_without_install_flag_never_actually_invokes_the_installer() {
        let exec = RecordingExecutor::new(vec![
            ("cargo", vec!["--version"]),
            ("cargo", vec!["install", "sccache", "--locked"]),
        ]);
        let action = sccache_action(&exec, true, false);
        assert_eq!(action, LinuxAction::WouldRun(SCCACHE_INSTALL_CMD));
        assert!(
            !exec.was_called_with("cargo", &["install", "sccache", "--locked"]),
            "the installer must never run without --install, but got calls: {:?}",
            exec.calls.borrow()
        );
    }

    #[test]
    fn node_is_always_guide_only_even_with_apt_present() {
        let action = node_action(true);
        match action {
            LinuxAction::GuideOnly(msg) => assert!(msg.contains(NODE_INSTALL_DOCS_URL)),
            other => panic!("expected GuideOnly, got {other:?}"),
        }
    }

    #[test]
    fn node_guide_only_message_explains_unsupported_package_manager_when_apt_absent() {
        let action = node_action(false);
        match action {
            LinuxAction::GuideOnly(msg) => {
                assert!(msg.contains(NODE_INSTALL_DOCS_URL));
                assert!(msg.to_lowercase().contains("unsupported"));
            }
            other => panic!("expected GuideOnly, got {other:?}"),
        }
    }

    #[test]
    fn docker_is_always_guide_only_even_with_apt_present() {
        let action = docker_action(true);
        match action {
            LinuxAction::GuideOnly(msg) => assert!(msg.contains(DOCKER_INSTALL_DOCS_URL)),
            other => panic!("expected GuideOnly, got {other:?}"),
        }
    }

    #[test]
    fn docker_guide_only_message_explains_unsupported_package_manager_when_apt_absent() {
        let action = docker_action(false);
        match action {
            LinuxAction::GuideOnly(msg) => {
                assert!(msg.contains(DOCKER_INSTALL_DOCS_URL));
                assert!(msg.to_lowercase().contains("unsupported"));
            }
            other => panic!("expected GuideOnly, got {other:?}"),
        }
    }

    #[test]
    fn format_linux_action_variants_render_distinct_messages() {
        assert!(format_linux_action("rustup", &LinuxAction::Installed).contains("installed"));
        assert!(format_linux_action("rustup", &LinuxAction::InstallFailed).contains("failed"));
        assert!(
            format_linux_action("sccache", &LinuxAction::BlockedOn("rustup"))
                .contains("blocked on rustup")
        );
        assert!(
            format_linux_action("rustup", &LinuxAction::WouldRun(RUSTUP_INSTALL_CMD))
                .contains(RUSTUP_INSTALL_CMD)
        );
        assert!(format_linux_action(
            "node",
            &LinuxAction::GuideOnly("install Node.js yourself: https://nodejs.org".to_string())
        )
        .contains("nodejs.org"));
    }
}
