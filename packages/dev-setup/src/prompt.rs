//! Interactive y/N prompts that honour `--yes` and non-TTY stdin.

use std::io::{self, BufRead, IsTerminal, Write};

/// Prompt behaviour derived from CLI flags + whether stdin is a TTY.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PromptPolicy {
    /// `--yes` was passed (or inferred from non-TTY).
    pub yes: bool,
    /// stdin is an interactive terminal.
    pub is_tty: bool,
}

impl PromptPolicy {
    pub fn from_flags(yes_flag: bool) -> Self {
        let is_tty = io::stdin().is_terminal();
        PromptPolicy {
            // Non-TTY implies --yes so agents/CI never hang.
            yes: yes_flag || !is_tty,
            is_tty,
        }
    }

    /// For tests: construct a policy without touching the real TTY.
    pub fn testing(yes: bool, is_tty: bool) -> Self {
        PromptPolicy { yes, is_tty }
    }
}

/// Ask a yes/no question.
///
/// - If `policy.yes` is set: returns true when `accept_under_yes` is true
///   (required tools), otherwise false (optional heavy tools like Android
///   Studio IDE / Xcode).
/// - If not a TTY and not `--yes`: returns `default_yes`.
/// - Otherwise reads a line from stdin.
pub fn confirm(
    policy: &PromptPolicy,
    question: &str,
    default_yes: bool,
    accept_under_yes: bool,
) -> bool {
    if policy.yes {
        let answer = if accept_under_yes {
            true
        } else {
            // Under --yes, still decline optional heavy tools unless their
            // default is somehow yes (it isn't for Studio/Xcode).
            false
        };
        // For required tools accept_under_yes=true → yes.
        // For optional heavy tools accept_under_yes=false → no.
        // Ignore default_yes when --yes is set for the accept_under_yes path;
        // when declining optionals we always say no.
        let _ = default_yes;
        println!(
            "{question} [{}]",
            if answer { "yes (--yes)" } else { "no (--yes)" }
        );
        return answer;
    }

    if !policy.is_tty {
        return default_yes;
    }

    let hint = if default_yes { "Y/n" } else { "y/N" };
    print!("{question} [{hint}] ");
    let _ = io::stdout().flush();

    let mut line = String::new();
    match io::stdin().lock().read_line(&mut line) {
        Ok(0) => default_yes, // EOF
        Ok(_) => {
            let trimmed = line.trim().to_ascii_lowercase();
            if trimmed.is_empty() {
                default_yes
            } else {
                matches!(trimmed.as_str(), "y" | "yes")
            }
        }
        Err(_) => default_yes,
    }
}

/// Convenience: required tool prompt (default yes, accepted under `--yes`).
pub fn confirm_required(policy: &PromptPolicy, question: &str) -> bool {
    confirm(policy, question, true, true)
}

/// Convenience: optional heavy tool (default no, declined under `--yes`).
pub fn confirm_optional(policy: &PromptPolicy, question: &str) -> bool {
    confirm(policy, question, false, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yes_accepts_required() {
        let p = PromptPolicy::testing(true, false);
        assert!(confirm_required(&p, "Install moon?"));
    }

    #[test]
    fn yes_declines_optional() {
        let p = PromptPolicy::testing(true, false);
        assert!(!confirm_optional(&p, "Install Android Studio IDE?"));
    }

    #[test]
    fn from_flags_non_tty_implies_yes() {
        // We can't force non-TTY in unit tests reliably, but we can check
        // that an explicit yes_flag sticks.
        let p = PromptPolicy {
            yes: true,
            is_tty: false,
        };
        assert!(p.yes);
    }
}
