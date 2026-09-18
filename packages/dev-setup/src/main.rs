//! `dev-setup`: checks a macOS/Linux dev machine against what README's
//! "Running the stack locally" section requires (issue #203). Detect-only
//! plus one safe filesystem auto-fix (`.env` copy) -- see that issue for
//! what's deliberately out of scope (actual installs, `docker compose
//! up`, migrations).

use std::process::ExitCode;

use dev_setup::{
    check_os, ensure_env_file, format_check_line, is_required, repo_root, run_all_checks,
    EnvFileOutcome, SystemExecutor,
};

fn main() -> ExitCode {
    let os = std::env::consts::OS;
    if let Err(message) = check_os(os) {
        eprintln!("{message}");
        return ExitCode::FAILURE;
    }

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

    if all_required_present {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
