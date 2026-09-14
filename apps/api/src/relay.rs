//! Transport-agnostic message-relay logic shared by every live transport
//! the API speaks -- today `GET /ws` ([`crate::ws`]), and in the future a
//! QUIC listener (issue #73) -- so that a message relayed to a recipient
//! connected over one transport reaches them the same way regardless of
//! which transport the sender used, and vice versa.
//!
//! This module never touches `axum::extract::ws` (or any other
//! transport-specific crate) directly: it operates purely on
//! [`crate::registry::Frame`] and [`crate::registry::ConnectionRegistry`].
//! Each transport's own glue module owns translating between its wire
//! representation and `Frame` on both the inbound and outbound sides -- see
//! `ws::handle_socket` for the WebSocket case.
//!
//! This is the one place in the app that ever sees a message body, and it
//! never touches Postgres or any other durable store with it: a `send`
//! frame is checked against the `contacts` table (existing rows only -- no
//! writes), and if the recipient is currently connected (per
//! [`crate::registry::ConnectionRegistry`]) it is relayed straight to them.
//! If they aren't connected, the message is instead published to the
//! JetStream offline-delivery queue (see `crate::nats`) and the sender
//! still gets a plain `ack` frame -- from the sender's perspective,
//! "delivered live" and "queued for offline delivery" are indistinguishable
//! successes. Only a failure to even queue it (JetStream/NATS unreachable,
//! stream missing, etc.) surfaces back to the sender as an error.

use std::time::Duration;

use async_nats::jetstream::consumer::pull::Config as PullConsumerConfig;
use async_nats::jetstream::consumer::{AckPolicy, PullConsumer};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::Utc;
use futures_util::StreamExt;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::AppState;
use crate::registry::{Frame, Sender};

/// Upper bound on how many currently-queued messages are fetched on a
/// single connect -- far above any realistic queue depth for one user
/// within the offline-delivery TTL (issue #52's `max_age`). A user with
/// more than this queued still gets the rest: JetStream's `WorkQueuePolicy`
/// retention (issue #52) leaves anything un-acked visible to the very next
/// consumer created against the same stream/subject, i.e. their next
/// reconnect.
const MAX_QUEUED_MESSAGES_PER_FETCH: usize = 256;

/// How long the initial fetch of queued messages waits for the *first*
/// message before giving up. A pull consumer's `fetch()` (unlike `batch()`)
/// returns as soon as the stream runs dry rather than waiting the full
/// duration once *something* has arrived, so this bound only matters for a
/// user with nothing queued -- keeping it short means connecting stays
/// perceptually instant in that (common) case.
const QUEUED_MESSAGES_FETCH_TIMEOUT: Duration = Duration::from_millis(300);

/// Delivers any messages queued for `user_id` while they were offline
/// (see `queue_for_offline_delivery`, backed by issue #52's
/// `EPISTL_OFFLINE_MESSAGES` JetStream stream) over the just-registered
/// `tx`, in the order JetStream returns them -- the identical
/// `{"type": "message", ...}` frame shape a live relay send produces, so
/// nothing on the client needs to distinguish the two paths.
///
/// Each message is acknowledged (removing it from the queue) only after
/// the send over `tx` succeeds. If `tx` is gone (the connection vanished
/// before delivery finished), the remaining messages are left un-acked so
/// they stay queued for the next connection attempt, bounded by issue
/// #52's `max_age`.
///
/// Creates a fresh ephemeral (non-durable) pull consumer on every call
/// scoped to this user's own subject (`epistl.offline.<user_id>`): it
/// doesn't need to survive an API process restart, since `WorkQueuePolicy`
/// retention (issue #52) leaves un-acked messages visible to the next
/// consumer created against the same stream/subject regardless of which
/// consumer originally fetched them.
///
/// Failures anywhere in this path (the stream not configured yet, NATS
/// unreachable, the fetch itself erroring) are swallowed: there is
/// nothing meaningful to report back to the connecting client beyond
/// "some queued messages might not have arrived yet", and any messages
/// that were never fetched simply remain queued for the next attempt.
pub(crate) async fn deliver_queued_messages(state: &AppState, user_id: Uuid, tx: &Sender) {
    let jetstream = async_nats::jetstream::new(state.nats.clone());

    let consumer: PullConsumer = match jetstream
        .create_consumer_on_stream(
            PullConsumerConfig {
                ack_policy: AckPolicy::Explicit,
                filter_subject: crate::nats::offline_subject(user_id),
                ..Default::default()
            },
            crate::nats::OFFLINE_STREAM_NAME,
        )
        .await
    {
        Ok(consumer) => consumer,
        Err(_) => return,
    };

    let mut messages = match consumer
        .fetch()
        .max_messages(MAX_QUEUED_MESSAGES_PER_FETCH)
        .expires(QUEUED_MESSAGES_FETCH_TIMEOUT)
        .messages()
        .await
    {
        Ok(messages) => messages,
        Err(_) => return,
    };

    while let Some(Ok(message)) = messages.next().await {
        let Ok(payload) = serde_json::from_slice::<Value>(&message.payload) else {
            // Not a shape `queue_for_offline_delivery` could have
            // produced -- leave it un-acked rather than guess at a frame
            // to forward from it.
            continue;
        };

        let relay = json!({
            "type": "message",
            "from": payload.get("from"),
            "body_b64": payload.get("body_b64"),
            "sent_at": payload.get("sent_at"),
        });

        if tx.send(Frame::Text(relay.to_string())).is_err() {
            // The connection is already gone -- stop here; this message
            // and any remaining ones stay un-acked (still queued) for the
            // next connection attempt.
            break;
        }

        let _ = message.ack().await;
    }
}

/// Returns `Err(())` only when the connection itself is done (the outbound
/// channel is gone); malformed/rejected frames send an error frame back to
/// the sender and return `Ok(())` so the connection stays open.
pub(crate) async fn handle_client_frame(
    state: &AppState,
    sender_id: Uuid,
    tx: &Sender,
    text: &str,
) -> Result<(), ()> {
    let parsed: Result<Value, _> = serde_json::from_str(text);
    let parsed = match parsed {
        Ok(value) => value,
        Err(_) => return send_error(tx, "invalid_payload", "malformed JSON frame"),
    };

    match parsed.get("type").and_then(Value::as_str) {
        Some("send") => handle_send(state, sender_id, tx, &parsed).await,
        _ => send_error(tx, "invalid_payload", "unknown or missing frame type"),
    }
}

async fn handle_send(
    state: &AppState,
    sender_id: Uuid,
    tx: &Sender,
    frame: &Value,
) -> Result<(), ()> {
    let to = match frame
        .get("to")
        .and_then(Value::as_str)
        .and_then(|s| Uuid::parse_str(s).ok())
    {
        Some(to) => to,
        None => return send_error(tx, "invalid_payload", "\"to\" must be a UUID string"),
    };

    let body_b64 = match frame.get("body_b64").and_then(Value::as_str) {
        Some(body) if BASE64.decode(body).is_ok() => body.to_string(),
        _ => return send_error(tx, "invalid_payload", "\"body_b64\" must be valid base64"),
    };

    let is_contact = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM contacts WHERE owner_user_id = $1 AND contact_user_id = $2)",
    )
    .bind(sender_id)
    .bind(to)
    .fetch_one(&state.pool)
    .await
    .unwrap_or(false);

    if !is_contact {
        return send_error(tx, "not_a_contact", "recipient is not in your contacts");
    }

    let Some(recipient_tx) = state.registry.get(&to).await else {
        return queue_for_offline_delivery(state, sender_id, to, &body_b64, tx).await;
    };

    let relay = json!({
        "type": "message",
        "from": sender_id,
        "body_b64": body_b64,
        "sent_at": Utc::now().to_rfc3339(),
    });
    if recipient_tx.send(Frame::Text(relay.to_string())).is_err() {
        // The recipient's connection vanished between the registry lookup
        // and this send (e.g. they disconnected concurrently) -- fall
        // through to the same offline-queueing path as if they had never
        // been connected; from the sender's perspective this is just
        // another flavor of "not currently connected".
        return queue_for_offline_delivery(state, sender_id, to, &body_b64, tx).await;
    }

    let ack = json!({ "type": "ack", "to": to });
    tx.send(Frame::Text(ack.to_string())).map_err(|_| ())
}

/// Publishes a message to the JetStream offline-delivery queue (subject
/// `epistl.offline.<to>`, see [`crate::nats::offline_subject`]) for a
/// recipient who isn't currently connected, then reports the outcome back
/// to the sender.
///
/// Awaits the publish's ack -- `async-nats`'s publish-then-ack pattern --
/// so a rejection from JetStream itself (stream missing, NATS unreachable,
/// etc.) is caught here rather than silently dropped. On success, the
/// sender gets the same `{"type": "ack", "to": to}` frame as a live
/// delivery: there is no wire-visible distinction between "delivered live"
/// and "queued for offline delivery". On failure, the sender gets a
/// `queue_unavailable` error frame and the message is not delivered by any
/// path.
///
/// After a successful publish, spawns a best-effort background attempt
/// (see [`redeliver_if_now_connected`]) to close the narrow race where the
/// recipient finishes connecting concurrently with this publish -- too
/// late for their own connect-time catch-up fetch (issue #54) to have
/// caught this specific message, but soon enough that making them wait
/// for their *next* reconnect would be needlessly slow (issue #63). This
/// is spawned rather than awaited so it never adds latency to the sender's
/// own `ack` frame below.
async fn queue_for_offline_delivery(
    state: &AppState,
    sender_id: Uuid,
    to: Uuid,
    body_b64: &str,
    tx: &Sender,
) -> Result<(), ()> {
    let jetstream = async_nats::jetstream::new(state.nats.clone());
    let sent_at = Utc::now().to_rfc3339();
    let payload = json!({
        "from": sender_id,
        "body_b64": body_b64,
        "sent_at": sent_at,
    });

    let published: Result<u64, async_nats::Error> = async {
        let ack = jetstream
            .publish(crate::nats::offline_subject(to), payload.to_string().into())
            .await?;
        Ok(ack.await?.sequence)
    }
    .await;

    match published {
        Ok(sequence) => {
            let relay = json!({
                "type": "message",
                "from": sender_id,
                "body_b64": body_b64,
                "sent_at": sent_at,
            });
            let redelivery_state = state.clone();
            tokio::spawn(async move {
                redeliver_if_now_connected(&redelivery_state, to, sequence, relay).await;
            });

            let ack = json!({ "type": "ack", "to": to });
            tx.send(Frame::Text(ack.to_string())).map_err(|_| ())
        }
        Err(_) => send_error(
            tx,
            "queue_unavailable",
            "message could not be queued for offline delivery",
        ),
    }
}

/// Best-effort close of the narrow race between [`queue_for_offline_delivery`]
/// publishing a message and the recipient finishing a concurrent reconnect
/// too early for their own connect-time catch-up fetch
/// (`deliver_queued_messages`, issue #54) to have caught it -- see issue
/// #63. Only ever invoked as a spawned background task, after the publish
/// it concerns has already been acked by JetStream, so `sequence` reliably
/// identifies a message currently sitting in [`crate::nats::OFFLINE_STREAM_NAME`].
///
/// Re-checks the registry for `to`; if they're connected, forwards `relay`
/// (the identical frame `deliver_queued_messages` and a live relay would
/// produce for this message) directly over their `tx`, then -- only on a
/// successful send -- removes the message from the queue with
/// [`async_nats::jetstream::stream::Stream::delete_message`], a direct
/// administrative delete by sequence number.
///
/// Deliberately does not create or touch any consumer. An earlier attempt
/// at this fix re-invoked `deliver_queued_messages` itself (i.e. created a
/// second ephemeral pull consumer on the same `epistl.offline.<to>`
/// subject) and found that collided with the recipient's own
/// still-registered connect-time consumer -- `deliver_queued_messages`
/// doesn't explicitly delete its ephemeral consumer, and JetStream keeps
/// one registered for several seconds past its `fetch()` returning -- in
/// essentially every real occurrence of this race, not just a rare
/// sub-window. Deleting by sequence number instead sidesteps that
/// entirely: it works the same whether or not the recipient's own
/// connect-time consumer is still lingering.
///
/// Swallows every failure (recipient not connected after all, their `tx`
/// gone, the delete erroring): this is strictly a best-effort improvement
/// layered on top of the self-resolving behavior that already exists
/// without it -- a message left undeleted here simply stays queued for the
/// recipient's next reconnect, bounded by issue #52's `max_age` TTL.
async fn redeliver_if_now_connected(state: &AppState, to: Uuid, sequence: u64, relay: Value) {
    let Some(recipient_tx) = state.registry.get(&to).await else {
        return;
    };

    if recipient_tx.send(Frame::Text(relay.to_string())).is_err() {
        return;
    }

    let jetstream = async_nats::jetstream::new(state.nats.clone());
    let Ok(stream) = jetstream.get_stream(crate::nats::OFFLINE_STREAM_NAME).await else {
        return;
    };
    let _ = stream.delete_message(sequence).await;
}

fn send_error(tx: &Sender, code: &str, message: &str) -> Result<(), ()> {
    let frame = json!({ "type": "error", "code": code, "message": message });
    tx.send(Frame::Text(frame.to_string())).map_err(|_| ())
}

/// Deterministic (no wall-clock reliance) unit tests for
/// [`redeliver_if_now_connected`], issue #63's fix for the narrow race
/// between [`queue_for_offline_delivery`]'s publish and a recipient
/// finishing a concurrent reconnect too early for their own connect-time
/// catch-up fetch (`deliver_queued_messages`, issue #54) to have caught
/// this specific message.
///
/// These call the module's private functions directly (white-box) rather
/// than going through a real `/ws` connection (as `apps/api/tests/ws.rs`
/// does): the whole point is to control the exact interleaving between
/// the recipient's connect-time consumer and the fix's direct
/// forward-and-delete, which real concurrent WebSocket traffic can't
/// deterministically reproduce. See `apps/api/tests/ws.rs` for the
/// unmodified-wire-behavior coverage (ack framing, no-double-delivery,
/// etc.) that already exercises `queue_for_offline_delivery` end to end.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth;
    use async_nats::jetstream::stream::Stream;
    use serial_test::serial;
    use sqlx::postgres::PgPoolOptions;
    use tokio::sync::mpsc;
    use tokio::time::timeout;

    /// A fixed test secret -- `better-auth` requires at least 32 bytes. Not
    /// a real secret; only ever used against ephemeral/local test
    /// databases. Mirrors `apps/api/tests/ws.rs`'s `TEST_SECRET`.
    const TEST_SECRET: &str = "test-only-secret-do-not-use-in-prod-32+";

    /// How long a single channel `.recv()` is allowed to take before a test
    /// fails -- generous CI slack, not part of the race being driven
    /// (that's controlled entirely by call ordering below, not timing).
    const RECV_TIMEOUT: Duration = Duration::from_secs(5);

    /// How long `assert_no_further_message` waits before concluding nothing
    /// else is coming.
    const NO_MESSAGE_WINDOW: Duration = Duration::from_millis(750);

    async fn test_state() -> AppState {
        dotenvy::dotenv().ok();
        let database_url =
            std::env::var("DATABASE_URL").expect("DATABASE_URL must be set to run this test");
        let auth = auth::build_auth(&database_url, TEST_SECRET)
            .await
            .expect("failed to build BetterAuth for test");
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(&database_url)
            .await
            .expect("failed to connect to Postgres");
        let nats_url = std::env::var("NATS_URL").expect("NATS_URL must be set to run this test");
        let nats = async_nats::connect(&nats_url)
            .await
            .expect("failed to connect to NATS");
        AppState {
            auth,
            pool,
            registry: crate::registry::ConnectionRegistry::new(),
            nats,
        }
    }

    async fn recv_frame(rx: &mut mpsc::UnboundedReceiver<Frame>) -> Value {
        let frame = timeout(RECV_TIMEOUT, rx.recv())
            .await
            .expect("timed out waiting for a frame")
            .expect("channel closed before sending a frame");
        match frame {
            Frame::Text(text) => serde_json::from_str(&text).expect("frame was not valid JSON"),
            other => panic!("expected a text frame, got {other:?}"),
        }
    }

    async fn assert_no_further_message(rx: &mut mpsc::UnboundedReceiver<Frame>) {
        let result = timeout(NO_MESSAGE_WINDOW, rx.recv()).await;
        assert!(
            result.is_err(),
            "expected no further frame, but got one: {result:?}"
        );
    }

    /// Returns the exact set of consumer names currently registered on
    /// `stream`, via JetStream's `CONSUMER.NAMES` API (`Stream::consumer_names`)
    /// -- a direct listing, not the aggregate `state.consumer_count` counter
    /// `stream.info()` returns.
    ///
    /// Issue #118's investigation found `state.consumer_count` compared
    /// across two points in time (the shape the test originally used) flakes
    /// even in complete process isolation (`cargo test --lib`, no other test
    /// binary running -- ruling out cross-binary interference): a bounded
    /// poll-until-two-reads-agree retry on that counter (an earlier attempt
    /// at this fix) *also* still flaked at essentially the same rate, which
    /// means the counter itself doesn't settle to a value that stays
    /// comparable across a short wall-clock gap -- other ephemeral consumers
    /// created by earlier tests in the same run linger for "several
    /// seconds" (see `redeliver_if_now_connected`'s doc comment) and can be
    /// independently expired by the server, on the server's own timer, at
    /// any point, nudging the aggregate counter up or down for reasons
    /// unrelated to anything this test does. Comparing two snapshots of that
    /// counter is thus inherently racy regardless of how long either
    /// snapshot is retried/polled for.
    ///
    /// Comparing the actual *set of names* sidesteps that: this test's own
    /// invariant is "the delete didn't create a new consumer", which a
    /// before/after subset check on names verifies directly and correctly
    /// even if unrelated pre-existing consumers independently vanish (their
    /// names simply drop out of both sets, which is fine) -- it only fails
    /// if a name appears in the "after" set that wasn't in the "before" set.
    async fn consumer_name_set(stream: &Stream) -> std::collections::HashSet<String> {
        use futures_util::TryStreamExt;
        stream
            .consumer_names()
            .try_collect()
            .await
            .expect("failed to list consumer names")
    }

    /// Publishes directly to `to`'s offline subject (mirroring what
    /// `queue_for_offline_delivery` itself publishes) and returns the
    /// resulting `PublishAck.sequence`, so the test can drive
    /// `redeliver_if_now_connected` with full control over ordering
    /// instead of going through the spawn inside `queue_for_offline_delivery`.
    async fn publish_offline_message(
        state: &AppState,
        sender_id: Uuid,
        to: Uuid,
        body_b64: &str,
        sent_at: &str,
    ) -> u64 {
        let jetstream = async_nats::jetstream::new(state.nats.clone());
        let payload = json!({
            "from": sender_id,
            "body_b64": body_b64,
            "sent_at": sent_at,
        });
        let ack = jetstream
            .publish(crate::nats::offline_subject(to), payload.to_string().into())
            .await
            .expect("failed to publish offline message");
        ack.await.expect("publish was not acked").sequence
    }

    /// Drives the exact race from issue #63 deterministically, by ordering
    /// (not timing):
    ///
    /// 1. The recipient "connects" (registry insert) and runs their own
    ///    connect-time catch-up fetch (`deliver_queued_messages`, issue
    ///    #54) -- *before* the sender's message has been published at all,
    ///    so it (correctly, per #54's own scope) finds nothing. This is
    ///    exactly what leaves an ephemeral consumer registered on
    ///    `epistl.offline.<to>` that lingers for several seconds
    ///    afterward -- the condition that broke the original
    ///    re-invoke-`deliver_queued_messages` design (see this function's
    ///    module-level doc comment and the issue's empirical-finding
    ///    comment).
    /// 2. The sender's message is published (mirroring
    ///    `queue_for_offline_delivery`'s publish, which -- per the issue --
    ///    is understood to race a concurrent connect like step 1's).
    /// 3. `redeliver_if_now_connected` is invoked directly and awaited
    ///    (the exact call `queue_for_offline_delivery` spawns after its
    ///    publish is acked), immediately after step 2 and thus still well
    ///    within the lingering-consumer window from step 1 -- proving the
    ///    fix's `delete_message` call succeeds without needing or creating
    ///    any consumer of its own, sidestepping the collision that broke
    ///    the original design.
    ///
    /// Asserts the recipient receives the message as an ordinary
    /// `{"type": "message", ...}` frame (no reconnect needed), that
    /// nothing else arrives after it, and that a subsequent reconnect's
    /// own catch-up fetch sees nothing further for it -- exactly-once
    /// delivery via the direct-delete path, not a duplicate left sitting
    /// in the queue.
    #[tokio::test]
    #[serial]
    async fn redeliver_forwards_directly_and_deletes_by_sequence_while_recipients_own_consumer_lingers(
    ) {
        let state = test_state().await;
        let jetstream = async_nats::jetstream::new(state.nats.clone());
        crate::nats::ensure_offline_stream(&jetstream)
            .await
            .expect("failed to ensure the offline-delivery stream exists");

        let sender_id = Uuid::new_v4();
        let to = Uuid::new_v4();
        let body_b64 = BASE64.encode(b"raced past the recipient's own catch-up fetch");
        let sent_at = Utc::now().to_rfc3339();

        // Step 1: the recipient connects and runs their own connect-time
        // catch-up fetch before anything has been published for them --
        // nothing to deliver, but it leaves a lingering ephemeral consumer
        // registered on their subject.
        let (recipient_tx, mut recipient_rx) = mpsc::unbounded_channel::<Frame>();
        state.registry.insert(to, recipient_tx.clone()).await;
        deliver_queued_messages(&state, to, &recipient_tx).await;
        assert_no_further_message(&mut recipient_rx).await;

        let stream = jetstream
            .get_stream(crate::nats::OFFLINE_STREAM_NAME)
            .await
            .expect("failed to fetch the offline-delivery stream");
        let consumer_names_before_delete = consumer_name_set(&stream).await;
        assert!(
            !consumer_names_before_delete.is_empty(),
            "expected the recipient's own connect-time consumer to still be \
             registered immediately after their fetch, proving this test \
             actually drives the lingering-consumer condition -- got no \
             registered consumers"
        );

        // Step 2: the sender's message is published, as if
        // `queue_for_offline_delivery` had raced the connect above.
        let sequence = publish_offline_message(&state, sender_id, to, &body_b64, &sent_at).await;

        // Step 3: the fix's direct forward-and-delete, run immediately --
        // still within the lingering-consumer window from step 1 -- and
        // awaited directly instead of through `queue_for_offline_delivery`'s
        // spawn, for a fully deterministic assertion order.
        let relay = json!({
            "type": "message",
            "from": sender_id,
            "body_b64": body_b64,
            "sent_at": sent_at,
        });
        redeliver_if_now_connected(&state, to, sequence, relay.clone()).await;

        // The recipient received the message directly, without a further
        // reconnect, and nothing else follows it.
        let received = recv_frame(&mut recipient_rx).await;
        assert_eq!(received, relay);
        assert_no_further_message(&mut recipient_rx).await;

        // The delete succeeded without creating (or needing) any consumer
        // of its own: every consumer name present after the delete was
        // already present before it, even though the recipient's own
        // consumer from step 1 was still registered at that point. (Not a
        // strict equality check: an unrelated pre-existing consumer, from
        // an earlier test in this same run, could legitimately expire on
        // the server's own timer in between -- that's fine and expected,
        // and is exactly the false-flake source issue #118 found in the
        // aggregate-count comparison this replaced.)
        let consumer_names_after_delete = consumer_name_set(&stream).await;
        assert!(
            consumer_names_after_delete.is_subset(&consumer_names_before_delete),
            "delete_message must not create (or require) a consumer -- new \
             consumer name(s) appeared: {:?}",
            consumer_names_after_delete
                .difference(&consumer_names_before_delete)
                .collect::<Vec<_>>()
        );

        // A subsequent reconnect's own catch-up fetch sees nothing further
        // for this message: it was genuinely removed from the queue by the
        // direct delete, not merely delivered while also left behind.
        let (reconnect_tx, mut reconnect_rx) = mpsc::unbounded_channel::<Frame>();
        deliver_queued_messages(&state, to, &reconnect_tx).await;
        assert_no_further_message(&mut reconnect_rx).await;
    }

    /// If the registry re-check finds the recipient is *not* connected
    /// (the ordinary, non-racing case), the message must be left alone in
    /// the queue -- untouched -- so it remains available for their next
    /// connect-time catch-up fetch, per this function's own doc comment
    /// and the issue's acceptance criteria.
    #[tokio::test]
    #[serial]
    async fn redeliver_leaves_the_message_queued_when_recipient_is_not_connected() {
        let state = test_state().await;
        let jetstream = async_nats::jetstream::new(state.nats.clone());
        crate::nats::ensure_offline_stream(&jetstream)
            .await
            .expect("failed to ensure the offline-delivery stream exists");

        let sender_id = Uuid::new_v4();
        let to = Uuid::new_v4();
        let body_b64 = BASE64.encode(b"never raced anything");
        let sent_at = Utc::now().to_rfc3339();

        let sequence = publish_offline_message(&state, sender_id, to, &body_b64, &sent_at).await;
        let relay = json!({
            "type": "message",
            "from": sender_id,
            "body_b64": body_b64,
            "sent_at": sent_at,
        });

        // `to` was never inserted into the registry -- not connected.
        redeliver_if_now_connected(&state, to, sequence, relay.clone()).await;

        // The message is still there for the recipient's eventual connect.
        let (rx_tx, mut rx_rx) = mpsc::unbounded_channel::<Frame>();
        deliver_queued_messages(&state, to, &rx_tx).await;
        let received = recv_frame(&mut rx_rx).await;
        assert_eq!(received, relay);
    }
}
