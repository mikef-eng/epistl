//! NATS connection setup.
//!
//! NATS (JetStream-enabled) backs the offline-delivery queue built out in
//! later issues in this batch -- see issue #12 for the design and issue
//! #51 (this module) for the initial connectivity groundwork. This module
//! only proves the API can connect to a real NATS server at startup; it
//! defines no streams/consumers and publishes/subscribes to nothing on its
//! own (see `apps/api/tests/nats.rs` for a connectivity smoke test against
//! a plain, non-JetStream subject).

use std::env;
use std::fmt;

/// Environment variable read for the NATS connection URL.
pub const NATS_URL_VAR: &str = "NATS_URL";

/// Errors that can occur while connecting to NATS at startup.
#[derive(Debug)]
pub enum NatsError {
    /// `NATS_URL` was not set (or was not valid UTF-8) in the environment.
    MissingNatsUrl,
    /// The client could not connect to the configured NATS server.
    Connect(async_nats::ConnectError),
}

impl fmt::Display for NatsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            NatsError::MissingNatsUrl => {
                write!(f, "{NATS_URL_VAR} must be set to connect to NATS")
            }
            NatsError::Connect(err) => write!(f, "failed to connect to NATS: {err}"),
        }
    }
}

impl std::error::Error for NatsError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            NatsError::MissingNatsUrl => None,
            NatsError::Connect(err) => Some(err),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn connect_with_invalid_url_fails_fast() {
        // Port 1 is not listening in any test environment; async-nats
        // gives up on the initial connect rather than retrying forever.
        let result = connect_with("nats://localhost:1").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn connect_reports_missing_nats_url() {
        // SAFETY: this test does not run concurrently with other tests
        // that read/write NATS_URL.
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
