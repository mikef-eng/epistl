//! `dev-setup`: checks a macOS/Linux dev machine against what README's
//! "Running the stack locally" section requires (issue #203), and,
//! opt-in via `--start`, brings up the local `docker compose` stack and
//! runs API migrations (issue #206). Detect-only otherwise, plus one
//! safe filesystem auto-fix (`.env` copy) -- see issue #203 for what's
//! deliberately out of scope beyond `--start` (actual tool installs are
//! a separate opt-in flag tracked in the OS-specific issues).

use std::process::ExitCode;

use dev_setup::{
    check_os, check_status, ensure_env_file, format_check_line, format_step_outcome, is_required,
    maybe_run_start, repo_root, run_all_checks, EnvFileOutcome, RealSleeper, StepOutcome,
    SystemExecutor,
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

    // `--start` is the only flag this CLI accepts: opt-in orchestration
    // (docker compose up + health-wait + api:migrate) that never runs
    // unless explicitly requested -- see start.rs's module doc comment.
    let start_requested = std::env::args().skip(1).any(|arg| arg == "--start");
    let docker_present = check_status(&checks, "docker");
    let moon_present = check_status(&checks, "moon");
    let sleeper = RealSleeper;

    let mut start_failed = false;
    if let Some(outcomes) = maybe_run_start(
        start_requested,
        &executor,
        &sleeper,
        docker_present,
        moon_present,
        &repo_root,
    ) {
        println!();
        println!("Start:");
        for outcome in &outcomes {
            println!("{}", format_step_outcome(outcome));
            if matches!(outcome, StepOutcome::Failure(_)) {
                start_failed = true;
            }
        }
    }

    if all_required_present && !start_failed {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
