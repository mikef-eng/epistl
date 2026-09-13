//! Integration tests for `GET /ws?token=<session token>` -- the live
//! message relay -- against a real Postgres instance, the real
//! `better-auth`-backed session validation, and a real TCP-bound Axum
//! server (a WebSocket upgrade can't be driven through
//! `tower::ServiceExt::oneshot`).
//!
//! Requires `DATABASE_URL` to point at a reachable Postgres (see
//! `docker-compose.yml` for local dev, or the `postgres:16` CI service).

use api::AppState;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use serial_test::serial;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use std::net::SocketAddr;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use tower::ServiceExt;
use uuid::Uuid;

/// A fixed test secret -- `better-auth` requires at least 32 bytes. Not a
/// real secret; only ever used against ephemeral/local test databases.
const TEST_SECRET: &str = "test-only-secret-do-not-use-in-prod-32+";

/// How long any single `.next()` read from a test socket is allowed to
/// take before the test fails, so a bug that hangs delivery fails fast
/// instead of hanging CI.
const RECV_TIMEOUT: Duration = Duration::from_secs(5);

async fn test_pool() -> PgPool {
    // Loads DATABASE_URL/AUTH_SECRET from a repo-root .env if present and
    // not already set (e.g. by CI). Safe to call redundantly per-test.
    dotenvy::dotenv().ok();
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set to run this integration test");
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await
        .expect("failed to connect to Postgres");

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("failed to run migrations");

    pool
}

async fn test_state() -> AppState {
    dotenvy::dotenv().ok();
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set to run this integration test");
    let auth = api::auth::build_auth(&database_url, TEST_SECRET)
        .await
        .expect("failed to build BetterAuth for test");
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await
        .expect("failed to connect to Postgres");
    let nats_url =
        std::env::var("NATS_URL").expect("NATS_URL must be set to run this integration test");
    let nats = async_nats::connect(&nats_url)
        .await
        .expect("failed to connect to NATS");
    AppState {
        auth,
        pool,
        registry: api::registry::ConnectionRegistry::new(),
        nats,
    }
}

fn unique_email(label: &str) -> String {
    format!("{label}-{}@example.com", Uuid::new_v4())
}

/// Signs up a fresh user (via the real `/signup` handler, in-process --
/// only the `/ws` upgrade itself needs a real TCP server) and returns
/// `(token, user_id, email)`.
async fn signup_user(pool: &PgPool, state: AppState, label: &str) -> (String, Uuid, String) {
    let email = unique_email(label);
    let response = api::app(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/signup")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({ "email": email, "password": "correct-horse-battery" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    let token = body["token"].as_str().unwrap().to_string();

    let user_id: Uuid = sqlx::query("SELECT user_id FROM sessions WHERE token = $1")
        .bind(&token)
        .fetch_one(pool)
        .await
        .expect("session row must exist")
        .get("user_id");

    (token, user_id, email)
}

/// Adds `contact_email` to `owner_token`'s contacts (via the real
/// `/api/contacts` handler, in-process).
async fn add_contact(state: AppState, owner_token: &str, contact_email: &str) {
    let response = api::app(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/contacts")
                .header("authorization", format!("Bearer {owner_token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({ "email": contact_email }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
}

/// Every base table in the `public` schema, sorted, so tests can assert
/// nothing anywhere was written during a relay.
async fn table_row_counts(pool: &PgPool) -> Vec<(String, i64)> {
    let tables: Vec<String> = sqlx::query(
        "SELECT table_name FROM information_schema.tables \
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE' \
         ORDER BY table_name",
    )
    .fetch_all(pool)
    .await
    .expect("failed to list tables")
    .into_iter()
    .map(|row| row.get::<String, _>("table_name"))
    .collect();

    let mut counts = Vec::with_capacity(tables.len());
    for table in tables {
        // Table names come straight from Postgres's own catalog (this
        // process's migrations, not user input), but assert the identifier
        // shape defensively before splicing it into SQL.
        assert!(
            table.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
            "unexpected table name from information_schema: {table}"
        );
        let count: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT COUNT(*) FROM \"{table}\""
        )))
        .fetch_one(pool)
        .await
        .expect("failed to count rows");
        counts.push((table, count));
    }
    counts
}

/// Binds the app to an ephemeral local port and serves it in the
/// background for the rest of the test process.
async fn spawn_server(state: AppState) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("failed to bind ephemeral port");
    let addr = listener.local_addr().expect("failed to read local addr");
    let app = api::app(state);
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("server error");
    });
    addr
}

async fn connect_ws(addr: SocketAddr, token: &str) -> WebSocketStream<MaybeTlsStream<TcpStream>> {
    let url = format!("ws://{addr}/ws?token={token}");
    let (ws, _response) = connect_async(url).await.expect("failed to open websocket");
    ws
}

async fn recv_json(ws: &mut WebSocketStream<MaybeTlsStream<TcpStream>>) -> Value {
    let message = timeout(RECV_TIMEOUT, ws.next())
        .await
        .expect("timed out waiting for a frame")
        .expect("socket closed before sending a frame")
        .expect("websocket protocol error");
    match message {
        WsMessage::Text(text) => serde_json::from_str(&text).expect("frame was not valid JSON"),
        other => panic!("expected a text frame, got {other:?}"),
    }
}

async fn recv_close(ws: &mut WebSocketStream<MaybeTlsStream<TcpStream>>) -> u16 {
    let message = timeout(RECV_TIMEOUT, ws.next())
        .await
        .expect("timed out waiting for a close frame")
        .expect("socket ended without a close frame")
        .expect("websocket protocol error");
    match message {
        WsMessage::Close(Some(frame)) => u16::from(frame.code),
        other => panic!("expected a close frame, got {other:?}"),
    }
}

#[tokio::test]
#[serial]
async fn invalid_token_closes_with_4001() {
    let state = test_state().await;
    let addr = spawn_server(state).await;

    let mut ws = connect_ws(addr, "not-a-real-token").await;

    assert_eq!(recv_close(&mut ws).await, 4001);
}

#[tokio::test]
#[serial]
async fn missing_token_closes_with_4001() {
    let state = test_state().await;
    let addr = spawn_server(state).await;

    let mut ws = connect_ws(addr, "").await;

    assert_eq!(recv_close(&mut ws).await, 4001);
}

#[tokio::test]
#[serial]
async fn second_connection_for_same_user_replaces_first_with_4002() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (token, _user_id, _email) = signup_user(&pool, state.clone(), "ws-replace").await;
    let addr = spawn_server(state).await;

    let mut first = connect_ws(addr, &token).await;
    let _second = connect_ws(addr, &token).await;

    assert_eq!(recv_close(&mut first).await, 4002);
}

#[tokio::test]
#[serial]
async fn send_relays_to_connected_contact_and_acks_sender() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (sender_token, sender_id, _sender_email) =
        signup_user(&pool, state.clone(), "ws-relay-sender").await;
    let (recipient_token, recipient_id, recipient_email) =
        signup_user(&pool, state.clone(), "ws-relay-recipient").await;
    add_contact(state.clone(), &sender_token, &recipient_email).await;

    let addr = spawn_server(state).await;
    let mut sender_ws = connect_ws(addr, &sender_token).await;
    let mut recipient_ws = connect_ws(addr, &recipient_token).await;

    let body_b64 = BASE64.encode(b"hello, this is opaque ciphertext (for now, plaintext)");
    sender_ws
        .send(WsMessage::text(
            json!({ "type": "send", "to": recipient_id, "body_b64": body_b64 }).to_string(),
        ))
        .await
        .expect("failed to send frame");

    let received = recv_json(&mut recipient_ws).await;
    assert_eq!(received["type"], "message");
    assert_eq!(received["from"], sender_id.to_string());
    assert_eq!(received["body_b64"], body_b64);
    assert!(received["sent_at"].is_string());

    let ack = recv_json(&mut sender_ws).await;
    assert_eq!(ack, json!({ "type": "ack", "to": recipient_id }));
}

/// Acceptance criterion: nothing about a successfully relayed message is
/// ever persisted server-side -- row counts across every table are
/// unchanged from before the send.
#[tokio::test]
#[serial]
async fn successful_send_does_not_change_any_table_row_counts() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (sender_token, _sender_id, _sender_email) =
        signup_user(&pool, state.clone(), "ws-no-persist-sender").await;
    let (recipient_token, recipient_id, recipient_email) =
        signup_user(&pool, state.clone(), "ws-no-persist-recipient").await;
    add_contact(state.clone(), &sender_token, &recipient_email).await;

    let addr = spawn_server(state).await;
    let mut sender_ws = connect_ws(addr, &sender_token).await;
    let mut recipient_ws = connect_ws(addr, &recipient_token).await;

    let before = table_row_counts(&pool).await;

    let body_b64 = BASE64.encode(b"nothing about this ever touches disk");
    sender_ws
        .send(WsMessage::text(
            json!({ "type": "send", "to": recipient_id, "body_b64": body_b64 }).to_string(),
        ))
        .await
        .expect("failed to send frame");

    // Wait for both the relay and the ack so the send has fully completed
    // server-side before snapshotting row counts again.
    let _ = recv_json(&mut recipient_ws).await;
    let _ = recv_json(&mut sender_ws).await;

    let after = table_row_counts(&pool).await;
    assert_eq!(before, after, "a send must never write to Postgres");
}

/// Acceptance criterion: a message to a real contact who isn't currently
/// connected is queued via JetStream rather than failing -- the sender gets
/// the same `ack` frame as a live delivery, and the message is verifiably
/// present in the `EPISTL_OFFLINE_MESSAGES` stream afterward.
#[tokio::test]
#[serial]
async fn send_to_offline_contact_queues_via_jetstream_and_acks_sender() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (sender_token, sender_id, _sender_email) =
        signup_user(&pool, state.clone(), "ws-offline-sender").await;
    let (_recipient_token, recipient_id, recipient_email) =
        signup_user(&pool, state.clone(), "ws-offline-recipient").await;
    add_contact(state.clone(), &sender_token, &recipient_email).await;

    let jetstream = async_nats::jetstream::new(state.nats.clone());
    let stream = api::nats::ensure_offline_stream(&jetstream)
        .await
        .expect("failed to ensure the offline-delivery stream exists");

    let addr = spawn_server(state).await;
    let mut sender_ws = connect_ws(addr, &sender_token).await;
    // Note: the recipient never connects.

    let body_b64 = BASE64.encode(b"queued while the recipient is offline");
    sender_ws
        .send(WsMessage::text(
            json!({ "type": "send", "to": recipient_id, "body_b64": body_b64 }).to_string(),
        ))
        .await
        .expect("failed to send frame");

    let ack = recv_json(&mut sender_ws).await;
    assert_eq!(ack, json!({ "type": "ack", "to": recipient_id }));

    let subject = api::nats::offline_subject(recipient_id);
    let raw = stream
        .get_last_raw_message_by_subject(&subject)
        .await
        .expect("queued message should be present in the offline-delivery stream");
    let payload: Value =
        serde_json::from_slice(&raw.payload).expect("queued payload should be JSON");
    assert_eq!(payload["from"], sender_id.to_string());
    assert_eq!(payload["body_b64"], body_b64);
    assert!(payload["sent_at"].is_string());
}

/// Acceptance criterion: a publish rejection from JetStream itself (here,
/// simulated by the offline-delivery stream not existing, which
/// `async-nats`'s publish-ack future surfaces as a "no responders" publish
/// error -- see its own doc comment) is reported to the sender as
/// `queue_unavailable`, distinct from the retired `recipient_offline`.
#[tokio::test]
#[serial]
async fn send_to_offline_contact_returns_queue_unavailable_when_jetstream_publish_fails() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (sender_token, _sender_id, _sender_email) =
        signup_user(&pool, state.clone(), "ws-queue-fail-sender").await;
    let (_recipient_token, recipient_id, recipient_email) =
        signup_user(&pool, state.clone(), "ws-queue-fail-recipient").await;
    add_contact(state.clone(), &sender_token, &recipient_email).await;

    let jetstream = async_nats::jetstream::new(state.nats.clone());
    // Deliberately remove the stream so JetStream has no responder for
    // `epistl.offline.*` -- the same "stream missing" condition the
    // acceptance criteria call out. Restored below so other tests (in this
    // file or run afterward) still find it present; mirrors the
    // delete-then-recreate pattern already used by
    // `apps/api/tests/nats.rs`'s `ensure_offline_stream` test.
    let _ = jetstream
        .delete_stream(api::nats::OFFLINE_STREAM_NAME)
        .await;

    let addr = spawn_server(state.clone()).await;
    let mut sender_ws = connect_ws(addr, &sender_token).await;

    sender_ws
        .send(WsMessage::text(
            json!({ "type": "send", "to": recipient_id, "body_b64": BASE64.encode(b"hi") })
                .to_string(),
        ))
        .await
        .expect("failed to send frame");

    let error = recv_json(&mut sender_ws).await;
    assert_eq!(error["type"], "error");
    assert_eq!(error["code"], "queue_unavailable");
    assert!(error["message"].is_string());

    api::nats::ensure_offline_stream(&jetstream)
        .await
        .expect("failed to restore the offline-delivery stream after the test");
}

#[tokio::test]
#[serial]
async fn send_to_non_contact_returns_not_a_contact_without_delivering() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (sender_token, _sender_id, _sender_email) =
        signup_user(&pool, state.clone(), "ws-not-contact-sender").await;
    let (recipient_token, recipient_id, recipient_email) =
        signup_user(&pool, state.clone(), "ws-not-contact-recipient").await;
    // Deliberately not added as a contact yet.

    let addr = spawn_server(state.clone()).await;
    let mut sender_ws = connect_ws(addr, &sender_token).await;
    let mut recipient_ws = connect_ws(addr, &recipient_token).await;

    sender_ws
        .send(WsMessage::text(
            json!({ "type": "send", "to": recipient_id, "body_b64": BASE64.encode(b"hi") })
                .to_string(),
        ))
        .await
        .expect("failed to send frame");

    let error = recv_json(&mut sender_ws).await;
    assert_eq!(error["type"], "error");
    assert_eq!(error["code"], "not_a_contact");
    assert!(error["message"].is_string());

    // Prove the rejected send was never delivered (not even late/queued):
    // add the contact relationship now, send a second message, and assert
    // the recipient sees exactly that one message -- not two.
    add_contact(state, &sender_token, &recipient_email).await;
    sender_ws
        .send(WsMessage::text(
            json!({ "type": "send", "to": recipient_id, "body_b64": BASE64.encode(b"now a contact") })
                .to_string(),
        ))
        .await
        .expect("failed to send frame");
    let relayed = recv_json(&mut recipient_ws).await;
    assert_eq!(relayed["body_b64"], BASE64.encode(b"now a contact"));
}

#[tokio::test]
#[serial]
async fn malformed_frame_returns_invalid_payload_and_keeps_connection_open() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (sender_token, _sender_id, _sender_email) =
        signup_user(&pool, state.clone(), "ws-malformed-sender").await;
    let (recipient_token, recipient_id, recipient_email) =
        signup_user(&pool, state.clone(), "ws-malformed-recipient").await;
    add_contact(state.clone(), &sender_token, &recipient_email).await;

    let addr = spawn_server(state).await;
    let mut sender_ws = connect_ws(addr, &sender_token).await;
    let mut recipient_ws = connect_ws(addr, &recipient_token).await;

    sender_ws
        .send(WsMessage::text("this is not json"))
        .await
        .expect("failed to send frame");
    let error = recv_json(&mut sender_ws).await;
    assert_eq!(error["type"], "error");
    assert_eq!(error["code"], "invalid_payload");

    sender_ws
        .send(WsMessage::text(
            json!({ "type": "send", "to": "not-a-uuid", "body_b64": "aGk=" }).to_string(),
        ))
        .await
        .expect("failed to send frame");
    let error = recv_json(&mut sender_ws).await;
    assert_eq!(error["code"], "invalid_payload");

    sender_ws
        .send(WsMessage::text(
            json!({ "type": "send", "to": recipient_id, "body_b64": "not-valid-base64!!" })
                .to_string(),
        ))
        .await
        .expect("failed to send frame");
    let error = recv_json(&mut sender_ws).await;
    assert_eq!(error["code"], "invalid_payload");

    // The connection is still open and functional after three malformed
    // frames: a valid send now succeeds normally.
    sender_ws
        .send(WsMessage::text(
            json!({ "type": "send", "to": recipient_id, "body_b64": BASE64.encode(b"still works") })
                .to_string(),
        ))
        .await
        .expect("failed to send frame");
    let relayed = recv_json(&mut recipient_ws).await;
    assert_eq!(relayed["type"], "message");
    let ack = recv_json(&mut sender_ws).await;
    assert_eq!(ack["type"], "ack");
}
