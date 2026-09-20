//! Integration tests for `GET /api/messages/queued/{from_user_id}` (issue
//! #249): read-only fetch of the oldest queued envelope from one sender.
//! Messages are queued through the real offline path (`/ws` send to a
//! recipient who is not connected).
//!
//! Requires `DATABASE_URL` and `NATS_URL`.

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
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use tower::ServiceExt;
use uuid::Uuid;

const TEST_SECRET: &str = "test-only-secret-do-not-use-in-prod-32+";
const RECV_TIMEOUT: Duration = Duration::from_secs(5);

async fn test_pool() -> PgPool {
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
    let jetstream = async_nats::jetstream::new(nats.clone());
    api::nats::ensure_offline_stream(&jetstream)
        .await
        .expect("failed to ensure the offline-delivery stream exists");
    AppState {
        auth,
        pool,
        registry: api::registry::ConnectionRegistry::new(),
        nats,
        search_rate_limiter: api::search::SearchRateLimiter::new(),
        push_notifier: std::sync::Arc::new(api::push::ExpoPushNotifier::new()),
        avatar_store: api::avatars::AvatarStore::from_env()
            .expect("failed to build AvatarStore for test"),
    }
}

fn unique_email(label: &str) -> String {
    format!("{label}-{}@example.com", Uuid::new_v4())
}

fn unique_username(label: &str) -> String {
    let sanitized: String = label
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let mut username = format!("{sanitized}_{}", Uuid::new_v4().simple()).to_lowercase();
    username.truncate(30);
    username
}

async fn api_request(
    state: AppState,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let body = match body {
        Some(value) => {
            builder = builder.header("content-type", "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    let response = api::app(state)
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: Value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).expect("response body was not valid JSON")
    };
    (status, json)
}

/// Signs up a fresh user; returns `(token, user_id, email)`.
async fn signup_user(pool: &PgPool, state: AppState, label: &str) -> (String, Uuid, String) {
    let email = unique_email(label);
    let username = unique_username(label);
    let (status, body) = api_request(
        state,
        "POST",
        "/signup",
        None,
        Some(json!({ "email": email, "password": "correct-horse-battery", "username": username })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "signup failed: {body:?}");
    let token = body["token"].as_str().unwrap().to_string();
    let user_id: Uuid = sqlx::query("SELECT user_id FROM sessions WHERE token = $1")
        .bind(&token)
        .fetch_one(pool)
        .await
        .expect("session row must exist")
        .get("user_id");
    (token, user_id, email)
}

async fn add_contact(state: AppState, owner_token: &str, contact_email: &str) {
    let (status, body) = api_request(
        state,
        "POST",
        "/api/contacts",
        Some(owner_token),
        Some(json!({ "email": contact_email })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "add contact failed: {body:?}");
}

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

async fn get_queued(state: AppState, token: Option<&str>, from: Uuid) -> (StatusCode, Value) {
    api_request(
        state,
        "GET",
        &format!("/api/messages/queued/{from}"),
        token,
        None,
    )
    .await
}

/// Queues `bodies` (in order) to `recipient_id` via the real offline path.
/// The recipient never connects.
async fn queue_messages(
    addr: SocketAddr,
    sender_token: &str,
    recipient_id: Uuid,
    bodies: &[String],
) {
    let mut ws = connect_ws(addr, sender_token).await;
    for body in bodies {
        ws.send(WsMessage::text(
            json!({ "type": "send", "to": recipient_id, "body_b64": body }).to_string(),
        ))
        .await
        .expect("failed to send frame");
        let ack = recv_json(&mut ws).await;
        assert_eq!(ack, json!({ "type": "ack", "to": recipient_id }));
    }
}

fn b64(s: &str) -> String {
    BASE64.encode(s.as_bytes())
}

struct Fixture {
    state: AppState,
    addr: SocketAddr,
    a_token: String,
    a_id: Uuid,
    b_token: String,
    b_id: Uuid,
    c_token: String,
}

/// Users A, B, C; A and C both have B as a contact (so both may send to B).
async fn fixture(label: &str) -> Fixture {
    let pool = test_pool().await;
    let state = test_state().await;
    let (a_token, a_id, _) = signup_user(&pool, state.clone(), &format!("{label}-a")).await;
    let (b_token, b_id, b_email) = signup_user(&pool, state.clone(), &format!("{label}-b")).await;
    let (c_token, _c_id, _) = signup_user(&pool, state.clone(), &format!("{label}-c")).await;
    add_contact(state.clone(), &a_token, &b_email).await;
    add_contact(state.clone(), &c_token, &b_email).await;
    let addr = spawn_server(state.clone()).await;
    Fixture {
        state,
        addr,
        a_token,
        a_id,
        b_token,
        b_id,
        c_token,
    }
}

#[tokio::test]
#[serial]
async fn requires_authentication() {
    let f = fixture("mq-auth").await;
    let (status, _) = get_queued(f.state.clone(), None, f.a_id).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
#[serial]
async fn returns_404_when_nothing_queued() {
    let f = fixture("mq-empty").await;
    let (status, body) = get_queued(f.state.clone(), Some(&f.b_token), f.a_id).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, json!({ "error": "not_found" }));
}

#[tokio::test]
#[serial]
async fn returns_404_when_only_another_sender_queued() {
    let f = fixture("mq-other").await;
    queue_messages(f.addr, &f.c_token, f.b_id, &[b64("from c")]).await;
    let (status, body) = get_queued(f.state.clone(), Some(&f.b_token), f.a_id).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, json!({ "error": "not_found" }));
}

#[tokio::test]
#[serial]
async fn returns_oldest_from_sender_skipping_other_senders() {
    let f = fixture("mq-oldest").await;
    queue_messages(f.addr, &f.c_token, f.b_id, &[b64("from c first")]).await;
    let first = b64("a first");
    queue_messages(
        f.addr,
        &f.a_token,
        f.b_id,
        &[first.clone(), b64("a second")],
    )
    .await;
    let (status, body) = get_queued(f.state.clone(), Some(&f.b_token), f.a_id).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    assert_eq!(body["from"], f.a_id.to_string());
    assert_eq!(body["body_b64"], first);
    assert!(body["sent_at"].is_string());
}

#[tokio::test]
#[serial]
async fn repeated_fetch_is_idempotent() {
    let f = fixture("mq-idem").await;
    queue_messages(f.addr, &f.a_token, f.b_id, &[b64("one"), b64("two")]).await;
    let (s1, b1) = get_queued(f.state.clone(), Some(&f.b_token), f.a_id).await;
    let (s2, b2) = get_queued(f.state.clone(), Some(&f.b_token), f.a_id).await;
    assert_eq!(s1, StatusCode::OK);
    assert_eq!(s2, StatusCode::OK);
    assert_eq!(b1, b2);
    assert_eq!(b1["body_b64"], b64("one"));
}

#[tokio::test]
#[serial]
async fn fetch_does_not_consume_message_ws_still_delivers() {
    let f = fixture("mq-ws").await;
    let body = b64("still queued");
    queue_messages(f.addr, &f.a_token, f.b_id, std::slice::from_ref(&body)).await;
    let (status, fetched) = get_queued(f.state.clone(), Some(&f.b_token), f.a_id).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(fetched["body_b64"], body);

    let mut ws = connect_ws(f.addr, &f.b_token).await;
    let frame = recv_json(&mut ws).await;
    assert_eq!(frame["type"], "message");
    assert_eq!(frame["from"], f.a_id.to_string());
    assert_eq!(frame["body_b64"], body);
}

#[tokio::test]
#[serial]
async fn user_cannot_read_another_users_queue() {
    let f = fixture("mq-isolation").await;
    queue_messages(f.addr, &f.a_token, f.b_id, &[b64("for b only")]).await;
    // The message is queued for B; A and C must not see it.
    let (status, body) = get_queued(f.state.clone(), Some(&f.a_token), f.a_id).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body:?}");
    let (status, _) = get_queued(f.state.clone(), Some(&f.c_token), f.a_id).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
