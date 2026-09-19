//! Optional iOS toolchain (macOS only): Xcode detect + CocoaPods install.

use std::path::Path;

use crate::checks::CommandExecutor;
use crate::environment::Environment;
use crate::pkg::{install_packages, PackageSpec};
use crate::platform::{OsKind, Platform};
use crate::prompt::{confirm_required, PromptPolicy};
use crate::tools::ToolOutcome;

/// Run the iOS toolchain section. No-op on Linux.
pub fn ensure_ios(
    platform: &Platform,
    exec: &dyn CommandExecutor,
    env: &dyn Environment,
    policy: &PromptPolicy,
    check_only: bool,
) -> Vec<(String, ToolOutcome)> {
    if platform.os != OsKind::Macos {
        return vec![];
    }

    vec![
        ("xcode".into(), ensure_xcode(exec, env, policy, check_only)),
        (
            "cocoapods".into(),
            ensure_cocoapods(platform, exec, policy, check_only),
        ),
    ]
}

fn ensure_xcode(
    exec: &dyn CommandExecutor,
    env: &dyn Environment,
    policy: &PromptPolicy,
    check_only: bool,
) -> ToolOutcome {
    let app_present = env.path_exists(Path::new("/Applications/Xcode.app"));
    let clt = exec.run("xcode-select", &["-p"]);

    if app_present {
        let clt_note = match &clt {
            Some(p) => format!("; CLT at {p}"),
            None => "; Command Line Tools not selected — run `sudo xcode-select -s /Applications/Xcode.app`".into(),
        };
        return ToolOutcome::Present(format!("Xcode.app found{clt_note}"));
    }

    if clt.is_some() {
        // CLT alone is enough for some Rust builds but not `expo run:ios`.
        if check_only {
            return ToolOutcome::Absent(
                "Xcode.app not found (CLT present — full Xcode required for iOS simulator builds)"
                    .into(),
            );
        }
    } else if check_only {
        return ToolOutcome::Absent("Xcode.app and Command Line Tools not found".into());
    }

    // Never auto-install Xcode (App Store / Apple licensing). Always guide.
    let _ = policy;
    ToolOutcome::Guided(
        "Install Xcode from the Mac App Store (or https://developer.apple.com/xcode/), then run `sudo xcode-select -s /Applications/Xcode.app` and `sudo xcodebuild -license accept`"
            .into(),
    )
}

fn ensure_cocoapods(
    platform: &Platform,
    exec: &dyn CommandExecutor,
    policy: &PromptPolicy,
    check_only: bool,
) -> ToolOutcome {
    if let Some(version) = exec.run("pod", &["--version"]) {
        return ToolOutcome::Present(format!("CocoaPods {version}"));
    }

    if check_only {
        return ToolOutcome::Absent("CocoaPods (`pod`) not found".into());
    }

    if !confirm_required(policy, "CocoaPods missing. Install via Homebrew?") {
        return ToolOutcome::Skipped("user declined CocoaPods install".into());
    }

    let spec = PackageSpec {
        apt: &[],
        dnf: &[],
        pacman: &[],
        brew: &["cocoapods"],
        brew_cask: &[],
    };
    match install_packages(platform, exec, &spec) {
        Ok(()) => ToolOutcome::Installed("CocoaPods installed via Homebrew".into()),
        Err(e) => ToolOutcome::Failed(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    struct FakeEnv {
        paths: Vec<PathBuf>,
    }

    impl Environment for FakeEnv {
        fn var(&self, _: &str) -> Option<String> {
            None
        }
        fn path_exists(&self, path: &Path) -> bool {
            self.paths.iter().any(|p| p == path)
        }
        fn dir_has_entries(&self, path: &Path) -> bool {
            self.path_exists(path)
        }
    }

    struct FakeExec {
        responses: HashMap<&'static str, &'static str>,
    }

    impl CommandExecutor for FakeExec {
        fn run(&self, program: &str, _args: &[&str]) -> Option<String> {
            self.responses.get(program).map(|s| (*s).to_string())
        }
    }

    #[test]
    fn linux_returns_empty() {
        let platform = Platform {
            os: OsKind::Linux,
            arch: "x86_64".into(),
            distro: Some(crate::platform::DistroFamily::Apt),
            is_wsl: false,
            home: PathBuf::from("/home/dev"),
        };
        let out = ensure_ios(
            &platform,
            &FakeExec {
                responses: HashMap::new(),
            },
            &FakeEnv { paths: vec![] },
            &PromptPolicy::testing(true, false),
            true,
        );
        assert!(out.is_empty());
    }

    #[test]
    fn xcode_present() {
        let env = FakeEnv {
            paths: vec![PathBuf::from("/Applications/Xcode.app")],
        };
        let exec = FakeExec {
            responses: [("xcode-select", "/Applications/Xcode.app/Contents/Developer")]
                .into_iter()
                .collect(),
        };
        let out = ensure_xcode(&exec, &env, &PromptPolicy::testing(true, false), true);
        assert!(matches!(out, ToolOutcome::Present(_)));
    }
}
