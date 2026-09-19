//! sccache detection and install (required by `.cargo/config.toml`).

use crate::checks::CommandExecutor;
use crate::prompt::{confirm_required, PromptPolicy};
use crate::tools::ToolOutcome;

pub const SCCACHE_VERSION: &str = "0.18.0";

pub fn ensure_sccache(
    exec: &dyn CommandExecutor,
    policy: &PromptPolicy,
    check_only: bool,
) -> ToolOutcome {
    if let Some(version) = exec.run("sccache", &["--version"]) {
        return ToolOutcome::Present(version);
    }

    if check_only {
        return ToolOutcome::Absent(
            "sccache not found (required by .cargo/config.toml rustc-wrapper)".into(),
        );
    }

    if !confirm_required(policy, "sccache missing (required). Install via cargo?") {
        return ToolOutcome::Skipped("user declined sccache install".into());
    }

    // Clear RUSTC_WRAPPER for the install itself to avoid chicken-and-egg.
    let cmd = format!("RUSTC_WRAPPER= cargo install sccache --locked --version {SCCACHE_VERSION}");
    match exec.run("sh", &["-c", &cmd]) {
        Some(_) => ToolOutcome::Installed(format!("sccache {SCCACHE_VERSION} installed")),
        None => ToolOutcome::Failed("cargo install sccache failed".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct FakeExec {
        responses: HashMap<&'static str, &'static str>,
    }

    impl CommandExecutor for FakeExec {
        fn run(&self, program: &str, _args: &[&str]) -> Option<String> {
            self.responses.get(program).map(|s| (*s).to_string())
        }
    }

    #[test]
    fn present() {
        let exec = FakeExec {
            responses: [("sccache", "sccache 0.18.0")].into_iter().collect(),
        };
        let out = ensure_sccache(&exec, &PromptPolicy::testing(true, false), true);
        assert!(matches!(out, ToolOutcome::Present(_)));
    }

    #[test]
    fn installs_under_yes() {
        let exec = FakeExec {
            responses: [("sh", "ok")].into_iter().collect(),
        };
        let out = ensure_sccache(&exec, &PromptPolicy::testing(true, false), false);
        assert!(matches!(out, ToolOutcome::Installed(_)));
    }
}
