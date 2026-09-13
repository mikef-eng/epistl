//! `GET /ws?token=<session token>` -- the live message relay's WebSocket
//! transport.
//!
//! This module owns only WS-specific glue: the Axum WebSocket upgrade
//! handler, and translating between `axum::extract::ws::Message` and the
//! transport-agnostic [`crate::registry::Frame`] the shared relay logic in
//! [`crate::relay`] actually operates on -- on both the inbound side
//! (reading client frames off the socket, handed to `relay` as raw text)
//! and the outbound side (turning a `Frame` pulled off this connection's
//! channel back into a real `Message` to write to the socket). The
//! `CLOSE_UNAUTHORIZED`/`CLOSE_REPLACED` close-code handling is WS-specific
//! too and stays here.
//!
//! `crate::relay` is the one place in the app that ever sees a message
//! body, and it never touches Postgres or any other durable store with it
//! -- see that module's doc comment for the full relay/offline-queue
//! behavior, which is unchanged by this module's transport glue.
//!
//! The session token is passed as a query parameter (not a header) because
//! Expo's cross-platform WebSocket client can't reliably set custom
//! headers -- see issue #4's notes.

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::auth::{self, AppState};
use crate::registry::Frame;

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

/// Translates a transport-agnostic [`Frame`] (produced by `crate::relay`)
/// into this transport's own `axum::extract::ws::Message` wire
/// representation.
fn frame_to_message(frame: Frame) -> Message {
    match frame {
        Frame::Text(text) => Message::Text(text.into()),
        Frame::Close { code, reason } => Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })),
    }
}

async fn handle_socket(socket: WebSocket, user_id: Uuid, state: AppState) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Frame>();

    if let Some(previous) = state.registry.insert(user_id, tx.clone()).await {
        let _ = previous.send(Frame::Close {
            code: CLOSE_REPLACED,
            reason: "replaced by a new connection".into(),
        });
    }

    // Every outbound frame for this connection -- relayed messages, acks,
    // and errors alike -- goes through `tx`/`rx` so there is exactly one
    // writer to the socket's sink at a time.
    let forward_task = tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            let message = frame_to_message(frame);
            let is_close = matches!(message, Message::Close(_));
            if sink.send(message).await.is_err() || is_close {
                break;
            }
        }
    });

    // Deliver anything queued for this user while they were offline
    // (issue #53) before processing any frames the client sends -- so a
    // reconnect always catches up before doing anything else.
    crate::relay::deliver_queued_messages(&state, user_id, &tx).await;

    while let Some(frame) = stream.next().await {
        let message = match frame {
            Ok(message) => message,
            Err(_) => break,
        };

        match message {
            Message::Text(text) => {
                if crate::relay::handle_client_frame(&state, user_id, &tx, &text)
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
