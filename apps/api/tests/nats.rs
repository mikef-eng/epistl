//! Integration test for `api::nats::connect_with` -- proves the client
//! connects to a real local NATS server and can publish/subscribe on a
//! plain (non-JetStream) subject.
//!
//! Requires `NATS_URL` to point at a reachable NATS server (see
//! `docker-compose.yml` for local dev, or the CI workflow's "Start NATS"
//! step -- see `apps/api/tests/ws.rs` for the same real-network-connection
//! pattern against Postgres).

use std::time::Duration;

use futures_util::StreamExt;
use tokio::time::timeout;
use uuid::Uuid;

/// How long a single `.next()` read from a test subscription is allowed
/// to take before the test fails, so a bug that drops delivery fails fast
/// instead of hanging CI.
const RECV_TIMEOUT: Duration = Duration::from_secs(5);

fn test_nats_url() -> String {
    dotenvy::dotenv().ok();
    std::env::var("NATS_URL").expect("NATS_URL must be set to run this integration test")
}

#[tokio::test]
async fn publishes_and_receives_on_a_plain_subject() {
    let client = api::nats::connect_with(&test_nats_url())
        .await
        .expect("failed to connect to NATS");

    // A unique subject per test run so parallel test runs (or a leftover
    // message from a previous run) can't cross-talk.
    let subject = format!("epistl.test.{}", Uuid::new_v4());

    let mut subscriber = client
        .subscribe(subject.clone())
        .await
        .expect("failed to subscribe");

    client
        .publish(subject, "hello".into())
        .await
        .expect("failed to publish");

    let message = timeout(RECV_TIMEOUT, subscriber.next())
        .await
        .expect("timed out waiting for message")
        .expect("subscription ended without a message");

    assert_eq!("hello", message.payload);
}
