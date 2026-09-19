//! CLI flag parsing for the rewritten interactive `dev-setup`.

/// Parsed command-line flags. Interactive install is the default;
/// `--check` is the opt-in detect-only mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Flags {
    /// Detect-only; never install or start.
    pub check: bool,
    /// Auto-accept required tools; decline optional heavy ones.
    pub yes: bool,
    /// Force stack bring-up (compose + migrate).
    pub start: bool,
    /// Explicitly skip stack bring-up (overrides the interactive prompt).
    pub no_start: bool,
    /// Skip Android / iOS toolchain section.
    pub skip_mobile: bool,
}

impl Flags {
    pub fn parse<I, S>(args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut flags = Flags {
            check: false,
            yes: false,
            start: false,
            no_start: false,
            skip_mobile: false,
        };
        for arg in args {
            match arg.as_ref() {
                "--check" => flags.check = true,
                "--yes" | "-y" => flags.yes = true,
                "--start" => flags.start = true,
                "--no-start" => flags.no_start = true,
                "--skip-mobile" => flags.skip_mobile = true,
                // Legacy alias from the previous CLI; treat as interactive
                // install (the new default) — no-op, but accepted quietly.
                "--install" => {}
                _ => {}
            }
        }
        flags
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_interactive() {
        let f = Flags::parse(["dev-setup"]);
        assert!(!f.check);
        assert!(!f.yes);
        assert!(!f.start);
        assert!(!f.no_start);
        assert!(!f.skip_mobile);
    }

    #[test]
    fn parses_all_flags() {
        let f = Flags::parse(["dev-setup", "--check", "--yes", "--start", "--skip-mobile"]);
        assert!(f.check);
        assert!(f.yes);
        assert!(f.start);
        assert!(f.skip_mobile);
    }

    #[test]
    fn no_start_flag() {
        let f = Flags::parse(["dev-setup", "--no-start"]);
        assert!(f.no_start);
        assert!(!f.start);
    }
}
