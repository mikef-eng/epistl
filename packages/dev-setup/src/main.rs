//! `dev-setup`: checks a macOS/Linux dev machine against what README's
//! "Running the stack locally" section requires (issue #203). Detect-only
//! plus one safe filesystem auto-fix (`.env` copy), except for the
//! opt-in `--install` path on apt-based Linux distros (issue #205),
//! which can auto-install rustup/moon/sccache via their official
//! installers. See those issues for what's still out of scope
//! (`docker compose up`, migrations, non-apt distro-specific installs).

use std::process::ExitCode;

use dev_setup::{
    apt_available, check_os, docker_action, ensure_env_file, format_check_line,
    format_linux_action, has_install_flag, is_required, moon_action, node_action, repo_root,
    run_all_checks, rustup_action, sccache_action, EnvFileOutcome, SystemExecutor,
};

fn main() -> ExitCode {
    let os = std::env::consts::OS;
    if let Err(message) = check_os(os) {
        eprintln!("{message}");
        return ExitCode::FAILURE;
    }

    let install_flag = has_install_flag(std::env::args());

    let repo_root = repo_root();

    match ensure_env_file(&repo_root) {
        Ok(EnvFileOutcome::Created) => println!("copied .env.example to .env"),
        Ok(EnvFileOutcome::AlreadyPresent) => println!(".env already present, skipping"),
        Err(err) => {
            eprintln!("failed to set up .env: {err}");
            return ExitCode::FAILURE;
        }
    }

    println!();
    println!("Environment checks:");
    let executor = SystemExecutor;
    let checks = run_all_checks(&executor);

    let mut all_required_present = true;
    for check in &checks {
        println!("{}", format_check_line(check));
        if is_required(check.name) && !check.status.is_present() {
            all_required_present = false;
        }
    }

    // Linux-only: for each absent tool, report what this tool would do
    // (or already did, with `--install`) about it. No behavior change on
    // macOS or elsewhere from this block -- see issue #205.
    if os == "linux" {
        let apt_present = apt_available(&executor);
        let absent: Vec<_> = checks.iter().filter(|c| !c.status.is_present()).collect();
        if !absent.is_empty() {
            println!();
            println!("Linux install guidance:");
            for check in absent {
                let action = match check.name {
                    "rustup" => Some(rustup_action(&executor, apt_present, install_flag)),
                    "moon" => Some(moon_action(&executor, apt_present, install_flag)),
                    "sccache" => Some(sccache_action(&executor, apt_present, install_flag)),
                    "node" => Some(node_action(apt_present)),
                    "docker" => Some(docker_action(apt_present)),
                    // "cargo/rustc": no separate auto-install path beyond
                    // rustup itself (see the rustup line above).
                    _ => None,
                };
                if let Some(action) = action {
                    println!("{}", format_linux_action(check.name, &action));
                }
            }
        }
    }

    if all_required_present {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
