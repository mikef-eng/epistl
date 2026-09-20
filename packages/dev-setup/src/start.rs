//! The opt-in `--start` action: brings up the local `docker compose`
//! stack (Postgres, NATS, SeaweedFS), waits for each service to report
//! healthy, then runs `moon run api:migrate`. Never runs unless the
//! caller explicitly passes `--start` (or answers yes to the interactive
//! prompt in `main.rs`).
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
use crate::tools::docker::{probe_docker_access, run_docker, DockerAccess};

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

    let access = match probe_docker_access(exec) {
        Some(a) => a,
        None => {
            return vec![StepOutcome::Failure(
                "docker daemon not reachable in this session (tried ambient `docker info` and `sg docker -c 'docker info'`). Log out and back in (or `newgrp docker`), then re-run with --start.".to_string(),
            )];
        }
    };

    let up_args = [
        "compose",
        "--project-directory",
        project_dir.as_str(),
        "up",
        "-d",
    ];
    let up = run_docker(exec, access, &up_args);
    if !up.status_ok {
        outcomes.push(StepOutcome::Failure(format!(
            "docker compose up -d failed: {}",
            up.failure_detail()
        )));
        return outcomes;
    }
    let via = match access {
        DockerAccess::Ambient => "",
        DockerAccess::ViaSg => " (via sg docker)",
    };
    outcomes.push(StepOutcome::Success(format!(
        "docker compose up -d succeeded{via}"
    )));

    for service in COMPOSE_SERVICES {
        match wait_for_healthy(exec, sleeper, access, &project_dir, service) {
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
    access: DockerAccess,
    project_dir: &str,
    service: &str,
) -> Result<(), String> {
    for attempt in 0..HEALTH_MAX_ATTEMPTS {
        if attempt > 0 {
            sleeper.sleep(HEALTH_POLL_INTERVAL);
        }
        let status = run_docker(
            exec,
            access,
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
        if status.status_ok && status.text().trim() == "healthy" {
            return Ok(());
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
    /// per-program canned response queue. Queued `None` means failure
    /// with empty stderr; use `queue_err` for failure with a diagnostic.
    struct RecordingExecutor {
        calls: RefCell<Vec<(String, Vec<String>)>>,
        responses: RefCell<HashMap<String, Vec<Queued>>>,
    }

    enum Queued {
        Ok(String),
        Err(String),
    }

    impl RecordingExecutor {
        fn new() -> Self {
            RecordingExecutor {
                calls: RefCell::new(Vec::new()),
                responses: RefCell::new(HashMap::new()),
            }
        }

        /// Queues `response` to be returned the next time `program` is
        /// invoked (FIFO per program). `None` = failure with no detail.
        fn queue(&self, program: &str, response: Option<&str>) {
            let entry = match response {
                Some(s) => Queued::Ok(s.to_string()),
                None => Queued::Err(String::new()),
            };
            self.responses
                .borrow_mut()
                .entry(program.to_string())
                .or_default()
                .push(entry);
        }

        fn queue_err(&self, program: &str, stderr: &str) {
            self.responses
                .borrow_mut()
                .entry(program.to_string())
                .or_default()
                .push(Queued::Err(stderr.to_string()));
        }

        fn calls(&self) -> Vec<(String, Vec<String>)> {
            self.calls.borrow().clone()
        }
    }

    impl CommandExecutor for RecordingExecutor {
        fn run(&self, program: &str, args: &[&str]) -> Option<String> {
            let output = self.run_output(program, args);
            if output.status_ok {
                Some(output.text())
            } else {
                None
            }
        }

        fn run_output(&self, program: &str, args: &[&str]) -> crate::checks::CommandOutput {
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
                crate::checks::CommandOutput {
                    status_ok: true,
                    stdout: "healthy".to_string(),
                    stderr: String::new(),
                }
            } else {
                match queue.remove(0) {
                    Queued::Ok(stdout) => crate::checks::CommandOutput {
                        status_ok: true,
                        stdout,
                        stderr: String::new(),
                    },
                    Queued::Err(stderr) => crate::checks::CommandOutput {
                        status_ok: false,
                        stdout: String::new(),
                        stderr,
                    },
                }
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
        // probe_docker_access: docker info
        assert_eq!(calls[0], ("docker".to_string(), vec!["info".to_string()]));
        assert_eq!(
            calls[1],
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
            calls[2],
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
    fn start_uses_sg_when_ambient_docker_info_fails() {
        let exec = RecordingExecutor::new();
        exec.queue("docker", None); // ambient info fails
        exec.queue("sg", Some("Server Version: 27.0.3")); // sg info ok
                                                          // further sg calls default to healthy
        let sleeper = FakeSleeper::new();

        let result = maybe_run_start(true, &exec, &sleeper, true, true, Path::new("/repo"))
            .expect("start was requested");

        assert_eq!(
            result[0],
            StepOutcome::Success("docker compose up -d succeeded (via sg docker)".to_string())
        );
        let calls = exec.calls();
        assert_eq!(calls[0].0, "docker");
        assert_eq!(calls[0].1, vec!["info".to_string()]);
        assert_eq!(calls[1].0, "sg");
        assert_eq!(calls[1].1[0], "docker");
        assert_eq!(calls[1].1[1], "-c");
        assert_eq!(calls[1].1[2], "docker info");
        // compose up via sg
        assert_eq!(calls[2].0, "sg");
        assert!(calls[2].1[2].contains("compose"));
        assert!(calls.iter().any(|(p, _)| p == "moon"));
    }

    #[test]
    fn docker_compose_up_failure_includes_stderr_and_stops() {
        let exec = RecordingExecutor::new();
        // probe info succeeds (default), then compose up fails with stderr
        exec.queue("docker", Some("Server Version: 27")); // info
        exec.queue_err(
            "docker",
            "permission denied while trying to connect to the Docker daemon socket",
        );
        let sleeper = FakeSleeper::new();

        let result = maybe_run_start(true, &exec, &sleeper, true, true, Path::new("/repo"))
            .expect("start was requested");

        assert_eq!(result.len(), 1);
        match &result[0] {
            StepOutcome::Failure(msg) => {
                assert!(msg.starts_with("docker compose up -d failed:"));
                assert!(msg.contains("permission denied"));
            }
            other => panic!("expected Failure, got {other:?}"),
        }
        // probe + up only -- no health polling, no moon.
        assert_eq!(exec.calls().len(), 2);
        assert!(exec.calls().iter().all(|(p, _)| p == "docker"));
    }

    #[test]
    fn health_wait_times_out_with_a_clear_message_and_stops_before_migrating() {
        let exec = RecordingExecutor::new();
        // Shared docker queue: info, up -d, then HEALTH_MAX_ATTEMPTS "starting".
        exec.queue("docker", Some("Server Version: 27")); // info
        exec.queue("docker", Some("")); // up -d
        for _ in 0..HEALTH_MAX_ATTEMPTS {
            exec.queue("docker", Some("starting")); // ps postgres
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
        assert!(exec.calls().iter().all(|(program, _)| program != "moon"));
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
