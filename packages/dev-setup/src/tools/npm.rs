//! Mobile npm dependencies (`npm ci` in `apps/mobile`).

use std::path::Path;

use crate::checks::CommandExecutor;
use crate::prompt::{confirm_required, PromptPolicy};
use crate::tools::ToolOutcome;

pub fn ensure_mobile_deps(
    exec: &dyn CommandExecutor,
    policy: &PromptPolicy,
    check_only: bool,
    repo_root: &Path,
) -> ToolOutcome {
    let mobile = repo_root.join("apps/mobile");
    let node_modules = mobile.join("node_modules");
    if node_modules.is_dir() {
        return ToolOutcome::Present("apps/mobile/node_modules present".into());
    }

    if check_only {
        return ToolOutcome::Absent("apps/mobile/node_modules missing (run npm ci)".into());
    }

    if exec.run("node", &["--version"]).is_none() {
        return ToolOutcome::Failed("node not on PATH; cannot run npm ci".into());
    }

    if !confirm_required(policy, "apps/mobile dependencies missing. Run `npm ci`?") {
        return ToolOutcome::Skipped("user declined npm ci".into());
    }

    let cmd = format!("cd '{}' && npm ci", mobile.display());
    match exec.run("sh", &["-c", &cmd]) {
        Some(_) => ToolOutcome::Installed("npm ci completed in apps/mobile".into()),
        None => ToolOutcome::Failed("npm ci failed in apps/mobile".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Empty;
    impl CommandExecutor for Empty {
        fn run(&self, _: &str, _: &[&str]) -> Option<String> {
            None
        }
    }

    #[test]
    fn present_when_node_modules_exists() {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "dev-setup-npm-{}-{}-{nanos}",
            std::process::id(),
            n
        ));
        let nm = root.join("apps/mobile/node_modules");
        std::fs::create_dir_all(&nm).unwrap();
        let out = ensure_mobile_deps(&Empty, &PromptPolicy::testing(true, false), true, &root);
        let _ = std::fs::remove_dir_all(&root);
        assert!(matches!(out, ToolOutcome::Present(_)));
    }
}
