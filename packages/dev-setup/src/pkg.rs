//! Package-manager abstraction for apt / dnf / pacman / Homebrew.

use crate::checks::CommandExecutor;
use crate::platform::{DistroFamily, OsKind, Platform};

/// A set of packages to install via the host package manager.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageSpec {
    pub apt: &'static [&'static str],
    pub dnf: &'static [&'static str],
    pub pacman: &'static [&'static str],
    pub brew: &'static [&'static str],
    /// Homebrew casks (macOS only), e.g. `temurin@17`, `android-studio`.
    pub brew_cask: &'static [&'static str],
}

/// Install `spec` using the package manager for `platform`.
/// Returns `Ok(())` on success, `Err(message)` on failure / unsupported.
pub fn install_packages(
    platform: &Platform,
    exec: &dyn CommandExecutor,
    spec: &PackageSpec,
) -> Result<(), String> {
    match platform.os {
        OsKind::Macos => {
            if exec.run("brew", &["--version"]).is_none() {
                return Err("Homebrew is not installed; install from https://brew.sh".into());
            }
            for formula in spec.brew {
                if exec.run("brew", &["install", formula]).is_none() {
                    return Err(format!("`brew install {formula}` failed"));
                }
            }
            for cask in spec.brew_cask {
                if exec.run("brew", &["install", "--cask", cask]).is_none() {
                    return Err(format!("`brew install --cask {cask}` failed"));
                }
            }
            Ok(())
        }
        OsKind::Linux => {
            let family = platform
                .distro
                .ok_or_else(|| "Linux distro family unknown".to_string())?;
            match family {
                DistroFamily::Apt => {
                    if exec.run("sudo", &["apt-get", "update", "-qq"]).is_none() {
                        return Err("`sudo apt-get update` failed".into());
                    }
                    let mut args = vec!["apt-get", "install", "-y", "-qq"];
                    args.extend_from_slice(spec.apt);
                    if exec.run("sudo", &args).is_none() {
                        return Err(format!(
                            "`sudo apt-get install {}` failed",
                            spec.apt.join(" ")
                        ));
                    }
                    Ok(())
                }
                DistroFamily::Dnf => {
                    let pm = if exec.run("dnf", &["--version"]).is_some() {
                        "dnf"
                    } else {
                        "yum"
                    };
                    let mut args = vec![pm, "install", "-y"];
                    args.extend_from_slice(spec.dnf);
                    if exec.run("sudo", &args).is_none() {
                        return Err(format!("`sudo {pm} install {}` failed", spec.dnf.join(" ")));
                    }
                    Ok(())
                }
                DistroFamily::Pacman => {
                    let mut args = vec!["pacman", "-Sy", "--needed", "--noconfirm"];
                    args.extend_from_slice(spec.pacman);
                    if exec.run("sudo", &args).is_none() {
                        return Err(format!(
                            "`sudo pacman -Sy {}` failed",
                            spec.pacman.join(" ")
                        ));
                    }
                    Ok(())
                }
            }
        }
    }
}

/// Whether Homebrew is available (macOS).
pub fn brew_available(exec: &dyn CommandExecutor) -> bool {
    exec.run("brew", &["--version"]).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    struct RecordingExecutor {
        responses: HashMap<String, Option<String>>,
        calls: RefCell<Vec<(String, Vec<String>)>>,
    }

    impl RecordingExecutor {
        fn new(pairs: &[(&str, Option<&str>)]) -> Self {
            let mut responses = HashMap::new();
            for (key, val) in pairs {
                responses.insert((*key).to_string(), val.map(|s| s.to_string()));
            }
            RecordingExecutor {
                responses,
                calls: RefCell::new(Vec::new()),
            }
        }

        fn key(program: &str, args: &[&str]) -> String {
            format!("{program} {}", args.join(" "))
        }
    }

    impl CommandExecutor for RecordingExecutor {
        fn run(&self, program: &str, args: &[&str]) -> Option<String> {
            self.calls.borrow_mut().push((
                program.to_string(),
                args.iter().map(|s| s.to_string()).collect(),
            ));
            let key = Self::key(program, args);
            // Prefer exact match; fall back to program-only present.
            if let Some(v) = self.responses.get(&key) {
                return v.clone();
            }
            self.responses.get(program).cloned().unwrap_or(None)
        }
    }

    fn linux_apt() -> Platform {
        Platform {
            os: OsKind::Linux,
            arch: "x86_64".into(),
            distro: Some(DistroFamily::Apt),
            is_wsl: false,
            home: "/home/dev".into(),
        }
    }

    #[test]
    fn apt_install_runs_update_then_install() {
        let exec = RecordingExecutor::new(&[
            ("sudo apt-get update -qq", Some("")),
            ("sudo apt-get install -y -qq openjdk-17-jdk", Some("")),
        ]);
        let spec = PackageSpec {
            apt: &["openjdk-17-jdk"],
            dnf: &[],
            pacman: &[],
            brew: &[],
            brew_cask: &[],
        };
        install_packages(&linux_apt(), &exec, &spec).unwrap();
        let calls = exec.calls.borrow();
        assert_eq!(calls[0].0, "sudo");
        assert_eq!(calls[0].1, vec!["apt-get", "update", "-qq"]);
        assert_eq!(calls[1].0, "sudo");
        assert!(calls[1].1.contains(&"openjdk-17-jdk".to_string()));
    }

    #[test]
    fn brew_install_formulas_and_casks() {
        let platform = Platform {
            os: OsKind::Macos,
            arch: "aarch64".into(),
            distro: None,
            is_wsl: false,
            home: "/Users/dev".into(),
        };
        let exec = RecordingExecutor::new(&[
            ("brew --version", Some("Homebrew 4.0")),
            ("brew install fnm", Some("")),
            ("brew install --cask temurin@17", Some("")),
        ]);
        let spec = PackageSpec {
            apt: &[],
            dnf: &[],
            pacman: &[],
            brew: &["fnm"],
            brew_cask: &["temurin@17"],
        };
        install_packages(&platform, &exec, &spec).unwrap();
    }
}
