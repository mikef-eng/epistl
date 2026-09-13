//! Integration tests for the real QUIC listener (`apps/api/src/quic.rs`,
//! issue #73) against a real Postgres instance, the real `better-auth`-
//! backed session validation, and a real Quinn client dialing a real
//! Quinn-served QUIC endpoint -- mirroring `apps/api/tests/ws.rs`'s
//! coverage shape, but proving the QUIC transport and (critically)
//! cross-transport delivery via the shared `ConnectionRegistry`.
//!
//! Requires `DATABASE_URL` and `NATS_URL` to point at a reachable Postgres
//! and NATS (see `docker-compose.yml` for local dev, or the CI services).
//!
//! The client side here trusts the listener's freshly-generated dev
//! certificate without verification -- the same dev-only posture as
//! `packages/quic-relay-client`'s `DangerousDevOnlyCertVerifier`, per
//! `docs/decisions/0011-quic-dev-cert-trust-remains-dev-only.md`. This is a
//! deliberate, heavily-commented, test-only shortcut; never reuse this
//! trust logic outside tests.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use api::AppState;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use quinn::crypto::rustls::QuicClientConfig;
use quinn::{ClientConfig, Connection, Endpoint};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde_json::{json, Value};
use serial_test::serial;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use tower::ServiceExt;
use uuid::Uuid;

/// A fixed test secret -- `better-auth` requires at least 32 bytes. Not a
/// real secret; only ever used against ephemeral/local test databases.
/// Mirrors `apps/api/tests/ws.rs`'s `TEST_SECRET`.
const TEST_SECRET: &str = "test-only-secret-do-not-use-in-prod-32+";

/// How long any single read from a test connection is allowed to take
/// before the test fails, so a bug that hangs delivery fails fast instead
/// of hanging CI.
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

/// Signs up a fresh user (via the real `/signup` handler, in-process) and
/// returns `(token, user_id, email)`. Mirrors `apps/api/tests/ws.rs`.
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

/// Binds the Axum app to an ephemeral local port and serves it in the
/// background, for the WS half of cross-transport tests. Mirrors
/// `apps/api/tests/ws.rs::spawn_server`.
async fn spawn_ws_server(state: AppState) -> SocketAddr {
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

async fn connect_ws(
    addr: SocketAddr,
    token: &str,
) -> WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>> {
    let url = format!("ws://{addr}/ws?token={token}");
    let (ws, _response) = connect_async(url).await.expect("failed to open websocket");
    ws
}

async fn recv_ws_json(ws: &mut WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>) -> Value {
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

/// Binds the real QUIC listener via its actual public entry point,
/// `api::quic::maybe_spawn` (driven by the `QUIC_LISTEN_ADDR` env var it
/// reads), on an ephemeral port, and returns the address it bound to.
///
/// Sets `QUIC_LISTEN_ADDR` to that address for the duration of this call
/// only (env var access is otherwise process-global) -- safe here because
/// every test in this file runs `#[serial]`.
async fn spawn_quic_server(state: AppState) -> SocketAddr {
    // `maybe_spawn`'s public API only accepts an address via the env var,
    // not "bind whatever's free and tell me what you picked" -- so this
    // test binds its own ephemeral UDP port up front, then points
    // `QUIC_LISTEN_ADDR` at that fixed, known-free port. `127.0.0.1:0`
    // resolved via a throwaway std bind is racy under parallel test binaries,
    // but this file's tests are `#[serial]`, so no other test in this
    // process claims a port between the probe and the real bind.
    let probe = std::net::UdpSocket::bind("127.0.0.1:0").expect("failed to probe a free port");
    let addr = probe.local_addr().expect("failed to read probed addr");
    drop(probe);

    // SAFETY (in the concurrency sense, not memory-unsafety): every test in
    // this file is `#[serial]`, so no other test observes this env var
    // between the set below and `maybe_spawn` reading it.
    std::env::set_var(api::quic::LISTEN_ADDR_VAR, addr.to_string());
    api::quic::maybe_spawn(state)
        .await
        .expect("failed to start QUIC listener for test");
    std::env::remove_var(api::quic::LISTEN_ADDR_VAR);

    addr
}

/// Opens a real Quinn QUIC client connection to `addr`, trusting any server
/// certificate without verification (see [`DangerousDevOnlyCertVerifier`]
/// below) -- the listener's dev cert is freshly generated per test-process
/// QUIC startup and never pinned anywhere, matching
/// `packages/quic-relay-client`'s existing dev-only trust posture.
async fn connect_quic(addr: SocketAddr) -> (Endpoint, Connection) {
    ensure_crypto_provider_installed();

    let mut endpoint =
        Endpoint::client("0.0.0.0:0".parse().unwrap()).expect("failed to bind client UDP socket");
    endpoint.set_default_client_config(dev_only_client_config());

    let connection = endpoint
        .connect(addr, "localhost")
        .expect("failed to start QUIC connection")
        .await
        .expect("QUIC/TLS handshake failed");

    (endpoint, connection)
}

fn ensure_crypto_provider_installed() {
    if CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

fn dev_only_client_config() -> ClientConfig {
    let rustls_config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(DangerousDevOnlyCertVerifier))
        .with_no_client_auth();

    let quic_crypto =
        QuicClientConfig::try_from(rustls_config).expect("failed to build QUIC TLS client config");

    let mut client_config = ClientConfig::new(Arc::new(quic_crypto));
    let mut transport_config = quinn::TransportConfig::default();
    transport_config.max_idle_timeout(Some(
        Duration::from_secs(5)
            .try_into()
            .expect("5s fits in Quinn's VarInt-backed IdleTimeout"),
    ));
    client_config.transport_config(Arc::new(transport_config));
    client_config
}

/// **Insecure by design, test-only.** See
/// `packages/quic-relay-client`'s identical verifier for the full rationale
/// -- this crate deliberately duplicates it rather than depending on that
/// (mobile-target) crate from `apps/api`'s test suite.
#[derive(Debug)]
struct DangerousDevOnlyCertVerifier;

impl ServerCertVerifier for DangerousDevOnlyCertVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// Opens the connection's one persistent control stream and sends the
/// `{"type":"auth","token":...}` first frame.
async fn open_and_auth(
    connection: &Connection,
    token: &str,
) -> (quinn::SendStream, BufReader<quinn::RecvStream>) {
    let (mut send, recv) = connection
        .open_bi()
        .await
        .expect("failed to open control stream");
    send_line(
        &mut send,
        &json!({ "type": "auth", "token": token }).to_string(),
    )
    .await;
    (send, BufReader::new(recv))
}

async fn send_line(send: &mut quinn::SendStream, text: &str) {
    send.write_all(text.as_bytes())
        .await
        .expect("failed to write frame");
    send.write_all(b"\n")
        .await
        .expect("failed to write frame newline");
}

async fn recv_quic_json(reader: &mut BufReader<quinn::RecvStream>) -> Value {
    let mut line = String::new();
    let read = timeout(RECV_TIMEOUT, reader.read_line(&mut line))
        .await
        .expect("timed out waiting for a frame")
        .expect("failed to read frame line");
    assert!(read > 0, "stream ended before sending a frame");
    serde_json::from_str(line.trim_end_matches(['\r', '\n'])).expect("frame was not valid JSON")
}

/// Acceptance criterion: an invalid token gets the connection closed with
/// QUIC application error code 4001.
#[tokio::test]
#[serial]
async fn invalid_token_closes_with_4001() {
    let state = test_state().await;
    let addr = spawn_quic_server(state).await;
    let (_endpoint, connection) = connect_quic(addr).await;

    let (mut send, _recv) = connection
        .open_bi()
        .await
        .expect("failed to open control stream");
    send_line(
        &mut send,
        &json!({ "type": "auth", "token": "not-a-real-token" }).to_string(),
    )
    .await;

    let close_reason = timeout(RECV_TIMEOUT, connection.closed())
        .await
        .expect("timed out waiting for the connection to close");
    match close_reason {
        quinn::ConnectionError::ApplicationClosed(closed) => {
            assert_eq!(closed.error_code.into_inner(), 4001);
        }
        other => panic!("expected an application close with code 4001, got {other:?}"),
    }
}

/// Acceptance criterion: a valid token can auth and send a message that a
/// WS-connected recipient receives -- proving the QUIC-side auth-first-
/// frame handshake and the shared relay logic both work for a QUIC sender.
#[tokio::test]
#[serial]
async fn quic_sender_can_auth_and_relay_to_a_ws_connected_recipient() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (sender_token, sender_id, _sender_email) =
        signup_user(&pool, state.clone(), "quic-relay-sender").await;
    let (recipient_token, recipient_id, recipient_email) =
        signup_user(&pool, state.clone(), "quic-relay-recipient").await;
    add_contact(state.clone(), &sender_token, &recipient_email).await;

    let quic_addr = spawn_quic_server(state.clone()).await;
    let ws_addr = spawn_ws_server(state).await;

    let (_endpoint, connection) = connect_quic(quic_addr).await;
    let (mut send, mut recv) = open_and_auth(&connection, &sender_token).await;

    let mut recipient_ws = connect_ws(ws_addr, &recipient_token).await;

    let body_b64 = BASE64.encode(b"hello from a QUIC-connected sender");
    send_line(
        &mut send,
        &json!({ "type": "send", "to": recipient_id, "body_b64": body_b64 }).to_string(),
    )
    .await;

    let received = recv_ws_json(&mut recipient_ws).await;
    assert_eq!(received["type"], "message");
    assert_eq!(received["from"], sender_id.to_string());
    assert_eq!(received["body_b64"], body_b64);
    assert!(received["sent_at"].is_string());

    let ack = recv_quic_json(&mut recv).await;
    assert_eq!(ack, json!({ "type": "ack", "to": recipient_id }));
}

/// Acceptance criterion: a QUIC-connected recipient receives a message sent
/// by a WS-connected sender -- cross-transport delivery, proving the shared
/// registry actually works in both directions.
#[tokio::test]
#[serial]
async fn ws_sender_can_relay_to_a_quic_connected_recipient() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (sender_token, sender_id, _sender_email) =
        signup_user(&pool, state.clone(), "ws-to-quic-sender").await;
    let (recipient_token, recipient_id, recipient_email) =
        signup_user(&pool, state.clone(), "ws-to-quic-recipient").await;
    add_contact(state.clone(), &sender_token, &recipient_email).await;

    let quic_addr = spawn_quic_server(state.clone()).await;
    let ws_addr = spawn_ws_server(state).await;

    let (_endpoint, connection) = connect_quic(quic_addr).await;
    let (_send, mut recv) = open_and_auth(&connection, &recipient_token).await;

    let mut sender_ws = connect_ws(ws_addr, &sender_token).await;

    let body_b64 = BASE64.encode(b"hello from a WS-connected sender");
    sender_ws
        .send(WsMessage::text(
            json!({ "type": "send", "to": recipient_id, "body_b64": body_b64 }).to_string(),
        ))
        .await
        .expect("failed to send frame");

    let received = recv_quic_json(&mut recv).await;
    assert_eq!(received["type"], "message");
    assert_eq!(received["from"], sender_id.to_string());
    assert_eq!(received["body_b64"], body_b64);
    assert!(received["sent_at"].is_string());

    let ack = recv_ws_json(&mut sender_ws).await;
    assert_eq!(ack, json!({ "type": "ack", "to": recipient_id }));
}
