//! `dev-setup`: interactive (default) / detect-only (`--check`) local
//! toolchain installer for Epistl (issues #222–#224). Prefer entering via
//! `bash packages/dev-setup/bootstrap.sh` on a fresh machine.

use std::process::ExitCode;

use dev_setup::tools::android::ensure_android;
use dev_setup::tools::docker::ensure_docker;
use dev_setup::tools::ios::ensure_ios;
use dev_setup::tools::moon::ensure_moon;
use dev_setup::tools::node::ensure_node;
use dev_setup::tools::npm::ensure_mobile_deps;
use dev_setup::tools::rust::ensure_rust;
use dev_setup::tools::sccache::ensure_sccache;
use dev_setup::{
    ensure_env_files, format_outcome, format_step_outcome, maybe_run_start, repo_root, Flags,
    Platform, PromptPolicy, RealSleeper, StepOutcome, SystemEnvironment, SystemExecutor,
    ToolOutcome,
};

fn main() -> ExitCode {
    let flags = Flags::parse(std::env::args());
    let platform = match Platform::detect() {
        Ok(p) => p,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::FAILURE;
        }
    };

    let policy = PromptPolicy::from_flags(flags.yes);
    let check_only = flags.check;
    let executor = SystemExecutor;
    let environment = SystemEnvironment;
    let repo_root = repo_root();

    println!("Epistl dev-setup");
    println!(
        "  platform: {:?} ({}){}",
        platform.os,
        platform.arch,
        if platform.is_wsl { " [WSL]" } else { "" }
    );
    if let Some(d) = platform.distro {
        println!("  distro family: {d:?}");
    }
    println!(
        "  mode: {}",
        if check_only {
            "check-only"
        } else if policy.yes {
            "install (--yes)"
        } else {
            "interactive install"
        }
    );
    println!();

    // --- .env bootstrap (safe, always) ---
    match ensure_env_files(&repo_root) {
        Ok(b) => {
            match b.root {
                dev_setup::EnvFileOutcome::Created => {
                    println!(
                        ".env: created from .env.example (SEAWEEDFS_INTERNAL_ENDPOINT → localhost)"
                    )
                }
                dev_setup::EnvFileOutcome::AlreadyPresent => {
                    println!(".env: already present")
                }
            }
            match b.mobile {
                dev_setup::EnvFileOutcome::Created => {
                    println!("apps/mobile/.env: created from .env.example")
                }
                dev_setup::EnvFileOutcome::AlreadyPresent => {
                    println!("apps/mobile/.env: already present (or example missing)")
                }
            }
        }
        Err(err) => {
            eprintln!("failed to set up .env files: {err}");
            return ExitCode::FAILURE;
        }
    }
    println!();

    // --- Core tools ---
    println!("Core tools:");
    let mut failed = false;

    let outcomes: Vec<(&str, ToolOutcome, bool)> = vec![
        ("rust", ensure_rust(&executor, &policy, check_only), true),
        (
            "sccache",
            ensure_sccache(&executor, &policy, check_only),
            true,
        ),
        (
            "node",
            ensure_node(&platform, &executor, &policy, check_only),
            true,
        ),
        (
            "moon",
            ensure_moon(&platform, &executor, &policy, check_only),
            true,
        ),
        (
            "docker",
            ensure_docker(&platform, &executor, &policy, check_only),
            true,
        ),
    ];

    for (name, outcome, required) in &outcomes {
        println!("{}", format_outcome(name, outcome));
        if outcome.is_blocking_failure(*required) {
            failed = true;
        }
    }

    // npm ci (needs node)
    let npm_outcome = ensure_mobile_deps(&executor, &policy, check_only, &repo_root);
    println!("{}", format_outcome("mobile-deps", &npm_outcome));
    // npm ci absence is non-blocking in check mode for API-only contributors,
    // but a Failed install attempt is blocking.
    if matches!(npm_outcome, ToolOutcome::Failed(_)) {
        failed = true;
    }

    // --- Mobile toolchains ---
    if !flags.skip_mobile {
        println!();
        println!("Mobile toolchains (optional; pass --skip-mobile to skip):");
        for (name, outcome) in
            ensure_android(&platform, &executor, &environment, &policy, check_only)
        {
            println!("{}", format_outcome(&name, &outcome));
            // Android items are optional unless the user asked to install and it failed.
            if matches!(outcome, ToolOutcome::Failed(_)) {
                failed = true;
            }
        }
        for (name, outcome) in ensure_ios(&platform, &executor, &environment, &policy, check_only) {
            println!("{}", format_outcome(&name, &outcome));
            if matches!(outcome, ToolOutcome::Failed(_)) {
                failed = true;
            }
        }
    } else {
        println!();
        println!("Mobile toolchains: skipped (--skip-mobile)");
    }

    // --- Start stack ---
    let docker_ok = matches!(
        outcomes
            .iter()
            .find(|(n, _, _)| *n == "docker")
            .map(|(_, o, _)| o),
        Some(ToolOutcome::Present(_)) | Some(ToolOutcome::Installed(_))
    );
    let moon_ok = matches!(
        outcomes
            .iter()
            .find(|(n, _, _)| *n == "moon")
            .map(|(_, o, _)| o),
        Some(ToolOutcome::Present(_)) | Some(ToolOutcome::Installed(_))
    );

    let start_requested = if flags.check || flags.no_start {
        false
    } else if flags.start {
        true
    } else if check_only {
        false
    } else {
        // Interactive: offer to start.
        use dev_setup::prompt::confirm_required;
        confirm_required(
            &policy,
            "Bring up docker compose (postgres/nats/seaweedfs) and run migrations?",
        )
    };

    let sleeper = RealSleeper;
    let mut start_failed = false;
    if let Some(step_outcomes) = maybe_run_start(
        start_requested,
        &executor,
        &sleeper,
        docker_ok,
        moon_ok,
        &repo_root,
    ) {
        println!();
        println!("Start:");
        for outcome in &step_outcomes {
            println!("{}", format_step_outcome(outcome));
            if matches!(outcome, StepOutcome::Failure(_)) {
                start_failed = true;
            }
        }
    }

    if failed || start_failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}
