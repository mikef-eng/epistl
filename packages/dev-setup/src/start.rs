//! The opt-in `--start` action (issue #206): brings up the local
//! `docker compose` stack (Postgres, NATS, SeaweedFS), waits for each
//! service to report healthy, then runs `moon run api:migrate`. This is
//! the one mutating action `dev-setup` performs against Docker/moon --
//! it never runs unless the caller explicitly passes `--start`, matching
//! the "no mutation without explicit opt-in" pattern `--install`
//! established for the OS-specific issues.
//!
//! `docker-compose.yml` already declares a healthcheck for each of the
//! three services (`pg_isready`, `wget .../healthz`, `curl
//! .../cluster/status` -- the same three `.github/workflows/ci.yml`
//! checks directly). Rather than re-implementing those commands here
//! (which would require duplicating DB user/password, the NATS
//! monitoring port, and the SeaweedFS bucket name that already live in
//! `.env`/`docker-compose.yml`), this module polls Docker's own computed
//! health status for each service via `docker compose ps --format
//! {{.Health}}` -- the same underlying checks, asked the way an external
//! orchestrator is meant to ask them. This also sidesteps a real
//! constraint: `docker-compose.yml` only publishes NATS's monitoring port
//! (8222) and SeaweedFS's master port (9333) *inside* the compose
//! network, not to the host, so `dev-setup` (a host process) couldn't
//! `curl`/`wget` them directly the way `.github/workflows/ci.yml`'s
//! runner-local containers can.

use std::path::Path;
use std::time::Duration;

use crate::checks::CommandExecutor;

/// Abstracts the polling delay between health-check attempts so
/// `wait_for_healthy`'s loop is real time in production but instantaneous
/// (and call-counted) under test -- without this, a test exercising the
/// timeout path would otherwise really sleep for `HEALTH_MAX_ATTEMPTS *
/// HEALTH_POLL_INTERVAL`.
pub trait Sleeper {
    fn sleep(&self, duration: Duration);
}

/// The real sleeper, backed by `std::thread::sleep`.
pub struct RealSleeper;

impl Sleeper for RealSleeper {
    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

/// One step of `--start`'s report, in the order attempted. `run_start`
/// stops at the first `Failure` -- each step depends on the previous one
/// having actually succeeded (waiting on a container that was never
/// started, or migrating against a database that isn't up yet, aren't
/// meaningful things to attempt).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StepOutcome {
    Success(String),
    Failure(String),
}

/// Matches `.github/workflows/ci.yml`'s own `timeout 30s` / `sleep 1`
/// polling loops for NATS and SeaweedFS -- a bounded timeout with a
/// clear per-service failure message on expiry, per the issue's
/// acceptance criteria.
const HEALTH_POLL_INTERVAL: Duration = Duration::from_secs(1);
const HEALTH_MAX_ATTEMPTS: u32 = 30;

/// The three `docker-compose.yml` services `--start` waits on, in the
/// order that file declares them.
const COMPOSE_SERVICES: &[&str] = &["postgres", "nats", "seaweedfs"];

/// Runs `--start`'s full flow if `start_requested` is set, otherwise does
/// nothing at all -- not even a Docker/moon presence check -- and returns
/// `None`. This is the single call site `main.rs` uses, so "the `--start`
/// flag wasn't passed" and "nothing was invoked" are structurally the
/// same fact, not something that can drift apart.
pub fn maybe_run_start(
    start_requested: bool,
    exec: &dyn CommandExecutor,
    sleeper: &dyn Sleeper,
    docker_present: bool,
    moon_present: bool,
    repo_root: &Path,
) -> Option<Vec<StepOutcome>> {
    if !start_requested {
        return None;
    }
    Some(run_start(
        exec,
        sleeper,
        docker_present,
        moon_present,
        repo_root,
    ))
}

/// Runs `docker compose up -d`, waits for postgres/nats/seaweedfs to
/// report healthy, then `moon run api:migrate`. `docker_present` and
/// `moon_present` come from the same checks the environment-check report
/// already ran (see `checks::run_all_checks`) -- reused here rather than
/// re-probing, and checked *before* running anything: if either is
/// absent, this is a no-op (a clear message, no partial mutation), never
/// an attempt to shell out to a missing binary.
fn run_start(
    exec: &dyn CommandExecutor,
    sleeper: &dyn Sleeper,
    docker_present: bool,
    moon_present: bool,
    repo_root: &Path,
) -> Vec<StepOutcome> {
    if !docker_present {
        return vec![StepOutcome::Failure(
            "docker is Absent -- skipping --start (nothing was run). Install Docker, then re-run with --start.".to_string(),
        )];
    }
    if !moon_present {
        return vec![StepOutcome::Failure(
            "moon is Absent -- skipping --start (nothing was run). Install moon, then re-run with --start.".to_string(),
        )];
    }

    let mut outcomes = Vec::new();
    let project_dir = repo_root.to_string_lossy().to_string();

    let up_args = [
        "compose",
        "--project-directory",
        project_dir.as_str(),
        "up",
        "-d",
    ];
    if exec.run("docker", &up_args).is_none() {
        outcomes.push(StepOutcome::Failure(
            "docker compose up -d failed -- see docker's own output above for details.".to_string(),
        ));
        return outcomes;
    }
    outcomes.push(StepOutcome::Success(
        "docker compose up -d succeeded".to_string(),
    ));

    for service in COMPOSE_SERVICES {
        match wait_for_healthy(exec, sleeper, &project_dir, service) {
            Ok(()) => outcomes.push(StepOutcome::Success(format!("{service} is healthy"))),
            Err(message) => {
                outcomes.push(StepOutcome::Failure(message));
                return outcomes;
            }
        }
    }

    let migrate_args = ["run", "api:migrate"];
    if exec.run("moon", &migrate_args).is_none() {
        outcomes.push(StepOutcome::Failure(
            "moon run api:migrate failed -- see moon's own output above for details.".to_string(),
        ));
        return outcomes;
    }
    outcomes.push(StepOutcome::Success(
        "moon run api:migrate succeeded".to_string(),
    ));

    outcomes
}

/// Polls `docker compose ps <service> --format {{.Health}}` until it
/// reports `healthy`, up to `HEALTH_MAX_ATTEMPTS` attempts
/// `HEALTH_POLL_INTERVAL` apart. Returns a clear, service-named failure
/// message on timeout rather than silently giving up.
fn wait_for_healthy(
    exec: &dyn CommandExecutor,
    sleeper: &dyn Sleeper,
    project_dir: &str,
    service: &str,
) -> Result<(), String> {
    for attempt in 0..HEALTH_MAX_ATTEMPTS {
        if attempt > 0 {
            sleeper.sleep(HEALTH_POLL_INTERVAL);
        }
        let status = exec.run(
            "docker",
            &[
                "compose",
                "--project-directory",
                project_dir,
                "ps",
                service,
                "--format",
                "{{.Health}}",
            ],
        );
        if let Some(status) = status {
            if status.trim() == "healthy" {
                return Ok(());
            }
        }
    }
    let timeout_secs = HEALTH_MAX_ATTEMPTS as u64 * HEALTH_POLL_INTERVAL.as_secs();
    Err(format!(
        "{service} did not become healthy within {timeout_secs}s -- check `docker compose logs {service}`."
    ))
}

/// Formats one `StepOutcome` as a single report line, mirroring
/// `format_check_line`'s style for the environment-check report.
pub fn format_step_outcome(outcome: &StepOutcome) -> String {
    match outcome {
        StepOutcome::Success(message) => format!("[start] OK: {message}"),
        StepOutcome::Failure(message) => format!("[start] FAILED: {message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// A no-op sleeper: records how many times it was asked to sleep
    /// (so tests can assert the timeout path actually retried the
    /// expected number of times) without ever really sleeping.
    struct FakeSleeper {
        calls: RefCell<u32>,
    }

    impl FakeSleeper {
        fn new() -> Self {
            FakeSleeper {
                calls: RefCell::new(0),
            }
        }
    }

    impl Sleeper for FakeSleeper {
        fn sleep(&self, _duration: Duration) {
            *self.calls.borrow_mut() += 1;
        }
    }

    /// Records every `(program, args)` call it receives, and returns a
    /// per-program canned response queue -- `ps` calls (used repeatedly
    /// by the health-wait loop) pop one response per call so a test can
    /// script "starting, starting, healthy" or "always absent" (never
    /// healthy -> timeout) sequences; `up`/`migrate` calls (called once)
    /// just use the first queued response.
    struct RecordingExecutor {
        calls: RefCell<Vec<(String, Vec<String>)>>,
        responses: RefCell<HashMap<String, Vec<Option<String>>>>,
    }

    impl RecordingExecutor {
        fn new() -> Self {
            RecordingExecutor {
                calls: RefCell::new(Vec::new()),
                responses: RefCell::new(HashMap::new()),
            }
        }

        /// Queues `response` to be returned the next time `program` is
        /// invoked (FIFO per program).
        fn queue(&self, program: &str, response: Option<&str>) {
            self.responses
                .borrow_mut()
                .entry(program.to_string())
                .or_default()
                .push(response.map(|s| s.to_string()));
        }

        fn calls(&self) -> Vec<(String, Vec<String>)> {
            self.calls.borrow().clone()
        }
    }

    impl CommandExecutor for RecordingExecutor {
        fn run(&self, program: &str, args: &[&str]) -> Option<String> {
            self.calls.borrow_mut().push((
                program.to_string(),
                args.iter().map(|a| a.to_string()).collect(),
            ));
            let mut responses = self.responses.borrow_mut();
            let queue = responses.entry(program.to_string()).or_default();
            if queue.is_empty() {
                // Default to "healthy"/success for any call beyond what
                // was explicitly scripted, so tests only need to queue
                // the specific responses they care about.
                Some("healthy".to_string())
            } else {
                queue.remove(0)
            }
        }
    }

    #[test]
    fn flag_not_passed_invokes_nothing() {
        let exec = RecordingExecutor::new();
        let sleeper = FakeSleeper::new();

        let result = maybe_run_start(false, &exec, &sleeper, true, true, Path::new("/repo"));

        assert_eq!(result, None);
        assert_eq!(exec.calls(), Vec::new());
    }

    #[test]
    fn docker_absent_is_a_no_op_with_a_clear_message_and_no_shellout() {
        let exec = RecordingExecutor::new();
        let sleeper = FakeSleeper::new();

        let result = maybe_run_start(true, &exec, &sleeper, false, true, Path::new("/repo"))
            .expect("start was requested");

        assert_eq!(
            result,
            vec![StepOutcome::Failure(
                "docker is Absent -- skipping --start (nothing was run). Install Docker, then re-run with --start.".to_string()
            )]
        );
        assert_eq!(exec.calls(), Vec::new());
    }

    #[test]
    fn moon_absent_is_a_no_op_with_a_clear_message_and_no_shellout() {
        let exec = RecordingExecutor::new();
        let sleeper = FakeSleeper::new();

        let result = maybe_run_start(true, &exec, &sleeper, true, false, Path::new("/repo"))
            .expect("start was requested");

        assert_eq!(
            result,
            vec![StepOutcome::Failure(
                "moon is Absent -- skipping --start (nothing was run). Install moon, then re-run with --start.".to_string()
            )]
        );
        // Absent moon must not even trigger `docker compose up -d` --
        // this is a no-op, not a partial mutation.
        assert_eq!(exec.calls(), Vec::new());
    }

    #[test]
    fn successful_start_runs_expected_commands_with_expected_args() {
        let exec = RecordingExecutor::new();
        let sleeper = FakeSleeper::new();

        let result = maybe_run_start(true, &exec, &sleeper, true, true, Path::new("/repo"))
            .expect("start was requested");

        assert_eq!(
            result,
            vec![
                StepOutcome::Success("docker compose up -d succeeded".to_string()),
                StepOutcome::Success("postgres is healthy".to_string()),
                StepOutcome::Success("nats is healthy".to_string()),
                StepOutcome::Success("seaweedfs is healthy".to_string()),
                StepOutcome::Success("moon run api:migrate succeeded".to_string()),
            ]
        );

        let calls = exec.calls();
        assert_eq!(
            calls[0],
            (
                "docker".to_string(),
                vec![
                    "compose".to_string(),
                    "--project-directory".to_string(),
                    "/repo".to_string(),
                    "up".to_string(),
                    "-d".to_string(),
                ]
            )
        );
        assert_eq!(
            calls[1],
            (
                "docker".to_string(),
                vec![
                    "compose".to_string(),
                    "--project-directory".to_string(),
                    "/repo".to_string(),
                    "ps".to_string(),
                    "postgres".to_string(),
                    "--format".to_string(),
                    "{{.Health}}".to_string(),
                ]
            )
        );
        assert_eq!(calls.last().unwrap().0, "moon");
        assert_eq!(
            calls.last().unwrap().1,
            vec!["run".to_string(), "api:migrate".to_string()]
        );
    }

    #[test]
    fn docker_compose_up_failure_stops_before_waiting_or_migrating() {
        let exec = RecordingExecutor::new();
        exec.queue("docker", None);
        let sleeper = FakeSleeper::new();

        let result = maybe_run_start(true, &exec, &sleeper, true, true, Path::new("/repo"))
            .expect("start was requested");

        assert_eq!(
            result,
            vec![StepOutcome::Failure(
                "docker compose up -d failed -- see docker's own output above for details."
                    .to_string()
            )]
        );
        // Only the `up -d` call was made -- no health polling, no moon.
        assert_eq!(exec.calls().len(), 1);
    }

    #[test]
    fn health_wait_times_out_with_a_clear_message_and_stops_before_migrating() {
        let exec = RecordingExecutor::new();
        // `docker` is used for both `up -d` and `ps`, so the response
        // queue is shared: queue one "healthy" for the `up -d` call
        // itself, then `HEALTH_MAX_ATTEMPTS` "starting" responses so the
        // `ps postgres` polling loop never reaches "healthy" and the
        // loop exhausts its attempts.
        exec.queue("docker", Some("healthy")); // up -d
        for _ in 0..HEALTH_MAX_ATTEMPTS {
            exec.queue("docker", Some("starting")); // ps postgres, every attempt
        }
        let sleeper = FakeSleeper::new();

        let result = maybe_run_start(true, &exec, &sleeper, true, true, Path::new("/repo"))
            .expect("start was requested");

        assert_eq!(
            result,
            vec![
                StepOutcome::Success("docker compose up -d succeeded".to_string()),
                StepOutcome::Failure(
                    "postgres did not become healthy within 30s -- check `docker compose logs postgres`."
                        .to_string()
                ),
            ]
        );
        // No `moon` call at all -- migration never runs against a
        // database that never reported healthy.
        assert!(exec.calls().iter().all(|(program, _)| program != "moon"));
        // Slept between attempts (attempts - 1 times), not on the first.
        assert_eq!(*sleeper.calls.borrow(), HEALTH_MAX_ATTEMPTS - 1);
    }

    #[test]
    fn moon_migrate_failure_is_reported_after_all_services_are_healthy() {
        let exec = RecordingExecutor::new();
        exec.queue("moon", None);
        let sleeper = FakeSleeper::new();

        let result = maybe_run_start(true, &exec, &sleeper, true, true, Path::new("/repo"))
            .expect("start was requested");

        assert_eq!(
            result,
            vec![
                StepOutcome::Success("docker compose up -d succeeded".to_string()),
                StepOutcome::Success("postgres is healthy".to_string()),
                StepOutcome::Success("nats is healthy".to_string()),
                StepOutcome::Success("seaweedfs is healthy".to_string()),
                StepOutcome::Failure(
                    "moon run api:migrate failed -- see moon's own output above for details."
                        .to_string()
                ),
            ]
        );
    }

    #[test]
    fn format_step_outcome_variants() {
        assert_eq!(
            format_step_outcome(&StepOutcome::Success(
                "docker compose up -d succeeded".to_string()
            )),
            "[start] OK: docker compose up -d succeeded"
        );
        assert_eq!(
            format_step_outcome(&StepOutcome::Failure("nats did not become healthy within 30s -- check `docker compose logs nats`.".to_string())),
            "[start] FAILED: nats did not become healthy within 30s -- check `docker compose logs nats`."
        );
    }
}
