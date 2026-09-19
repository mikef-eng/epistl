//! rustup + cargo/rustc detection and install.

use crate::checks::CommandExecutor;
use crate::prompt::{confirm_required, PromptPolicy};
use crate::tools::ToolOutcome;

pub fn ensure_rust(
    exec: &dyn CommandExecutor,
    policy: &PromptPolicy,
    check_only: bool,
) -> ToolOutcome {
    let rustup = exec.run("rustup", &["--version"]);
    let cargo = exec.run("cargo", &["--version"]);
    let rustc = exec.run("rustc", &["--version"]);

    if let (Some(ru), Some(ca), Some(rc)) = (rustup, cargo, rustc) {
        return ToolOutcome::Present(format!("{ru}; {ca}; {rc}"));
    }

    if check_only {
        return ToolOutcome::Absent(
            "rustup/cargo/rustc not found (run bootstrap.sh or pass without --check to install)"
                .into(),
        );
    }

    if !confirm_required(policy, "rustup/cargo/rustc missing. Install via rustup?") {
        return ToolOutcome::Skipped("user declined rustup install".into());
    }

    let cmd = "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --component rustfmt,clippy";
    match exec.run("sh", &["-c", cmd]) {
        Some(_) => ToolOutcome::Installed(
            "rustup installed (restart shell if cargo is not on PATH)".into(),
        ),
        None => ToolOutcome::Failed("rustup install script failed".into()),
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
    fn present_when_all_found() {
        let exec = FakeExec {
            responses: [
                ("rustup", "rustup 1.27"),
                ("cargo", "cargo 1.82"),
                ("rustc", "rustc 1.82"),
            ]
            .into_iter()
            .collect(),
        };
        let policy = PromptPolicy::testing(true, false);
        let out = ensure_rust(&exec, &policy, true);
        assert!(matches!(out, ToolOutcome::Present(_)));
    }

    #[test]
    fn absent_in_check_mode() {
        let exec = FakeExec {
            responses: HashMap::new(),
        };
        let policy = PromptPolicy::testing(true, false);
        let out = ensure_rust(&exec, &policy, true);
        assert!(matches!(out, ToolOutcome::Absent(_)));
    }
}
