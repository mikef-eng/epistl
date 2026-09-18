//! macOS/Linux-only OS gate (issue #203). Windows and anything else is an
//! explicit non-goal, not a "handle it later" -- see the issue's "Out of
//! scope" section.

/// Returns `Ok(())` when `os` (normally `std::env::consts::OS`) is one of
/// the two supported platforms, or `Err(message)` otherwise. Takes `os` as
/// a plain `&str` parameter (rather than reading `std::env::consts::OS`
/// itself) so tests can inject unsupported values without needing an
/// actual non-macOS/non-Linux machine.
pub fn check_os(os: &str) -> Result<(), String> {
    match os {
        "macos" | "linux" => Ok(()),
        other => Err(format!(
            "unsupported OS: {other}, only macOS and Linux are supported"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_is_supported() {
        assert_eq!(check_os("macos"), Ok(()));
    }

    #[test]
    fn linux_is_supported() {
        assert_eq!(check_os("linux"), Ok(()));
    }

    #[test]
    fn windows_is_rejected_with_a_clear_message() {
        let err = check_os("windows").expect_err("windows must not be supported");
        assert_eq!(
            err,
            "unsupported OS: windows, only macOS and Linux are supported"
        );
    }

    #[test]
    fn other_unknown_os_values_are_rejected_too() {
        let err = check_os("freebsd").expect_err("freebsd must not be supported");
        assert!(err.contains("freebsd"));
        assert!(err.contains("only macOS and Linux are supported"));
    }
}
