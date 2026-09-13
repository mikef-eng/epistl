//! Real (non-throwaway) Quinn-based QUIC listener, opt-in via the
//! `QUIC_LISTEN_ADDR` environment variable -- see [`LISTEN_ADDR_VAR`]. When
//! unset, [`maybe_spawn`] does nothing and the process's behavior is
//! unchanged: `/ws` ([`crate::ws`]) remains the only, always-on live-relay
//! transport. This listener never becomes required, and never replaces
//! `/ws` -- both run side by side when this is enabled.
//!
//! Like `/ws`, this module owns only its own transport-specific glue
//! (accepting QUIC connections/streams, framing bytes as newline-delimited
//! JSON, translating close semantics) and calls straight into the
//! transport-agnostic relay logic in [`crate::relay`], registering/removing
//! connections in the exact same [`crate::registry::ConnectionRegistry`]
//! `/ws` uses -- so a message relayed to (or from) a QUIC-connected user
//! works identically to a WS-connected one, and a message sent while one
//! party is on WS and the other on QUIC still reaches them.
//!
//! ## TLS
//!
//! QUIC mandates TLS 1.3 unconditionally -- there is no plaintext option.
//! On startup, when enabled, this listener generates a fresh self-signed
//! dev certificate in memory via `rcgen`, matching
//! `apps/api/examples/quic_echo_server.rs`'s existing pattern -- never
//! persisted to disk, regenerated every process start. This is a
//! deliberate, interim, dev-only posture -- see
//! `docs/decisions/0011-quic-dev-cert-trust-remains-dev-only.md`, which this
//! listener follows unchanged rather than inventing a different one.
//!
//! ## Wire protocol
//!
//! Each QUIC connection carries exactly one client-opened bidirectional
//! stream, used as a persistent control channel for the life of the
//! connection -- this listener never accepts a second stream on the same
//! connection. Frames on that stream are newline-delimited JSON (one JSON
//! object per line): necessary because a QUIC stream is a raw byte stream,
//! unlike a WebSocket's already-message-delimited frames.
//!
//! The first frame the client must send is `{"type":"auth","token":"<session
//! token>"}`. The server validates it via the same
//! [`crate::auth::authenticate_token`] function `/ws` uses.
//!
//! - **On auth failure** (missing/invalid token, or a first frame that
//!   isn't a well-formed `auth` frame at all): the connection is closed
//!   immediately with QUIC application error code [`CLOSE_UNAUTHORIZED`]
//!   (`4001`, numerically mirroring WS's `CLOSE_UNAUTHORIZED`), and no
//!   further frames are read.
//! - **On auth success**: the connection is registered in the shared
//!   [`crate::registry::ConnectionRegistry`], and every subsequent
//!   newline-delimited JSON frame on that stream is passed to
//!   [`crate::relay::handle_client_frame`], identical to a WS `send` frame.
//! - A connection **replaced by a same-user reconnect** (WS or QUIC) is
//!   closed with QUIC application error code [`CLOSE_REPLACED`] (`4002`,
//!   mirroring WS's `CLOSE_REPLACED`).
//! - Frames relayed to a QUIC-connected recipient (from a live WS sender, a
//!   live QUIC sender, or the offline-delivery queue) are written as one
//!   newline-delimited JSON line on that recipient's control stream, with
//!   the identical JSON payload shape `/ws` already sends (`{"type":
//!   "message", ...}`, `{"type": "ack", ...}`, `{"type": "error", ...}`) --
//!   no transport-specific frame shape.

use std::fmt;
use std::net::SocketAddr;
use std::sync::Arc;

use quinn::crypto::rustls::QuicServerConfig;
use quinn::{Connection, Endpoint, RecvStream, SendStream, ServerConfig, VarInt};
use rustls::crypto::CryptoProvider;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::auth::{self, AppState};
use crate::registry::Frame;

/// Environment variable that opts this listener in: unset (the default)
/// means it never starts. When set, its value is the address (e.g.
/// `0.0.0.0:4433`) it binds to.
pub const LISTEN_ADDR_VAR: &str = "QUIC_LISTEN_ADDR";

/// Close code sent when the connecting client's first frame isn't a valid
/// `auth` frame with a token that authenticates. Numerically mirrors
/// `crate::ws::CLOSE_UNAUTHORIZED`.
const CLOSE_UNAUTHORIZED: u16 = 4001;
/// Close code sent to a connection that a same-user reconnect (WS or QUIC)
/// has replaced. Numerically mirrors `crate::ws::CLOSE_REPLACED`.
const CLOSE_REPLACED: u16 = 4002;

/// Errors that can occur while starting the QUIC listener. Only surfaced
/// when `QUIC_LISTEN_ADDR` is actually set -- see [`maybe_spawn`].
#[derive(Debug)]
pub enum QuicListenError {
    /// `QUIC_LISTEN_ADDR`'s value could not be parsed as a socket address.
    InvalidAddr {
        value: String,
        source: std::net::AddrParseError,
    },
    /// The self-signed dev certificate could not be generated.
    GenerateCert(rcgen::Error),
    /// The TLS server config built from the dev cert was rejected.
    BuildTlsConfig(rustls::Error),
    /// The rustls server config couldn't be adapted into a QUIC-compatible
    /// one (e.g. no TLS 1.3 cipher suite was configured).
    BuildQuicConfig(quinn::crypto::rustls::NoInitialCipherSuite),
    /// The QUIC endpoint could not bind the configured address.
    Bind {
        addr: SocketAddr,
        source: std::io::Error,
    },
}

impl fmt::Display for QuicListenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            QuicListenError::InvalidAddr { value, source } => write!(
                f,
                "{LISTEN_ADDR_VAR}={value:?} is not a valid socket address: {source}"
            ),
            QuicListenError::GenerateCert(err) => {
                write!(f, "failed to generate self-signed dev cert: {err}")
            }
            QuicListenError::BuildTlsConfig(err) => {
                write!(f, "failed to build QUIC TLS server config: {err}")
            }
            QuicListenError::BuildQuicConfig(err) => {
                write!(f, "failed to adapt TLS config for QUIC: {err}")
            }
            QuicListenError::Bind { addr, source } => {
                write!(f, "failed to bind QUIC listener on {addr}: {source}")
            }
        }
    }
}

impl std::error::Error for QuicListenError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            QuicListenError::InvalidAddr { source, .. } => Some(source),
            QuicListenError::GenerateCert(err) => Some(err),
            QuicListenError::BuildTlsConfig(err) => Some(err),
            QuicListenError::BuildQuicConfig(err) => Some(err),
            QuicListenError::Bind { source, .. } => Some(source),
        }
    }
}

/// Reads [`LISTEN_ADDR_VAR`] and, if set, binds and spawns the QUIC
/// listener in the background, returning once the endpoint is bound (so a
/// misconfigured address fails startup fast, the same "fail fast" contract
/// `main.rs` already applies to Postgres/NATS). If the variable is unset,
/// returns `Ok(())` immediately without binding anything -- the process's
/// existing HTTP + WS behavior is completely unchanged.
pub async fn maybe_spawn(state: AppState) -> Result<(), QuicListenError> {
    let Ok(value) = std::env::var(LISTEN_ADDR_VAR) else {
        return Ok(());
    };

    let addr: SocketAddr = value
        .parse()
        .map_err(|source| QuicListenError::InvalidAddr { value, source })?;

    let endpoint = bind_endpoint(addr)?;
    println!("QUIC listener (issue #73): listening on {addr}");

    tokio::spawn(accept_loop(endpoint, state));
    Ok(())
}

/// Builds the dev-cert TLS config and binds the QUIC endpoint, without
/// starting the accept loop -- split out from [`maybe_spawn`] so tests can
/// bind an ephemeral port directly.
fn bind_endpoint(addr: SocketAddr) -> Result<Endpoint, QuicListenError> {
    ensure_crypto_provider_installed();
    let server_config = build_server_config()?;
    Endpoint::server(server_config, addr).map_err(|source| QuicListenError::Bind { addr, source })
}

/// Installs `ring` as the process-wide default `rustls` crypto provider, if
/// one isn't already installed. Idempotent -- unlike
/// `examples/quic_echo_server.rs` (a standalone binary that installs
/// unconditionally), the real API process also links `sqlx`'s
/// `tls-rustls` feature, so this must not panic if a provider is already
/// installed by the time this runs. Mirrors
/// `packages/quic-relay-client`'s `ensure_crypto_provider_installed`.
fn ensure_crypto_provider_installed() {
    if CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

/// Generates a fresh self-signed dev certificate (never persisted, matching
/// `examples/quic_echo_server.rs`'s `build_server_config` and
/// `docs/decisions/0011-quic-dev-cert-trust-remains-dev-only.md`) and builds
/// the QUIC-over-TLS server config from it.
fn build_server_config() -> Result<ServerConfig, QuicListenError> {
    let cert_key =
        rcgen::generate_simple_self_signed(vec!["localhost".to_string(), "127.0.0.1".to_string()])
            .map_err(QuicListenError::GenerateCert)?;
    let cert_der = cert_key.cert.der().clone();
    let key_der: rustls::pki_types::PrivateKeyDer<'static> = cert_key.signing_key.into();

    let rustls_config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![cert_der], key_der)
        .map_err(QuicListenError::BuildTlsConfig)?;

    let quic_crypto =
        QuicServerConfig::try_from(rustls_config).map_err(QuicListenError::BuildQuicConfig)?;

    Ok(ServerConfig::with_crypto(Arc::new(quic_crypto)))
}

/// Accepts connections forever, spawning a task per connection so a slow or
/// stalled client never blocks accepting the next one.
async fn accept_loop(endpoint: Endpoint, state: AppState) {
    while let Some(connecting) = endpoint.accept().await {
        let state = state.clone();
        tokio::spawn(async move {
            if let Ok(connection) = connecting.await {
                handle_connection(connection, state).await;
            }
        });
    }
}

/// Handles one QUIC connection end to end: accepts its single
/// client-opened bidirectional stream, authenticates the first frame,
/// registers in the shared registry on success, then relays every
/// subsequent frame through [`crate::relay::handle_client_frame`] until the
/// stream ends. See this module's doc comment for the full wire protocol.
async fn handle_connection(connection: Connection, state: AppState) {
    let (send, recv) = match connection.accept_bi().await {
        Ok(streams) => streams,
        // The client never opened its control stream (or the connection
        // ended before it could) -- nothing to authenticate or relay.
        Err(_) => return,
    };

    let mut reader = BufReader::new(recv);

    let user_id = match authenticate_first_frame(&state, &mut reader).await {
        Some(user_id) => user_id,
        None => {
            connection.close(
                VarInt::from_u32(u32::from(CLOSE_UNAUTHORIZED)),
                b"unauthorized",
            );
            return;
        }
    };

    let (tx, rx) = mpsc::unbounded_channel::<Frame>();

    if let Some(previous) = state.registry.insert(user_id, tx.clone()).await {
        let _ = previous.send(Frame::Close {
            code: CLOSE_REPLACED,
            reason: "replaced by a new connection".into(),
        });
    }

    // Every outbound frame for this connection -- relayed messages, acks,
    // and errors alike -- goes through `tx`/`rx` so there is exactly one
    // writer to the control stream at a time, mirroring `ws::handle_socket`.
    let forward_connection = connection.clone();
    let forward_task = tokio::spawn(async move {
        forward_frames(send, forward_connection, rx).await;
    });

    // Deliver anything queued for this user while they were offline (issue
    // #53) before processing any frames the client sends -- so a reconnect
    // always catches up before doing anything else, mirroring
    // `ws::handle_socket`.
    crate::relay::deliver_queued_messages(&state, user_id, &tx).await;

    let mut line = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line).await;
        let text = match read {
            Ok(0) => break, // EOF -- client closed its send side.
            Ok(_) => line.trim_end_matches(['\r', '\n']),
            Err(_) => break,
        };

        if crate::relay::handle_client_frame(&state, user_id, &tx, text)
            .await
            .is_err()
        {
            break;
        }
    }

    state.registry.remove_if_current(&user_id, &tx).await;
    drop(tx);
    forward_task.abort();
}

/// Forwards every [`Frame`] received on `rx` out over `send` as one
/// newline-delimited JSON line, until the channel closes or a write fails.
/// A [`Frame::Close`] closes the whole QUIC connection (with the frame's
/// close code as the QUIC application error code) rather than writing
/// anything further to the stream -- unlike WS, a QUIC stream close alone
/// wouldn't carry an application-level code the way `Message::Close` does;
/// the code has to live on the connection close itself.
async fn forward_frames(
    mut send: SendStream,
    connection: Connection,
    mut rx: mpsc::UnboundedReceiver<Frame>,
) {
    while let Some(frame) = rx.recv().await {
        match frame {
            Frame::Text(text) => {
                if send.write_all(text.as_bytes()).await.is_err() {
                    break;
                }
                if send.write_all(b"\n").await.is_err() {
                    break;
                }
            }
            Frame::Close { code, reason } => {
                connection.close(VarInt::from_u32(u32::from(code)), reason.as_bytes());
                break;
            }
        }
    }
}

/// Reads exactly one line from `reader` and validates it as an auth frame
/// (`{"type":"auth","token":"<session token>"}`), returning the
/// authenticated user's id on success. Any failure along the way (the
/// stream ending before a line arrives, malformed JSON, the wrong frame
/// `type`, a missing `token`, or `token` failing
/// [`crate::auth::authenticate_token`]) uniformly returns `None` -- the
/// caller closes with [`CLOSE_UNAUTHORIZED`] in every case, mirroring
/// `ws::ws_handler`'s uniform treatment of "missing token" and "invalid
/// token".
async fn authenticate_first_frame(
    state: &AppState,
    reader: &mut BufReader<RecvStream>,
) -> Option<Uuid> {
    let mut line = String::new();
    let read = reader.read_line(&mut line).await.ok()?;
    if read == 0 {
        // EOF before any frame arrived.
        return None;
    }
    let text = line.trim_end_matches(['\r', '\n']);

    let parsed: Value = serde_json::from_str(text).ok()?;
    if parsed.get("type").and_then(Value::as_str) != Some("auth") {
        return None;
    }
    let token = parsed.get("token").and_then(Value::as_str)?;

    let authed = auth::authenticate_token(state, token).await?;
    Some(authed.user.id)
}
