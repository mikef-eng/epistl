//! `GET /ws?token=<session token>` -- the live message relay.
//!
//! This is the one place in the app that ever sees a message body, and it
//! never touches Postgres or any other durable store with it: a `send`
//! frame is read off the sender's socket, checked against the `contacts`
//! table (existing rows only -- no writes), and if the recipient is
//! currently connected (per [`crate::registry::ConnectionRegistry`]) it is
//! written straight to their socket. If they aren't connected, the send
//! fails back to the sender; nothing is queued, logged, or persisted
//! anywhere.
//!
//! The session token is passed as a query parameter (not a header) because
//! Expo's cross-platform WebSocket client can't reliably set custom
//! headers -- see issue #4's notes.

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
        return send_error(
            tx,
            "recipient_offline",
            "recipient is not currently connected",
        );
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
        // this send (e.g. they disconnected concurrently) -- report the
        // same failure as if they had never been connected.
        return send_error(
            tx,
            "recipient_offline",
            "recipient is not currently connected",
        );
    }

    let ack = json!({ "type": "ack", "to": to });
    tx.send(Message::Text(ack.to_string().into()))
        .map_err(|_| ())
}

fn send_error(tx: &mpsc::UnboundedSender<Message>, code: &str, message: &str) -> Result<(), ()> {
    let frame = json!({ "type": "error", "code": code, "message": message });
    tx.send(Message::Text(frame.to_string().into()))
        .map_err(|_| ())
}
