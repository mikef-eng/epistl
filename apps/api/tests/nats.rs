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

#[tokio::test]
async fn ensure_offline_stream_configures_a_transient_work_queue() {
    use api::nats::{self, DEFAULT_OFFLINE_QUEUE_MAX_AGE_SECS, OFFLINE_QUEUE_MAX_AGE_SECS_VAR};
    use async_nats::jetstream::stream::{RetentionPolicy, StorageType};

    let client = api::nats::connect_with(&test_nats_url())
        .await
        .expect("failed to connect to NATS");
    let jetstream = async_nats::jetstream::new(client);

    // Derive the effective stream name for this worktree (or base name on the
    // primary checkout). Start from a clean slate so stale config from a
    // previous run doesn't interfere.
    let stream_name = api::nats::effective_stream_name();
    let _ = jetstream.delete_stream(&stream_name).await;

    let mut stream = nats::ensure_offline_stream(&jetstream)
        .await
        .expect("failed to create the offline-delivery stream");

    let info = stream.info().await.expect("failed to fetch stream info");

    assert_eq!(info.config.retention, RetentionPolicy::WorkQueue);
    assert_eq!(info.config.storage, StorageType::File);
    // Subjects must match the effective per-worktree filter (or the base
    // filter on the primary checkout).
    assert_eq!(info.config.subjects, api::nats::effective_stream_subjects());

    let expected_max_age_secs = std::env::var(OFFLINE_QUEUE_MAX_AGE_SECS_VAR)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_OFFLINE_QUEUE_MAX_AGE_SECS);
    assert_eq!(
        info.config.max_age,
        Duration::from_secs(expected_max_age_secs)
    );

    // Calling again against the now-existing stream must not error --
    // this is the idempotency the later publish/deliver issues rely on
    // (safe to call at every startup, not just the first).
    nats::ensure_offline_stream(&jetstream)
        .await
        .expect("second call to ensure_offline_stream should be idempotent");
}
