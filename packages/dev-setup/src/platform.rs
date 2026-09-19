//! Host platform detection: OS, architecture, Linux distro family, WSL,
//! and the user's interactive shell profile path.

use std::fs;
use std::path::PathBuf;

/// Supported host operating systems.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OsKind {
    Macos,
    Linux,
}

/// Linux package-manager family detected from `/etc/os-release`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DistroFamily {
    Apt,
    Dnf,
    Pacman,
}

/// Snapshot of the host platform used by every tool module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Platform {
    pub os: OsKind,
    pub arch: String,
    pub distro: Option<DistroFamily>,
    pub is_wsl: bool,
    pub home: PathBuf,
}

impl Platform {
    /// Detect the current host. Returns `Err` on unsupported OS / distro.
    pub fn detect() -> Result<Self, String> {
        let os = match std::env::consts::OS {
            "macos" => OsKind::Macos,
            "linux" => OsKind::Linux,
            other => {
                return Err(format!(
                    "unsupported OS: {other}, only macOS and Linux are supported"
                ));
            }
        };

        let arch = std::env::consts::ARCH.to_string();
        let home = dirs_home().ok_or_else(|| "HOME is not set".to_string())?;
        let is_wsl = os == OsKind::Linux && detect_wsl();
        let distro = if os == OsKind::Linux {
            Some(detect_distro()?)
        } else {
            None
        };

        Ok(Platform {
            os,
            arch,
            distro,
            is_wsl,
            home,
        })
    }

    /// Path to the user's interactive shell profile (`.zshrc` or `.bashrc`).
    pub fn shell_profile(&self) -> PathBuf {
        let shell = std::env::var("SHELL").unwrap_or_default();
        if shell.ends_with("/zsh") || shell == "zsh" {
            self.home.join(".zshrc")
        } else {
            self.home.join(".bashrc")
        }
    }

    /// Default Android SDK root for this OS.
    pub fn android_sdk_root(&self) -> PathBuf {
        match self.os {
            OsKind::Macos => self.home.join("Library/Android/sdk"),
            OsKind::Linux => self.home.join("Android/Sdk"),
        }
    }
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn detect_wsl() -> bool {
    fs::read_to_string("/proc/version")
        .map(|v| v.to_ascii_lowercase().contains("microsoft"))
        .unwrap_or(false)
}

fn detect_distro() -> Result<DistroFamily, String> {
    let contents = fs::read_to_string("/etc/os-release")
        .map_err(|_| "cannot read /etc/os-release; unsupported Linux environment".to_string())?;
    parse_distro_family(&contents)
}

/// Parse `ID` / `ID_LIKE` from an `/etc/os-release` body into a distro family.
pub fn parse_distro_family(os_release: &str) -> Result<DistroFamily, String> {
    let mut id = String::new();
    let mut id_like = String::new();
    for line in os_release.lines() {
        if let Some(rest) = line.strip_prefix("ID=") {
            id = unquote(rest).to_ascii_lowercase();
        } else if let Some(rest) = line.strip_prefix("ID_LIKE=") {
            id_like = unquote(rest).to_ascii_lowercase();
        }
    }
    let haystack = format!(" {id} {id_like} ");
    if haystack.contains(" debian ") || haystack.contains(" ubuntu ") {
        return Ok(DistroFamily::Apt);
    }
    if haystack.contains(" rhel ")
        || haystack.contains(" fedora ")
        || haystack.contains(" centos ")
        || haystack.contains(" rocky ")
        || haystack.contains(" alma ")
    {
        return Ok(DistroFamily::Dnf);
    }
    if haystack.contains(" arch ") {
        return Ok(DistroFamily::Pacman);
    }
    Err(format!(
        "unsupported Linux distro (ID={id}). Supported families: apt, dnf, pacman"
    ))
}

fn unquote(s: &str) -> &str {
    let s = s.trim();
    if (s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\'')) {
        &s[1..s.len() - 1]
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ubuntu_as_apt() {
        let body = "ID=ubuntu\nID_LIKE=debian\n";
        assert_eq!(parse_distro_family(body).unwrap(), DistroFamily::Apt);
    }

    #[test]
    fn parses_fedora_as_dnf() {
        let body = "ID=fedora\n";
        assert_eq!(parse_distro_family(body).unwrap(), DistroFamily::Dnf);
    }

    #[test]
    fn parses_arch_as_pacman() {
        let body = "ID=arch\n";
        assert_eq!(parse_distro_family(body).unwrap(), DistroFamily::Pacman);
    }

    #[test]
    fn rejects_alpine() {
        let body = "ID=alpine\n";
        assert!(parse_distro_family(body).is_err());
    }

    #[test]
    fn android_sdk_root_differs_by_os() {
        let linux = Platform {
            os: OsKind::Linux,
            arch: "x86_64".into(),
            distro: Some(DistroFamily::Apt),
            is_wsl: false,
            home: PathBuf::from("/home/dev"),
        };
        assert_eq!(
            linux.android_sdk_root(),
            PathBuf::from("/home/dev/Android/Sdk")
        );

        let mac = Platform {
            os: OsKind::Macos,
            arch: "aarch64".into(),
            distro: None,
            is_wsl: false,
            home: PathBuf::from("/Users/dev"),
        };
        assert_eq!(
            mac.android_sdk_root(),
            PathBuf::from("/Users/dev/Library/Android/sdk")
        );
    }
}
