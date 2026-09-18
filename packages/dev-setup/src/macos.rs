//! macOS-only auto-install (opt-in) and guided native-toolchain checks
//! (issue #204).
//!
//! This module only ever executes a real, host-mutating command
//! (`brew install <formula>`) when the caller explicitly passes
//! `--install` *and* Homebrew itself is already present -- a plain
//! `dev-setup` invocation with no flags never installs anything, same as
//! the OS-agnostic checks in `checks.rs`. Docker Desktop and the
//! Xcode/CocoaPods/Android Studio/NDK native toolchain are always
//! detect-and-guide-only, never auto-installed, even with `--install` --
//! see the issue for why (GUI installers, accounts, licensing).

use std::path::Path;

use crate::checks::{CommandExecutor, ToolCheck};
use crate::environment::Environment;
use crate::homebrew::{check_homebrew, HOMEBREW_INSTALL_GUIDE};

/// Three-way outcome the final summary distinguishes per tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacOutcome {
    AlreadyPresent,
    AutoInstalled,
    GuidePrinted,
}

/// One reported line: which tool, what happened, and the human-readable
/// detail message (README pointer, brew command, etc.) already computed
/// for it, so `main.rs` can print both the detail and the final summary
/// purely from this list, without re-deriving anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MacReport {
    pub name: &'static str,
    pub outcome: MacOutcome,
    pub message: String,
}

/// Whether `name` is one of the four tools this issue allows Homebrew to
/// auto-install. Docker and the Xcode/Android toolchain are deliberately
/// excluded -- see `docker_report` and the four guide-only checks below.
pub fn is_brew_installable(name: &str) -> bool {
    matches!(name, "rustup" | "node" | "moon" | "sccache")
}

/// The Homebrew formula for each of the four brew-installable tools.
/// `rustup-init` is Homebrew's actual formula name for the `rustup`
/// toolchain manager; `moon` lives in moonrepo's own tap, not
/// homebrew-core.
fn brew_formula(tool_name: &str) -> &'static str {
    match tool_name {
        "rustup" => "rustup-init",
        "node" => "node",
        "moon" => "moonrepo/moon/moon",
        "sccache" => "sccache",
        other => unreachable!("brew_formula called for non-brew-installable tool {other}"),
    }
}

/// Resolves one already-run `ToolCheck` (from the OS-agnostic
/// `checks::run_all_checks`) into its macOS auto-install outcome.
/// `install_flag` is the CLI's opt-in `--install` flag; `homebrew_present`
/// gates it further, since this never shells out to `brew install` at
/// all unless Homebrew itself is already there.
pub fn resolve_brew_install(
    check: &ToolCheck,
    homebrew_present: bool,
    install_flag: bool,
    exec: &dyn CommandExecutor,
) -> MacReport {
    if check.status.is_present() {
        return already_present(check.name);
    }

    if !homebrew_present {
        return MacReport {
            name: check.name,
            outcome: MacOutcome::GuidePrinted,
            message: format!(
                "{}: Absent. Homebrew not found ({HOMEBREW_INSTALL_GUIDE}); install {} manually once Homebrew (or your preferred method) is available.",
                check.name, check.name
            ),
        };
    }

    let formula = brew_formula(check.name);
    let command = format!("brew install {formula}");

    if !install_flag {
        return MacReport {
            name: check.name,
            outcome: MacOutcome::GuidePrinted,
            message: format!(
                "{}: Absent. Would run: `{command}` (pass --install to run it automatically).",
                check.name
            ),
        };
    }

    match exec.run("brew", &["install", formula]) {
        Some(_) => MacReport {
            name: check.name,
            outcome: MacOutcome::AutoInstalled,
            message: format!("{}: auto-installed via `{command}`.", check.name),
        },
        None => MacReport {
            name: check.name,
            outcome: MacOutcome::GuidePrinted,
            message: format!(
                "{}: `{command}` failed; run it yourself, or install {} manually.",
                check.name, check.name
            ),
        },
    }
}

/// Docker on macOS is always guide-only, even with `--install`: Docker
/// Desktop requires a GUI installer/account, so it's never a candidate
/// for `brew install`-style automation.
pub const DOCKER_DESKTOP_MAC_GUIDE: &str =
    "Install Docker Desktop for Mac: https://www.docker.com/products/docker-desktop/ (GUI installer/account required -- never auto-installed by this tool)";

pub fn docker_report(check: &ToolCheck) -> MacReport {
    if check.status.is_present() {
        return already_present("docker");
    }
    MacReport {
        name: "docker",
        outcome: MacOutcome::GuidePrinted,
        message: format!("docker: Absent. {DOCKER_DESKTOP_MAC_GUIDE}"),
    }
}

/// README's exact heading text for the iOS prerequisites this issue
/// points at -- quoted so a human can jump straight to it.
const IOS_PREREQS_HEADING: &str =
    "\"iOS, from a clean clone to a working simulator (macOS only)\" > \"Prerequisites\"";

/// README's exact heading text for the Android prerequisites this issue
/// points at -- quoted so a human can jump straight to it.
const ANDROID_PREREQS_HEADING: &str =
    "\"Android, from a clean clone to a working emulator\" > \"Prerequisites\"";

pub fn check_xcode_clt(exec: &dyn CommandExecutor) -> MacReport {
    let present = exec.run("xcode-select", &["-p"]).is_some();
    guide_only_report(
        "xcode-clt",
        present,
        &format!(
            "See README's {IOS_PREREQS_HEADING}: install Xcode from the App Store, then run \
            `xcode-select --install` for the Command Line Tools alone (a real device/simulator \
            build needs full Xcode)."
        ),
    )
}

pub fn check_cocoapods(exec: &dyn CommandExecutor) -> MacReport {
    let present = exec.run("pod", &["--version"]).is_some();
    guide_only_report(
        "cocoapods",
        present,
        &format!(
            "See README's {IOS_PREREQS_HEADING}: install CocoaPods via `sudo gem install \
            cocoapods` (or Homebrew)."
        ),
    )
}

pub fn check_android_studio(env: &dyn Environment) -> MacReport {
    let app_present = env.path_exists(Path::new("/Applications/Android Studio.app"));
    let sdk_env_present =
        env.var("ANDROID_HOME").is_some() || env.var("ANDROID_SDK_ROOT").is_some();
    let present = app_present || sdk_env_present;
    guide_only_report(
        "android-studio",
        present,
        &format!(
            "See README's {ANDROID_PREREQS_HEADING}: install Android Studio \
            (https://developer.android.com/studio), which bundles the Android SDK, and set \
            ANDROID_HOME (or ANDROID_SDK_ROOT) to its SDK location."
        ),
    )
}

pub fn check_android_ndk(env: &dyn Environment) -> MacReport {
    let android_home = env
        .var("ANDROID_HOME")
        .or_else(|| env.var("ANDROID_SDK_ROOT"));
    let present = match android_home {
        Some(home) => env.dir_has_entries(&Path::new(&home).join("ndk")),
        None => false,
    };
    guide_only_report(
        "android-ndk",
        present,
        &format!(
            "See README's {ANDROID_PREREQS_HEADING}: install the Android NDK via Android \
            Studio's SDK Manager or `sdkmanager --install \"ndk;<version>\"`."
        ),
    )
}

fn already_present(name: &'static str) -> MacReport {
    MacReport {
        name,
        outcome: MacOutcome::AlreadyPresent,
        message: format!("{name}: already present"),
    }
}

fn guide_only_report(name: &'static str, present: bool, guide: &str) -> MacReport {
    if present {
        return already_present(name);
    }
    MacReport {
        name,
        outcome: MacOutcome::GuidePrinted,
        message: format!("{name}: Absent. {guide}"),
    }
}

/// Runs every macOS-specific check/install this issue covers, in report
/// order: Homebrew itself, then the four brew-installable tools (reusing
/// the OS-agnostic `checks` already computed by `checks::run_all_checks`)
/// plus Docker (guide-only), then the four detect-only native-toolchain
/// checks.
pub fn run_macos_checks(
    checks: &[ToolCheck],
    install_flag: bool,
    exec: &dyn CommandExecutor,
    env: &dyn Environment,
) -> Vec<MacReport> {
    let homebrew_present = check_homebrew(exec);
    let mut reports = Vec::new();

    reports.push(if homebrew_present {
        already_present("homebrew")
    } else {
        MacReport {
            name: "homebrew",
            outcome: MacOutcome::GuidePrinted,
            message: format!("homebrew: Absent. {HOMEBREW_INSTALL_GUIDE}"),
        }
    });

    for check in checks {
        if is_brew_installable(check.name) {
            reports.push(resolve_brew_install(
                check,
                homebrew_present,
                install_flag,
                exec,
            ));
        } else if check.name == "docker" {
            reports.push(docker_report(check));
        }
    }

    reports.push(check_xcode_clt(exec));
    reports.push(check_cocoapods(exec));
    reports.push(check_android_studio(env));
    reports.push(check_android_ndk(env));

    reports
}

/// Formats one `MacReport` as a single final-summary line, e.g.
/// `"rustup: auto-installed"` or `"android-ndk: guide printed"`.
pub fn format_mac_report_line(report: &MacReport) -> String {
    let state = match report.outcome {
        MacOutcome::AlreadyPresent => "already present",
        MacOutcome::AutoInstalled => "auto-installed",
        MacOutcome::GuidePrinted => "guide printed",
    };
    format!("{}: {state}", report.name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checks::ToolStatus;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// Same shape as `checks.rs`'s `FakeExecutor`, plus a record of every
    /// `run` call so tests can assert `--install` really did (or didn't)
    /// shell out to `brew install`, without ever running a real `brew`.
    struct FakeExecutor {
        responses: HashMap<&'static str, &'static str>,
        calls: Mutex<Vec<(String, Vec<String>)>>,
    }

    impl FakeExecutor {
        fn new(responses: &[(&'static str, &'static str)]) -> Self {
            FakeExecutor {
                responses: responses.iter().copied().collect(),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<(String, Vec<String>)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl CommandExecutor for FakeExecutor {
        fn run(&self, program: &str, args: &[&str]) -> Option<String> {
            self.calls.lock().unwrap().push((
                program.to_string(),
                args.iter().map(|a| a.to_string()).collect(),
            ));
            self.responses.get(program).map(|s| s.to_string())
        }
    }

    /// A canned `Environment`: fixed env vars plus a fixed set of
    /// "existing" paths, so Android Studio/NDK tests never touch the
    /// real filesystem or the real process environment.
    struct FakeEnvironment {
        vars: HashMap<&'static str, &'static str>,
        existing_paths: Vec<&'static str>,
        dirs_with_entries: Vec<&'static str>,
    }

    impl FakeEnvironment {
        fn new() -> Self {
            FakeEnvironment {
                vars: HashMap::new(),
                existing_paths: Vec::new(),
                dirs_with_entries: Vec::new(),
            }
        }

        fn with_var(mut self, key: &'static str, value: &'static str) -> Self {
            self.vars.insert(key, value);
            self
        }

        fn with_existing_path(mut self, path: &'static str) -> Self {
            self.existing_paths.push(path);
            self
        }

        fn with_dir_entries(mut self, path: &'static str) -> Self {
            self.dirs_with_entries.push(path);
            self
        }
    }

    impl Environment for FakeEnvironment {
        fn var(&self, name: &str) -> Option<String> {
            self.vars.get(name).map(|s| s.to_string())
        }

        fn path_exists(&self, path: &Path) -> bool {
            self.existing_paths.iter().any(|p| Path::new(p) == path)
        }

        fn dir_has_entries(&self, path: &Path) -> bool {
            self.dirs_with_entries.iter().any(|p| Path::new(p) == path)
        }
    }

    fn absent(name: &'static str) -> ToolCheck {
        ToolCheck {
            name,
            status: ToolStatus::Absent,
        }
    }

    fn present(name: &'static str) -> ToolCheck {
        ToolCheck {
            name,
            status: ToolStatus::Present(Some("some version".to_string())),
        }
    }

    #[test]
    fn homebrew_present_with_install_flag_auto_installs_absent_tools() {
        let exec = FakeExecutor::new(&[("brew", "Homebrew 4.3.9")]);
        let report = resolve_brew_install(&absent("rustup"), true, true, &exec);

        assert_eq!(report.outcome, MacOutcome::AutoInstalled);
        assert!(report.message.contains("brew install rustup-init"));
        assert_eq!(
            exec.calls(),
            vec![(
                "brew".to_string(),
                vec!["install".to_string(), "rustup-init".to_string()]
            )]
        );
    }

    #[test]
    fn homebrew_present_without_install_flag_only_prints_the_command() {
        let exec = FakeExecutor::new(&[("brew", "Homebrew 4.3.9")]);
        let report = resolve_brew_install(&absent("node"), true, false, &exec);

        assert_eq!(report.outcome, MacOutcome::GuidePrinted);
        assert!(report.message.contains("brew install node"));
        // No `brew install` call was made -- only the (irrelevant here)
        // `homebrew_present` probe would have run `brew --version`, not
        // exercised by this call at all since it's passed in directly.
        assert!(exec.calls().is_empty());
    }

    #[test]
    fn already_present_tools_are_never_touched_regardless_of_install_flag() {
        let exec = FakeExecutor::new(&[("brew", "Homebrew 4.3.9")]);
        let report = resolve_brew_install(&present("moon"), true, true, &exec);

        assert_eq!(report.outcome, MacOutcome::AlreadyPresent);
        assert!(exec.calls().is_empty());
    }

    #[test]
    fn homebrew_absent_falls_back_to_guide_only_even_with_install_flag() {
        let exec = FakeExecutor::new(&[]);
        let report = resolve_brew_install(&absent("sccache"), false, true, &exec);

        assert_eq!(report.outcome, MacOutcome::GuidePrinted);
        assert!(report.message.contains("Homebrew not found"));
        assert!(exec.calls().is_empty());
    }

    #[test]
    fn run_macos_checks_never_calls_brew_install_without_the_flag() {
        let exec = FakeExecutor::new(&[("brew", "Homebrew 4.3.9")]);
        let env = FakeEnvironment::new();
        let checks = vec![
            absent("rustup"),
            present("cargo/rustc"),
            absent("node"),
            absent("moon"),
            absent("docker"),
            absent("sccache"),
        ];

        let reports = run_macos_checks(&checks, false, &exec, &env);

        assert!(reports
            .iter()
            .all(|r| r.outcome != MacOutcome::AutoInstalled));
        assert!(exec
            .calls()
            .iter()
            .all(|(program, args)| !(program == "brew"
                && args.first().map(String::as_str) == Some("install"))));
    }

    #[test]
    fn run_macos_checks_auto_installs_only_the_absent_brew_installable_tools() {
        let exec = FakeExecutor::new(&[("brew", "Homebrew 4.3.9")]);
        let env = FakeEnvironment::new();
        let checks = vec![
            absent("rustup"),
            present("cargo/rustc"),
            present("node"),
            absent("moon"),
            absent("docker"),
            present("sccache"),
        ];

        let reports = run_macos_checks(&checks, true, &exec, &env);

        let by_name = |name: &str| reports.iter().find(|r| r.name == name).unwrap();
        assert_eq!(by_name("rustup").outcome, MacOutcome::AutoInstalled);
        assert_eq!(by_name("moon").outcome, MacOutcome::AutoInstalled);
        assert_eq!(by_name("node").outcome, MacOutcome::AlreadyPresent);
        assert_eq!(by_name("sccache").outcome, MacOutcome::AlreadyPresent);
        // Docker is always guide-only, even with --install.
        assert_eq!(by_name("docker").outcome, MacOutcome::GuidePrinted);

        let install_calls: Vec<_> = exec
            .calls()
            .into_iter()
            .filter(|(program, args)| {
                program == "brew" && args.first().map(String::as_str) == Some("install")
            })
            .collect();
        assert_eq!(install_calls.len(), 2);
    }

    #[test]
    fn docker_present_is_already_present_docker_absent_is_guide_only() {
        assert_eq!(
            docker_report(&present("docker")).outcome,
            MacOutcome::AlreadyPresent
        );
        let absent_report = docker_report(&absent("docker"));
        assert_eq!(absent_report.outcome, MacOutcome::GuidePrinted);
        assert!(absent_report.message.contains("Docker Desktop"));
    }

    #[test]
    fn xcode_clt_present_and_absent() {
        let present_exec =
            FakeExecutor::new(&[("xcode-select", "/Library/Developer/CommandLineTools")]);
        assert_eq!(
            check_xcode_clt(&present_exec).outcome,
            MacOutcome::AlreadyPresent
        );

        let absent_exec = FakeExecutor::new(&[]);
        let report = check_xcode_clt(&absent_exec);
        assert_eq!(report.outcome, MacOutcome::GuidePrinted);
        assert!(report.message.contains("xcode-select --install"));
        assert!(report.message.contains("Prerequisites"));
    }

    #[test]
    fn cocoapods_present_and_absent() {
        let present_exec = FakeExecutor::new(&[("pod", "1.15.2")]);
        assert_eq!(
            check_cocoapods(&present_exec).outcome,
            MacOutcome::AlreadyPresent
        );

        let absent_exec = FakeExecutor::new(&[]);
        let report = check_cocoapods(&absent_exec);
        assert_eq!(report.outcome, MacOutcome::GuidePrinted);
        assert!(report.message.contains("sudo gem install cocoapods"));
    }

    #[test]
    fn android_studio_present_via_app_bundle_and_absent() {
        let present_env =
            FakeEnvironment::new().with_existing_path("/Applications/Android Studio.app");
        assert_eq!(
            check_android_studio(&present_env).outcome,
            MacOutcome::AlreadyPresent
        );

        let absent_env = FakeEnvironment::new();
        let report = check_android_studio(&absent_env);
        assert_eq!(report.outcome, MacOutcome::GuidePrinted);
        assert!(report.message.contains("ANDROID_HOME"));
    }

    #[test]
    fn android_studio_present_via_android_home_env_var_alone() {
        let env = FakeEnvironment::new().with_var("ANDROID_HOME", "/Users/dev/Library/Android/sdk");
        assert_eq!(
            check_android_studio(&env).outcome,
            MacOutcome::AlreadyPresent
        );
    }

    #[test]
    fn android_ndk_present_and_absent() {
        let present_env = FakeEnvironment::new()
            .with_var("ANDROID_HOME", "/Users/dev/Library/Android/sdk")
            .with_dir_entries("/Users/dev/Library/Android/sdk/ndk");
        assert_eq!(
            check_android_ndk(&present_env).outcome,
            MacOutcome::AlreadyPresent
        );

        let absent_env_no_home = FakeEnvironment::new();
        let report = check_android_ndk(&absent_env_no_home);
        assert_eq!(report.outcome, MacOutcome::GuidePrinted);
        assert!(report.message.contains("sdkmanager"));

        let absent_env_empty_ndk_dir =
            FakeEnvironment::new().with_var("ANDROID_HOME", "/Users/dev/Library/Android/sdk");
        assert_eq!(
            check_android_ndk(&absent_env_empty_ndk_dir).outcome,
            MacOutcome::GuidePrinted
        );
    }

    #[test]
    fn format_mac_report_line_variants() {
        assert_eq!(
            format_mac_report_line(&already_present("rustup")),
            "rustup: already present"
        );
        assert_eq!(
            format_mac_report_line(&MacReport {
                name: "moon",
                outcome: MacOutcome::AutoInstalled,
                message: String::new(),
            }),
            "moon: auto-installed"
        );
        assert_eq!(
            format_mac_report_line(&MacReport {
                name: "docker",
                outcome: MacOutcome::GuidePrinted,
                message: String::new(),
            }),
            "docker: guide printed"
        );
    }
}
