//! Integration tests for [`QuicConnection`] (issue #75): the persistent,
//! multi-frame counterpart to `tests/ping.rs`'s one-shot `quic_ping`.
//!
//! Spins up a minimal in-process Quinn server that speaks the same wire
//! protocol `apps/api/src/quic.rs` (issue #73) implements for real: one
//! client-opened bidirectional stream, newline-delimited JSON frames,
//! `{"type":"auth","token":...}` as the first frame, and QUIC application
//! close code `4001` for a bad/missing token -- close enough to the real
//! listener that a protocol mismatch between `QuicConnection` and
//! `apps/api/src/quic.rs` would show up here, without pulling in the whole
//! `apps/api` binary (Postgres/NATS) as a test dependency.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use quic_relay_client::{QuicClientError, QuicConnection, QuicConnectionListener};
use quinn::VarInt;
use rustls::pki_types::PrivateKeyDer;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

fn install_ring_provider_once() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

const VALID_TOKEN: &str = "a-valid-test-token";

/// What the in-process test server does with a connection once (if) it
/// authenticates the first frame.
#[derive(Clone, Copy)]
enum PostAuthBehavior {
    /// Echoes every subsequent frame back as `echo:<frame>`, proving a real
    /// send + receive round trip.
    EchoFrames,
    /// Closes the connection immediately with a close code that isn't the
    /// auth-failure code, proving an abrupt server-side close (unrelated to
    /// auth) is surfaced via `QuicConnectionListener::on_closed`. Waits
    /// past `QuicConnection::connect`'s internal auth-result grace window
    /// first, so this genuinely exercises a mid-session close discovered
    /// by the background reader loop, not the early-close path `connect`
    /// itself already classifies (covered by the auth-failure test above).
    CloseAfterGraceWindow,
}

/// Starts a throwaway Quinn server bound to an OS-assigned loopback port,
/// speaking just enough of `apps/api/src/quic.rs`'s protocol to exercise
/// `QuicConnection`: reads one line, requires it to be a well-formed
/// `{"type":"auth","token":"..."}` frame with `token == VALID_TOKEN` (any
/// other first frame -- wrong token, malformed JSON, EOF -- closes with
/// application error code 4001, mirroring `CLOSE_UNAUTHORIZED`), then runs
/// `behavior`.
async fn spawn_test_server(behavior: PostAuthBehavior) -> SocketAddr {
    install_ring_provider_once();

    let cert_key = rcgen::generate_simple_self_signed(vec!["localhost".to_string()])
        .expect("failed to generate dev cert for test server");
    let cert_der = cert_key.cert.der().clone();
    let key_der: PrivateKeyDer<'static> = cert_key.signing_key.into();

    let server_crypto = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![cert_der], key_der)
        .expect("failed to build test server TLS config");

    let quic_crypto = quinn::crypto::rustls::QuicServerConfig::try_from(server_crypto)
        .expect("failed to build test server QUIC TLS config");
    let server_config = quinn::ServerConfig::with_crypto(Arc::new(quic_crypto));

    let endpoint = quinn::Endpoint::server(server_config, "127.0.0.1:0".parse().unwrap())
        .expect("failed to bind test server");
    let local_addr = endpoint
        .local_addr()
        .expect("failed to read test server's local address");

    tokio::spawn(async move {
        while let Some(connecting) = endpoint.accept().await {
            tokio::spawn(async move {
                let Ok(connection) = connecting.await else {
                    return;
                };
                let Ok((mut send, recv)) = connection.accept_bi().await else {
                    return;
                };
                let mut reader = BufReader::new(recv);
                let mut line = String::new();

                let Ok(read) = reader.read_line(&mut line).await else {
                    connection.close(VarInt::from_u32(4001), b"unauthorized");
                    return;
                };
                if read == 0 {
                    connection.close(VarInt::from_u32(4001), b"unauthorized");
                    return;
                }
                let text = line.trim_end_matches(['\r', '\n']);
                let authed = serde_json::from_str::<Value>(text)
                    .ok()
                    .filter(|parsed| parsed.get("type").and_then(Value::as_str) == Some("auth"))
                    .and_then(|parsed| {
                        parsed
                            .get("token")
                            .and_then(Value::as_str)
                            .map(|token| token == VALID_TOKEN)
                    })
                    .unwrap_or(false);

                if !authed {
                    connection.close(VarInt::from_u32(4001), b"unauthorized");
                    return;
                }

                match behavior {
                    PostAuthBehavior::EchoFrames => loop {
                        line.clear();
                        match reader.read_line(&mut line).await {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {
                                let frame = line.trim_end_matches(['\r', '\n']);
                                let echoed = format!("echo:{frame}\n");
                                if send.write_all(echoed.as_bytes()).await.is_err() {
                                    break;
                                }
                            }
                        }
                    },
                    PostAuthBehavior::CloseAfterGraceWindow => {
                        // Comfortably past `QuicConnection::connect`'s
                        // internal `AUTH_RESULT_GRACE` (200ms), so
                        // `connect` has already returned `Ok` by the time
                        // this fires.
                        tokio::time::sleep(Duration::from_millis(500)).await;
                        connection.close(VarInt::from_u32(4999), b"abrupt test close");
                    }
                }
            });
        }
    });

    local_addr
}

/// Collects `on_frame`/`on_closed` calls into channels a test can `await`
/// on, since `QuicConnectionListener`'s callbacks are plain synchronous
/// trait methods.
struct ChannelListener {
    frames_tx: mpsc::UnboundedSender<String>,
    closed_tx: Mutex<Option<mpsc::UnboundedSender<String>>>,
}

type ChannelListenerParts = (
    Box<dyn QuicConnectionListener>,
    mpsc::UnboundedReceiver<String>,
    mpsc::UnboundedReceiver<String>,
);

impl ChannelListener {
    fn create() -> ChannelListenerParts {
        let (frames_tx, frames_rx) = mpsc::unbounded_channel();
        let (closed_tx, closed_rx) = mpsc::unbounded_channel();
        (
            Box::new(Self {
                frames_tx,
                closed_tx: Mutex::new(Some(closed_tx)),
            }),
            frames_rx,
            closed_rx,
        )
    }
}

impl QuicConnectionListener for ChannelListener {
    fn on_frame(&self, frame: String) {
        let _ = self.frames_tx.send(frame);
    }

    fn on_closed(&self, reason: String) {
        // `on_closed` is documented to fire at most once; drop the sender
        // afterwards so the receiver observes channel-closed rather than
        // relying on more sends that shouldn't happen.
        if let Some(closed_tx) = self.closed_tx.lock().unwrap().take() {
            let _ = closed_tx.send(reason);
        }
    }
}

async fn recv_with_timeout(rx: &mut mpsc::UnboundedReceiver<String>) -> String {
    tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("timed out waiting for listener callback")
        .expect("listener channel closed unexpectedly")
}

#[tokio::test]
async fn connect_send_and_receive_round_trip_against_a_real_quic_server() {
    let addr = spawn_test_server(PostAuthBehavior::EchoFrames).await;
    let (listener, mut frames_rx, _closed_rx) = ChannelListener::create();

    let connection = QuicConnection::connect(
        "127.0.0.1".to_string(),
        addr.port(),
        VALID_TOKEN.to_string(),
        listener,
    )
    .await
    .expect("connect should succeed with a valid token");
    let connection = Arc::new(connection);

    connection
        .clone()
        .send(r#"{"type":"ping"}"#.to_string())
        .await
        .expect("send should succeed on an open connection");

    let frame = recv_with_timeout(&mut frames_rx).await;
    assert_eq!(frame, r#"echo:{"type":"ping"}"#);

    connection.close();
}

#[tokio::test]
async fn connect_reports_a_distinguishable_error_when_auth_fails() {
    let addr = spawn_test_server(PostAuthBehavior::EchoFrames).await;
    let (listener, _frames_rx, _closed_rx) = ChannelListener::create();

    let result = QuicConnection::connect(
        "127.0.0.1".to_string(),
        addr.port(),
        "definitely-the-wrong-token".to_string(),
        listener,
    )
    .await;

    assert!(
        matches!(result, Err(QuicClientError::AuthFailed { .. })),
        "expected AuthFailed, got: {result:?}"
    );
}

#[tokio::test]
async fn an_abrupt_server_close_is_surfaced_via_on_closed() {
    let addr = spawn_test_server(PostAuthBehavior::CloseAfterGraceWindow).await;
    let (listener, _frames_rx, mut closed_rx) = ChannelListener::create();

    let connection = QuicConnection::connect(
        "127.0.0.1".to_string(),
        addr.port(),
        VALID_TOKEN.to_string(),
        listener,
    )
    .await
    .expect("connect should succeed -- the server only closes after auth succeeds");

    let reason = recv_with_timeout(&mut closed_rx).await;
    assert!(
        reason.contains("4999"),
        "expected the close reason to mention the application error code, got: {reason:?}"
    );

    drop(connection);
}
