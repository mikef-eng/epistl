//! `GET /ws?token=<session token>` -- the live message relay.
//!
//! This is the one place in the app that ever sees a message body, and it
//! never touches Postgres or any other durable store with it: a `send`
//! frame is read off the sender's socket, checked against the `contacts`
//! table (existing rows only -- no writes), and if the recipient is
//! currently connected (per [`crate::registry::ConnectionRegistry`]) it is
//! written straight to their socket. If they aren't connected, the message
//! is instead published to the JetStream offline-delivery queue (see
//! `crate::nats`) and the sender still gets a plain `ack` frame -- from the
//! sender's perspective, "delivered live" and "queued for offline
//! delivery" are indistinguishable successes. Only a failure to even queue
//! it (JetStream/NATS unreachable, stream missing, etc.) surfaces back to
//! the sender as an error.
//!
//! The session token is passed as a query parameter (not a header) because
//! Expo's cross-platform WebSocket client can't reliably set custom
//! headers -- see issue #4's notes.

use std::time::Duration;

use async_nats::jetstream::consumer::pull::Config as PullConsumerConfig;
use async_nats::jetstream::consumer::{AckPolicy, PullConsumer};
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::auth::{self, AppState};

/// Close code sent when the connecting token is missing or invalid.
const CLOSE_UNAUTHORIZED: u16 = 4001;
/// Close code sent to a connection that a same-user reconnect has replaced.
const CLOSE_REPLACED: u16 = 4002;

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

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/ws", get(ws_handler))
        .with_state(state)
}

#[derive(Debug, Deserialize, Default)]
struct WsAuthQuery {
    #[serde(default)]
    token: Option<String>,
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<WsAuthQuery>,
) -> Response {
    let token = query.token.unwrap_or_default();

    match auth::authenticate_token(&state, &token).await {
        Some(authed) => {
            let user_id = authed.user.id;
            ws.on_upgrade(move |socket| handle_socket(socket, user_id, state))
        }
        // The upgrade still has to happen before the client can observe a
        // close *code* -- an HTTP-level rejection wouldn't carry one. So we
        // always upgrade, then immediately close with 4001 on bad auth.
        None => {
            ws.on_upgrade(|socket| close_immediately(socket, CLOSE_UNAUTHORIZED, "unauthorized"))
        }
    }
}

async fn close_immediately(mut socket: WebSocket, code: u16, reason: &'static str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })))
        .await;
}

async fn handle_socket(socket: WebSocket, user_id: Uuid, state: AppState) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    if let Some(previous) = state.registry.insert(user_id, tx.clone()).await {
        let _ = previous.send(Message::Close(Some(CloseFrame {
            code: CLOSE_REPLACED,
            reason: "replaced by a new connection".into(),
        })));
    }

    // Every outbound frame for this connection -- relayed messages, acks,
    // and errors alike -- goes through `tx`/`rx` so there is exactly one
    // writer to the socket's sink at a time.
    let forward_task = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            let is_close = matches!(message, Message::Close(_));
            if sink.send(message).await.is_err() || is_close {
                break;
            }
        }
    });

    // Deliver anything queued for this user while they were offline
    // (issue #53) before processing any frames the client sends -- so a
    // reconnect always catches up before doing anything else.
    deliver_queued_messages(&state, user_id, &tx).await;

    while let Some(frame) = stream.next().await {
        let message = match frame {
            Ok(message) => message,
            Err(_) => break,
        };

        match message {
            Message::Text(text) => {
                if handle_client_frame(&state, user_id, &tx, &text)
                    .await
                    .is_err()
                {
                    break;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    state.registry.remove_if_current(&user_id, &tx).await;
    drop(tx);
    forward_task.abort();
}

/// Delivers any messages queued for `user_id` while they were offline
/// (see `queue_for_offline_delivery`, backed by issue #52's
/// `EPISTL_OFFLINE_MESSAGES` JetStream stream) over the just-registered
/// `tx`, in the order JetStream returns them -- the identical
/// `{"type": "message", ...}` frame shape a live relay send produces, so
/// nothing on the client needs to distinguish the two paths.
///
/// Each message is acknowledged (removing it from the queue) only after
/// the send over `tx` succeeds. If `tx` is gone (the socket vanished
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
async fn deliver_queued_messages(
    state: &AppState,
    user_id: Uuid,
    tx: &mpsc::UnboundedSender<Message>,
) {
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

        if tx.send(Message::Text(relay.to_string().into())).is_err() {
            // The socket is already gone -- stop here; this message and
            // any remaining ones stay un-acked (still queued) for the
            // next connection attempt.
            break;
        }

        let _ = message.ack().await;
    }
}

/// Returns `Err(())` only when the connection itself is done (the outbound
/// channel is gone); malformed/rejected frames send an error frame back to
/// the sender and return `Ok(())` so the connection stays open.
async fn handle_client_frame(
    state: &AppState,
    sender_id: Uuid,
    tx: &mpsc::UnboundedSender<Message>,
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
    tx: &mpsc::UnboundedSender<Message>,
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
    if recipient_tx
        .send(Message::Text(relay.to_string().into()))
        .is_err()
    {
        // The recipient's socket vanished between the registry lookup and
        // this send (e.g. they disconnected concurrently) -- fall through
        // to the same offline-queueing path as if they had never been
        // connected; from the sender's perspective this is just another
        // flavor of "not currently connected".
        return queue_for_offline_delivery(state, sender_id, to, &body_b64, tx).await;
    }

    let ack = json!({ "type": "ack", "to": to });
    tx.send(Message::Text(ack.to_string().into()))
        .map_err(|_| ())
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
async fn queue_for_offline_delivery(
    state: &AppState,
    sender_id: Uuid,
    to: Uuid,
    body_b64: &str,
    tx: &mpsc::UnboundedSender<Message>,
) -> Result<(), ()> {
    let jetstream = async_nats::jetstream::new(state.nats.clone());
    let payload = json!({
        "from": sender_id,
        "body_b64": body_b64,
        "sent_at": Utc::now().to_rfc3339(),
    });

    let published: Result<(), async_nats::Error> = async {
        let ack = jetstream
            .publish(crate::nats::offline_subject(to), payload.to_string().into())
            .await?;
        ack.await?;
        Ok(())
    }
    .await;

    match published {
        Ok(()) => {
            let ack = json!({ "type": "ack", "to": to });
            tx.send(Message::Text(ack.to_string().into()))
                .map_err(|_| ())
        }
        Err(_) => send_error(
            tx,
            "queue_unavailable",
            "message could not be queued for offline delivery",
        ),
    }
}

fn send_error(tx: &mpsc::UnboundedSender<Message>, code: &str, message: &str) -> Result<(), ()> {
    let frame = json!({ "type": "error", "code": code, "message": message });
    tx.send(Message::Text(frame.to_string().into()))
        .map_err(|_| ())
}
