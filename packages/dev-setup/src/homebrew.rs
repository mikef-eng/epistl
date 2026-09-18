//! Homebrew detection (issue #204).
//!
//! Homebrew itself is never installed by this tool: its official
//! installer pipes a script to `sudo bash` and needs interactive
//! confirmation, which would violate this CLI's "never silently mutate a
//! dev machine" rule even under `--install`. When Homebrew is absent,
//! every otherwise brew-installable tool falls back to guide-only output
//! -- see `macos::run_macos_checks`.

use crate::checks::CommandExecutor;

/// Homebrew's official install command/link, printed (never executed)
/// when Homebrew itself isn't found.
pub const HOMEBREW_INSTALL_GUIDE: &str = "Install Homebrew yourself from https://brew.sh (interactive installer, needs sudo/confirmation -- never run automatically by this tool)";

pub fn check_homebrew(exec: &dyn CommandExecutor) -> bool {
    exec.run("brew", &["--version"]).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

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
    fn detects_homebrew_when_present() {
        let exec = FakeExecutor::new(&[("brew", "Homebrew 4.3.9")]);
        assert!(check_homebrew(&exec));
    }

    #[test]
    fn reports_absent_when_brew_not_found() {
        let exec = FakeExecutor::new(&[]);
        assert!(!check_homebrew(&exec));
    }
}
