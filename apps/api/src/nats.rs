//! NATS connection setup.
//!
//! NATS (JetStream-enabled) backs the offline-delivery queue built out in
//! later issues in this batch -- see issue #12 for the design, issue #51
//! (initial connectivity groundwork), and issue #52 (this module's
//! `ensure_offline_stream`, which configures the actual transient
//! delivery-queue stream -- see
//! `docs/decisions/0008-jetstream-transient-offline-queue.md` for why it's
//! shaped the way it is). Publishing to / consuming from the stream itself
//! is out of scope here -- see the follow-up issues in this batch.

use std::env;
use std::fmt;
use std::time::Duration;

use async_nats::jetstream::stream::{Config as StreamConfig, RetentionPolicy, StorageType};
use async_nats::jetstream::{context::CreateStreamError, stream::Stream, Context};
use uuid::Uuid;

/// Environment variable read for the NATS connection URL.
pub const NATS_URL_VAR: &str = "NATS_URL";

/// Name of the JetStream stream used as the transient, short-TTL delivery
/// queue for messages sent to an offline recipient. See
/// `docs/decisions/0008-jetstream-transient-offline-queue.md`.
pub const OFFLINE_STREAM_NAME: &str = "EPISTL_OFFLINE_MESSAGES";

/// Subject filter the offline-delivery stream captures: one subject per
/// recipient, `epistl.offline.<user_id>`.
pub const OFFLINE_STREAM_SUBJECTS: &str = "epistl.offline.*";

/// Returns the JetStream subject a message queued for `user_id` (because
/// they weren't connected at send time -- see `crate::relay::handle_send`) is
/// published to: one subject per recipient, matching the
/// [`OFFLINE_STREAM_SUBJECTS`] filter.
pub fn offline_subject(user_id: Uuid) -> String {
    format!("epistl.offline.{user_id}")
}

/// Environment variable read for the offline-delivery queue's message TTL,
/// in seconds. See [`DEFAULT_OFFLINE_QUEUE_MAX_AGE_SECS`] for the default
/// applied when unset.
pub const OFFLINE_QUEUE_MAX_AGE_SECS_VAR: &str = "OFFLINE_QUEUE_MAX_AGE_SECS";

/// Default TTL (24 hours, in seconds) applied to the offline-delivery
/// stream when `OFFLINE_QUEUE_MAX_AGE_SECS` is unset. Always a concrete,
/// bounded value -- see ADR 0008 for why this is operator-tunable rather
/// than hardcoded.
pub const DEFAULT_OFFLINE_QUEUE_MAX_AGE_SECS: u64 = 86_400;

/// Errors that can occur while connecting to NATS at startup, or while
/// configuring the offline-delivery JetStream stream.
#[derive(Debug)]
pub enum NatsError {
    /// `NATS_URL` was not set (or was not valid UTF-8) in the environment.
    MissingNatsUrl,
    /// The client could not connect to the configured NATS server.
    Connect(async_nats::ConnectError),
    /// The offline-delivery stream could not be created or fetched.
    CreateStream(CreateStreamError),
}

impl fmt::Display for NatsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            NatsError::MissingNatsUrl => {
                write!(f, "{NATS_URL_VAR} must be set to connect to NATS")
            }
            NatsError::Connect(err) => write!(f, "failed to connect to NATS: {err}"),
            NatsError::CreateStream(err) => {
                write!(
                    f,
                    "failed to create/fetch {OFFLINE_STREAM_NAME} stream: {err}"
                )
            }
        }
    }
}

impl std::error::Error for NatsError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            NatsError::MissingNatsUrl => None,
            NatsError::Connect(err) => Some(err),
            NatsError::CreateStream(err) => Some(err),
        }
    }
}

/// Reads `NATS_URL` from the environment and connects, failing with a
/// descriptive [`NatsError`] rather than panicking so the caller can log
/// the problem and exit non-zero -- mirroring `crate::db::connect`.
pub async fn connect() -> Result<async_nats::Client, NatsError> {
    let nats_url = env::var(NATS_URL_VAR).map_err(|_| NatsError::MissingNatsUrl)?;
    connect_with(&nats_url).await
}

/// Connects to an explicit NATS URL. Split out from [`connect`] so tests
/// can point at a server without mutating process-wide environment state.
pub async fn connect_with(nats_url: &str) -> Result<async_nats::Client, NatsError> {
    async_nats::connect(nats_url)
        .await
        .map_err(NatsError::Connect)
}

/// Reads [`OFFLINE_QUEUE_MAX_AGE_SECS_VAR`] from the environment, falling
/// back to [`DEFAULT_OFFLINE_QUEUE_MAX_AGE_SECS`] if it's unset or not a
/// valid non-negative integer.
fn offline_queue_max_age() -> Duration {
    let secs = env::var(OFFLINE_QUEUE_MAX_AGE_SECS_VAR)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_OFFLINE_QUEUE_MAX_AGE_SECS);
    Duration::from_secs(secs)
}

/// Idempotently creates (or fetches, if it already exists) the
/// [`OFFLINE_STREAM_NAME`] JetStream stream: the transient, short-TTL
/// delivery queue for messages sent to an offline recipient.
///
/// This is a delivery queue, not durable message storage -- see
/// `docs/decisions/0001-message-content-never-in-postgres.md` and
/// `docs/decisions/0008-jetstream-transient-offline-queue.md`. `retention:
/// WorkQueuePolicy` removes a message as soon as any consumer acks it, and
/// `max_age` (read from [`OFFLINE_QUEUE_MAX_AGE_SECS_VAR`], defaulting to
/// [`DEFAULT_OFFLINE_QUEUE_MAX_AGE_SECS`]) auto-expires a message that's
/// never delivered. `storage: File` is only about surviving an API process
/// restart while a recipient is still offline within that TTL window --
/// `max_age` and the work-queue ack semantics still bound total retention
/// regardless of storage backend.
///
/// Calling this again against an already-existing stream is a no-op that
/// returns the existing stream rather than erroring.
pub async fn ensure_offline_stream(jetstream: &Context) -> Result<Stream, NatsError> {
    jetstream
        .get_or_create_stream(StreamConfig {
            name: OFFLINE_STREAM_NAME.to_string(),
            subjects: vec![OFFLINE_STREAM_SUBJECTS.to_string()],
            retention: RetentionPolicy::WorkQueue,
            max_age: offline_queue_max_age(),
            storage: StorageType::File,
            ..Default::default()
        })
        .await
        .map_err(NatsError::CreateStream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[tokio::test]
    async fn connect_with_invalid_url_fails_fast() {
        // Port 1 is not listening in any test environment; async-nats
        // gives up on the initial connect rather than retrying forever.
        let result = connect_with("nats://localhost:1").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    #[serial]
    async fn connect_reports_missing_nats_url() {
        // SAFETY: `#[serial]` (default, unnamed group -- shared with
        // `relay::tests`' `#[serial]` tests) ensures this test does not run
        // concurrently with any other test in this binary that reads or
        // writes NATS_URL. Confirmed mechanism (issue #121): without this,
        // `relay::tests::test_state()`'s `dotenvy::dotenv()` call, running
        // concurrently on another thread, can repopulate the just-removed
        // NATS_URL from `.env` before this test's own `connect()` call
        // reads it, flipping the expected `MissingNatsUrl` into a spurious
        // `Ok(Client)`.
        let previous = env::var(NATS_URL_VAR).ok();
        unsafe {
            env::remove_var(NATS_URL_VAR);
        }

        let result = connect().await;

        if let Some(previous) = previous {
            unsafe {
                env::set_var(NATS_URL_VAR, previous);
            }
        }

        match result {
            Err(NatsError::MissingNatsUrl) => {}
            other => panic!("expected MissingNatsUrl, got {other:?}"),
        }
    }
}
