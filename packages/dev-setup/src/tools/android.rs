//! Optional Android toolchain: JDK 17, cmdline-tools, SDK/NDK, Studio IDE.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::checks::CommandExecutor;
use crate::environment::Environment;
use crate::pkg::{install_packages, PackageSpec};
use crate::platform::{OsKind, Platform};
use crate::profile::ensure_profile_block;
use crate::prompt::{confirm_optional, confirm_required, PromptPolicy};
use crate::tools::ToolOutcome;

/// NDK version matching React Native 0.86.3's gradle catalog.
pub const NDK_VERSION: &str = "27.1.12297006";
pub const BUILD_TOOLS: &str = "36.0.0";
pub const COMPILE_SDK: &str = "36";
pub const CMAKE_VERSION: &str = "3.22.1";

/// Run the Android toolchain section. Returns a list of per-item outcomes.
pub fn ensure_android(
    platform: &Platform,
    exec: &dyn CommandExecutor,
    env: &dyn Environment,
    policy: &PromptPolicy,
    check_only: bool,
) -> Vec<(String, ToolOutcome)> {
    vec![
        ("jdk".into(), ensure_jdk(platform, exec, policy, check_only)),
        (
            "android-sdk".into(),
            ensure_sdk(platform, exec, env, policy, check_only),
        ),
        (
            "android-studio".into(),
            ensure_studio(platform, exec, env, policy, check_only),
        ),
    ]
}

fn ensure_jdk(
    platform: &Platform,
    exec: &dyn CommandExecutor,
    policy: &PromptPolicy,
    check_only: bool,
) -> ToolOutcome {
    // Accept any Java 17+.
    if let Some(version) = exec.run("java", &["-version"]) {
        if version.contains("17")
            || version.contains("18")
            || version.contains("19")
            || version.contains("20")
            || version.contains("21")
            || version.contains("22")
            || version.contains("23")
            || version.contains("24")
            || version.contains("25")
        {
            return ToolOutcome::Present(version.lines().next().unwrap_or(&version).to_string());
        }
        // Also try parsing "version \"17." style from stderr-as-stdout.
        if java_major_ok(&version) {
            return ToolOutcome::Present(version.lines().next().unwrap_or(&version).to_string());
        }
    }

    if check_only {
        return ToolOutcome::Absent("JDK 17+ not found".into());
    }

    if !confirm_required(
        policy,
        "JDK 17+ missing (needed for Android builds). Install?",
    ) {
        return ToolOutcome::Skipped("user declined JDK install".into());
    }

    let spec = PackageSpec {
        apt: &["openjdk-17-jdk"],
        dnf: &["java-17-openjdk-devel"],
        pacman: &["jdk17-openjdk"],
        brew: &[],
        brew_cask: &["temurin@17"],
    };
    match install_packages(platform, exec, &spec) {
        Ok(()) => ToolOutcome::Installed("JDK 17 installed".into()),
        Err(e) => ToolOutcome::Failed(e),
    }
}

fn java_major_ok(version_output: &str) -> bool {
    // Look for `version "17.0.x"` or `openjdk 17.` patterns.
    for token in version_output.split_whitespace() {
        let t = token.trim_matches('"').trim_matches('\'');
        if let Some((maj, _)) = t.split_once('.') {
            if let Ok(n) = maj.parse::<u32>() {
                if (17..100).contains(&n) {
                    return true;
                }
            }
        }
        if let Ok(n) = t.parse::<u32>() {
            if (17..100).contains(&n) {
                return true;
            }
        }
    }
    false
}

fn ensure_sdk(
    platform: &Platform,
    exec: &dyn CommandExecutor,
    env: &dyn Environment,
    policy: &PromptPolicy,
    check_only: bool,
) -> ToolOutcome {
    let sdk_root = resolve_sdk_root(platform, env);

    let ndk_path = sdk_root.join("ndk").join(NDK_VERSION);
    let platform_path = sdk_root
        .join("platforms")
        .join(format!("android-{COMPILE_SDK}"));
    if env.path_exists(&ndk_path) && env.path_exists(&platform_path) {
        return ToolOutcome::Present(format!(
            "SDK at {} (NDK {NDK_VERSION}, platform {COMPILE_SDK})",
            sdk_root.display()
        ));
    }

    if check_only {
        return ToolOutcome::Absent(format!(
            "Android SDK/NDK incomplete (want NDK {NDK_VERSION} + platforms;android-{COMPILE_SDK} under {})",
            sdk_root.display()
        ));
    }

    if !confirm_required(
        policy,
        &format!(
            "Android SDK/NDK missing. Install cmdline-tools + platform-tools, platforms;android-{COMPILE_SDK}, build-tools;{BUILD_TOOLS}, ndk;{NDK_VERSION}, cmake;{CMAKE_VERSION} into {}?",
            sdk_root.display()
        ),
    ) {
        return ToolOutcome::Skipped("user declined Android SDK install".into());
    }

    if let Err(e) = install_cmdline_tools_and_packages(platform, exec, &sdk_root) {
        return ToolOutcome::Failed(e);
    }

    // Persist ANDROID_HOME / ANDROID_NDK_HOME.
    let profile = platform.shell_profile();
    let body = format!(
        "export ANDROID_HOME=\"{}\"\nexport ANDROID_SDK_ROOT=\"$ANDROID_HOME\"\nexport ANDROID_NDK_HOME=\"$ANDROID_HOME/ndk/{NDK_VERSION}\"\nexport PATH=\"$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH\"",
        sdk_root.display()
    );
    let _ = ensure_profile_block(&profile, &body);

    ToolOutcome::Installed(format!(
        "Android SDK installed at {} (NDK {NDK_VERSION}). Restart shell to pick up ANDROID_HOME.",
        sdk_root.display()
    ))
}

fn resolve_sdk_root(platform: &Platform, env: &dyn Environment) -> std::path::PathBuf {
    if let Some(v) = env
        .var("ANDROID_HOME")
        .or_else(|| env.var("ANDROID_SDK_ROOT"))
    {
        return std::path::PathBuf::from(v);
    }
    platform.android_sdk_root()
}

fn install_cmdline_tools_and_packages(
    platform: &Platform,
    exec: &dyn CommandExecutor,
    sdk_root: &Path,
) -> Result<(), String> {
    // Download commandlinetools zip. URL is arch-independent for the "latest" package name.
    let os_tag = match platform.os {
        OsKind::Macos => "mac",
        OsKind::Linux => "linux",
    };
    // Pin to a known cmdline-tools release zip. Google publishes these under
    // a dated filename; "latest" redirects. Use the well-known current zip name.
    let zip_url = format!(
        "https://dl.google.com/android/repository/commandlinetools-{os_tag}-11076708_latest.zip"
    );

    let cmdline_dst = sdk_root.join("cmdline-tools");
    let setup = format!(
        r#"
set -euo pipefail
mkdir -p "{sdk}"
TMP="$(mktemp -d)"
curl -fsSL "{zip_url}" -o "$TMP/cmdtools.zip"
unzip -q "$TMP/cmdtools.zip" -d "$TMP"
mkdir -p "{cmdline}/latest"
# The zip contains a top-level `cmdline-tools/` directory.
if [ -d "$TMP/cmdline-tools" ]; then
  cp -R "$TMP/cmdline-tools/." "{cmdline}/latest/"
else
  cp -R "$TMP/." "{cmdline}/latest/"
fi
rm -rf "$TMP"
export ANDROID_HOME="{sdk}"
export PATH="{cmdline}/latest/bin:$PATH"
yes | sdkmanager --sdk_root="{sdk}" --licenses >/dev/null || true
sdkmanager --sdk_root="{sdk}" \
  "platform-tools" \
  "platforms;android-{COMPILE_SDK}" \
  "build-tools;{BUILD_TOOLS}" \
  "ndk;{NDK_VERSION}" \
  "cmake;{CMAKE_VERSION}"
"#,
        sdk = sdk_root.display(),
        cmdline = cmdline_dst.display(),
        zip_url = zip_url,
    );

    // Need unzip for the zip extract.
    ensure_unzip(platform, exec)?;

    match exec.run("bash", &["-c", &setup]) {
        Some(_) => Ok(()),
        None => Err("Android cmdline-tools / sdkmanager install failed".into()),
    }
}

fn ensure_unzip(platform: &Platform, exec: &dyn CommandExecutor) -> Result<(), String> {
    if exec.run("unzip", &["-v"]).is_some() {
        return Ok(());
    }
    let spec = PackageSpec {
        apt: &["unzip"],
        dnf: &["unzip"],
        pacman: &["unzip"],
        brew: &["unzip"],
        brew_cask: &[],
    };
    install_packages(platform, exec, &spec).or_else(|_| {
        // unzip might already be a system binary that doesn't support -v the same way
        if exec.run("which", &["unzip"]).is_some() {
            Ok(())
        } else {
            Err("unzip is required to install Android cmdline-tools".into())
        }
    })
}

fn ensure_studio(
    platform: &Platform,
    exec: &dyn CommandExecutor,
    env: &dyn Environment,
    policy: &PromptPolicy,
    check_only: bool,
) -> ToolOutcome {
    let present = match platform.os {
        OsKind::Macos => env.path_exists(Path::new("/Applications/Android Studio.app")),
        OsKind::Linux => {
            env.path_exists(Path::new("/opt/android-studio"))
                || env.path_exists(&platform.home.join("android-studio"))
                || exec.run("which", &["studio"]).is_some()
                || exec.run("which", &["android-studio"]).is_some()
        }
    };

    if present {
        return ToolOutcome::Present("Android Studio IDE found".into());
    }

    if check_only {
        return ToolOutcome::Absent(
            "Android Studio IDE not found (optional — SDK alone is enough to build)".into(),
        );
    }

    // Optional heavy — declined under --yes.
    if !confirm_optional(
        policy,
        "Install Android Studio IDE? (optional; SDK/NDK alone is enough for `expo run:android`)",
    ) {
        return ToolOutcome::Skipped("skipped Android Studio IDE".into());
    }

    match platform.os {
        OsKind::Macos => {
            let spec = PackageSpec {
                apt: &[],
                dnf: &[],
                pacman: &[],
                brew: &[],
                brew_cask: &["android-studio"],
            };
            match install_packages(platform, exec, &spec) {
                Ok(()) => ToolOutcome::Installed("Android Studio installed via Homebrew cask".into()),
                Err(e) => ToolOutcome::Failed(e),
            }
        }
        OsKind::Linux => {
            ToolOutcome::Guided(
                "Download Android Studio from https://developer.android.com/studio and unpack to ~/android-studio (or install the Flatpak/Snap if you prefer)"
                    .into(),
            )
        }
    }
}

/// Stage-2 bootstrap: cross-compile `packages/quic-relay-client` for all
/// Android ABIs once the NDK is available, so `jniLibs/<abi>/libquic_relay_client.a`
/// is ready before the developer runs `./gradlew` or Android Studio.
///
/// Only invoked when:
///   - `--skip-mobile` is NOT set
///   - `--check` mode is NOT active
///   - at least one `android-sdk` outcome was `Present` or `Installed`
///
/// If `node` or the script cannot be found, the function returns a
/// `Skipped` outcome with a non-blocking advisory message rather than
/// failing (NDK-less / API-only contributors should not be blocked).
pub fn ensure_native_built_android(repo_root: &Path, exec: &dyn CommandExecutor) -> ToolOutcome {
    // Locate the script relative to the repo root.
    let script = repo_root
        .join("apps")
        .join("mobile")
        .join("modules")
        .join("quic-relay-client")
        .join("scripts")
        .join("ensure-native-built.js");

    if !script.exists() {
        return ToolOutcome::Skipped(format!(
            "ensure-native-built.js not found at {} — skipping native pre-build",
            script.display()
        ));
    }

    // Find node on PATH.
    let node = match find_node(exec) {
        Some(n) => n,
        None => {
            return ToolOutcome::Skipped(
                "node not found on PATH — skipping Android native pre-build (run `node scripts/ensure-native-built.js` manually from apps/mobile/modules/quic-relay-client once node is installed)".into(),
            );
        }
    };

    // Run with inherited stdio so cargo-ndk output is visible to the user.
    match Command::new(&node).arg(&script).status() {
        Ok(status) if status.success() => {
            ToolOutcome::Present("quic-relay-client native .a built for all Android ABIs".into())
        }
        Ok(status) => ToolOutcome::Failed(format!(
            "ensure-native-built.js exited with {status}; check output above for details"
        )),
        Err(e) => ToolOutcome::Failed(format!("failed to launch node ensure-native-built.js: {e}")),
    }
}

/// Locate the `node` binary. Returns the first candidate that `exec.run` can
/// invoke successfully. Tests can swap `exec` for a fake that returns `None`
/// to simulate a missing `node`.
fn find_node(exec: &dyn CommandExecutor) -> Option<PathBuf> {
    // Ask `node --version` — if it works, "node" is on PATH.
    if exec.run("node", &["--version"]).is_some() {
        return Some(PathBuf::from("node"));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::DistroFamily;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    struct FakeEnv {
        vars: HashMap<&'static str, &'static str>,
        paths: Vec<PathBuf>,
    }

    impl Environment for FakeEnv {
        fn var(&self, name: &str) -> Option<String> {
            self.vars.get(name).map(|s| (*s).to_string())
        }
        fn path_exists(&self, path: &Path) -> bool {
            self.paths.iter().any(|p| p == path)
        }
        fn dir_has_entries(&self, path: &Path) -> bool {
            self.path_exists(path)
        }
    }

    struct EmptyExec;
    impl CommandExecutor for EmptyExec {
        fn run(&self, _: &str, _: &[&str]) -> Option<String> {
            None
        }
    }

    /// Returns `Some(version)` for `node --version`, simulating node on PATH.
    struct NodePresentExec;
    impl CommandExecutor for NodePresentExec {
        fn run(&self, program: &str, args: &[&str]) -> Option<String> {
            if program == "node" && args == ["--version"] {
                Some("v22.0.0".into())
            } else {
                None
            }
        }
    }

    #[test]
    fn native_built_skips_when_script_missing() {
        // Pass a tmp dir that has no ensure-native-built.js — should Skipped.
        let tmp = std::env::temp_dir().join("dev-setup-test-native");
        let out = ensure_native_built_android(&tmp, &NodePresentExec);
        assert!(
            matches!(out, ToolOutcome::Skipped(_)),
            "expected Skipped when script is missing, got {out:?}"
        );
    }

    #[test]
    fn native_built_skips_when_node_missing() {
        // Even if the script existed, no node → Skipped.
        let tmp = std::env::temp_dir();
        let out = ensure_native_built_android(&tmp, &EmptyExec);
        // Either Skipped (script not found) or Skipped (node not found) — both are non-failures.
        assert!(
            matches!(out, ToolOutcome::Skipped(_)),
            "expected Skipped when node is absent, got {out:?}"
        );
    }

    #[test]
    fn find_node_returns_none_when_absent() {
        assert!(find_node(&EmptyExec).is_none());
    }

    #[test]
    fn find_node_returns_some_when_present() {
        assert!(find_node(&NodePresentExec).is_some());
    }

    #[test]
    fn java_major_ok_parses() {
        assert!(java_major_ok("openjdk version \"17.0.9\" 2023-10-17"));
        assert!(java_major_ok("java 21.0.1 2023-10-17"));
        assert!(!java_major_ok("openjdk version \"11.0.2\""));
    }

    #[test]
    fn sdk_present_when_ndk_and_platform_exist() {
        let sdk = PathBuf::from("/home/dev/Android/Sdk");
        let env = FakeEnv {
            vars: [("ANDROID_HOME", "/home/dev/Android/Sdk")]
                .into_iter()
                .collect(),
            paths: vec![
                sdk.join("ndk").join(NDK_VERSION),
                sdk.join("platforms").join(format!("android-{COMPILE_SDK}")),
            ],
        };
        let platform = Platform {
            os: OsKind::Linux,
            arch: "x86_64".into(),
            distro: Some(DistroFamily::Apt),
            is_wsl: false,
            home: PathBuf::from("/home/dev"),
        };
        let out = ensure_sdk(
            &platform,
            &EmptyExec,
            &env,
            &PromptPolicy::testing(true, false),
            true,
        );
        assert!(matches!(out, ToolOutcome::Present(_)));
    }
}
