//! moonrepo task runner install.

use crate::checks::CommandExecutor;
use crate::platform::Platform;
use crate::profile::ensure_profile_block;
use crate::prompt::{confirm_required, PromptPolicy};
use crate::tools::ToolOutcome;

pub fn ensure_moon(
    platform: &Platform,
    exec: &dyn CommandExecutor,
    policy: &PromptPolicy,
    check_only: bool,
) -> ToolOutcome {
    if let Some(version) = exec.run("moon", &["--version"]) {
        return ToolOutcome::Present(version);
    }

    if check_only {
        return ToolOutcome::Absent("moon not found".into());
    }

    if !confirm_required(policy, "moon missing. Install via moonrepo install script?") {
        return ToolOutcome::Skipped("user declined moon install".into());
    }

    let cmd = "curl -fsSL https://moonrepo.dev/install/moon.sh | bash";
    match exec.run("bash", &["-c", cmd]) {
        Some(_) => {
            let profile = platform.shell_profile();
            let body = "export PATH=\"$HOME/.moon/bin:$HOME/.local/bin:$PATH\"";
            let _ = ensure_profile_block(&profile, body);
            ToolOutcome::Installed(
                "moon installed to ~/.moon/bin (restart shell or export PATH)".into(),
            )
        }
        None => ToolOutcome::Failed("moon install script failed".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;

    struct FakeExec {
        responses: HashMap<&'static str, &'static str>,
    }

    impl CommandExecutor for FakeExec {
        fn run(&self, program: &str, _args: &[&str]) -> Option<String> {
            self.responses.get(program).map(|s| (*s).to_string())
        }
    }

    fn fake_platform() -> Platform {
        Platform {
            os: crate::platform::OsKind::Linux,
            arch: "x86_64".into(),
            distro: Some(crate::platform::DistroFamily::Apt),
            is_wsl: false,
            home: PathBuf::from("/tmp"),
        }
    }

    #[test]
    fn present() {
        let exec = FakeExec {
            responses: [("moon", "moon 1.30.0")].into_iter().collect(),
        };
        let out = ensure_moon(
            &fake_platform(),
            &exec,
            &PromptPolicy::testing(true, false),
            true,
        );
        assert!(matches!(out, ToolOutcome::Present(_)));
    }
}
