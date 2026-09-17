//! `quic-relay-client` -- spike crate for issue #67.
//!
//! This crate exists to answer exactly one question as cheaply as possible:
//! can Quinn (Rust's QUIC implementation) be exposed to React Native as a
//! real TurboModule via `uniffi-bindgen-react-native`, end to end? It is
//! **not** product code -- see
//! `docs/superpowers/specs/2026-09-13-quic-quinn-transport-design.md` and
//! GitHub issue #67 for the full context and scope.
//!
//! The crate exposes exactly one UniFFI-annotated async function,
//! [`quic_ping`], which: opens a Quinn QUIC client connection to a
//! caller-supplied host/port, opens a bidirectional stream, writes `b"ping"`,
//! reads back whatever the peer echoes, and returns either the echoed bytes
//! or a typed [`QuicClientError`].

use std::net::SocketAddr;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use std::time::Duration;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

uniffi::setup_scaffolding!();

/// Typed failure modes for [`quic_ping`]. Deliberately *not* a single
/// stringly-typed error, per issue #67's acceptance criteria: callers
/// (Swift/Kotlin/TypeScript, via UniFFI) can distinguish "we never got a
/// working QUIC connection" from "the connection worked but the stream
/// round-trip itself failed."
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum QuicClientError {
    /// Covers everything up to and including having an open QUIC
    /// connection with a completed TLS 1.3 handshake: address resolution,
    /// UDP socket binding, the QUIC handshake (including TLS handshake
    /// failure), and opening the bidirectional stream on that connection.
    #[error("QUIC connection failed: {message}")]
    ConnectionFailed { message: String },

    /// Covers everything after the bidirectional stream was successfully
    /// opened: writing the ping bytes, finishing the send side, and reading
    /// the echoed response back.
    #[error("QUIC stream I/O failed: {message}")]
    StreamIoFailed { message: String },

    /// [`QuicConnection::connect`]-only (issue #75): the server closed the
    /// connection with QUIC application error code
    /// [`CLOSE_CODE_UNAUTHORIZED`] within [`AUTH_RESULT_GRACE`] of the auth
    /// frame being written, i.e. it rejected the token. Distinguished from
    /// [`QuicClientError::ConnectionFailed`] so a caller (the mobile
    /// driver, the next issue in this batch) can tell "bad token" apart
    /// from "network problem" -- see [`AUTH_RESULT_GRACE`]'s doc comment
    /// for why this can't be a fully reliable synchronous signal, and
    /// [`QuicConnectionListener::on_closed`] for the fallback when a
    /// rejection arrives later than that.
    #[error("QUIC auth failed: {message}")]
    AuthFailed { message: String },
}

const PING_BYTES: &[u8] = b"ping";
// Generous upper bound for the echoed response; this is a spike against a
// throwaway server that only ever echoes back `PING_BYTES`.
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

/// A single tokio runtime, lazily started on first use and shared by every
/// call to [`quic_ping`]. Quinn's `runtime-tokio` feature requires an active
/// tokio context; UniFFI's async support drives this crate's exported
/// `async fn`s from whatever executor the host platform (JS event loop, via
/// the generated TurboModule glue) uses, which is *not* a tokio context. So
/// the actual QUIC work is spawned onto this runtime, and `quic_ping` just
/// awaits that spawned task -- awaiting a `JoinHandle` does not itself
/// require tokio context.
static RUNTIME: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .thread_name("quic-relay-client")
        .build()
        .expect("failed to start quic-relay-client's internal tokio runtime")
});

/// Installs `ring` as the process-wide default `rustls` crypto provider, if
/// one isn't already installed. Idempotent and safe to call from multiple
/// call sites/threads (`install_default` returns `Err` if a provider is
/// already installed, which is expected and ignored here -- Quinn's own
/// `rustls-ring` feature may install one first).
fn ensure_crypto_provider_installed() {
    if CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

/// Opens a Quinn QUIC client connection to `host:port`, opens a
/// bidirectional stream, writes `b"ping"`, and returns whatever bytes the
/// peer echoes back on that same stream.
///
/// This function accepts *any* server TLS certificate without verification
/// (see [`DangerousDevOnlyCertVerifier`] below) -- that is a deliberate,
/// heavily-commented, spike-only shortcut. This crate exists solely to
/// prove the Quinn-through-UniFFI-through-TurboModule toolchain against a
/// throwaway local dev server (`apps/api/examples/quic_echo_server.rs`); it
/// has no production TLS/cert/deployment story (see issue #67's "out of
/// scope"). Do not reuse this trust logic outside the spike.
#[uniffi::export]
pub async fn quic_ping(host: String, port: u16) -> Result<Vec<u8>, QuicClientError> {
    match RUNTIME.spawn(quic_ping_impl(host, port)).await {
        Ok(result) => result,
        Err(join_error) => Err(QuicClientError::StreamIoFailed {
            message: format!("internal quic-relay-client task panicked: {join_error}"),
        }),
    }
}

async fn quic_ping_impl(host: String, port: u16) -> Result<Vec<u8>, QuicClientError> {
    let remote_addr = resolve_addr(&host, port).await?;
    let client_config = build_dev_client_config()?;

    let mut endpoint = quinn::Endpoint::client("0.0.0.0:0".parse().unwrap()).map_err(|error| {
        QuicClientError::ConnectionFailed {
            message: format!("failed to bind local UDP socket: {error}"),
        }
    })?;
    endpoint.set_default_client_config(client_config);

    let connecting = endpoint.connect(remote_addr, &host).map_err(|error| {
        QuicClientError::ConnectionFailed {
            message: format!("failed to start QUIC connection: {error}"),
        }
    })?;

    let connection = connecting
        .await
        .map_err(|error| QuicClientError::ConnectionFailed {
            message: format!("QUIC/TLS handshake failed: {error}"),
        })?;

    let (mut send, mut recv) =
        connection
            .open_bi()
            .await
            .map_err(|error| QuicClientError::ConnectionFailed {
                message: format!("failed to open bidirectional stream: {error}"),
            })?;

    send.write_all(PING_BYTES)
        .await
        .map_err(|error| QuicClientError::StreamIoFailed {
            message: format!("failed to write ping bytes: {error}"),
        })?;
    send.finish()
        .map_err(|error| QuicClientError::StreamIoFailed {
            message: format!("failed to finish send stream: {error}"),
        })?;

    let response = recv
        .read_to_end(MAX_RESPONSE_BYTES)
        .await
        .map_err(|error| QuicClientError::StreamIoFailed {
            message: format!("failed to read echoed response: {error}"),
        })?;

    connection.close(0u32.into(), b"quic-relay-client spike done");
    endpoint.close(0u32.into(), b"quic-relay-client spike done");

    Ok(response)
}

async fn resolve_addr(host: &str, port: u16) -> Result<SocketAddr, QuicClientError> {
    tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| QuicClientError::ConnectionFailed {
            message: format!("failed to resolve {host}:{port}: {error}"),
        })?
        .next()
        .ok_or_else(|| QuicClientError::ConnectionFailed {
            message: format!("no addresses resolved for {host}:{port}"),
        })
}

fn build_dev_client_config() -> Result<quinn::ClientConfig, QuicClientError> {
    ensure_crypto_provider_installed();

    let rustls_config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(DangerousDevOnlyCertVerifier))
        .with_no_client_auth();

    let quic_crypto =
        quinn::crypto::rustls::QuicClientConfig::try_from(rustls_config).map_err(|error| {
            QuicClientError::ConnectionFailed {
                message: format!("failed to build QUIC TLS config: {error}"),
            }
        })?;

    let mut client_config = quinn::ClientConfig::new(Arc::new(quic_crypto));
    // Fail fast against an unreachable/dead server rather than waiting on
    // Quinn's much longer default idle timeout -- originally chosen for
    // this crate's issue #67 spike (`quic_ping`'s single short-lived
    // round trip), but this config is also what `QuicConnection::connect`
    // below uses for the real, long-lived control-stream connection
    // (issue #73/#75) that backs the mobile app's persistent chat relay.
    // Without a `keep_alive_interval` shorter than this, Quinn has no
    // traffic to reset the idle timer during a normal quiet chat session
    // (no messages sent either direction), so the connection was
    // dropping and reconnecting roughly every 5s at all times other than
    // active typing -- not a real network failure. `keep_alive_interval`
    // makes Quinn emit periodic PINGs itself so an otherwise-healthy
    // connection never goes idle long enough to hit the timeout below,
    // while a genuinely dead path (no PING responses) still fails fast.
    let mut transport_config = quinn::TransportConfig::default();
    transport_config.max_idle_timeout(Some(
        std::time::Duration::from_secs(5)
            .try_into()
            .expect("5s fits in Quinn's VarInt-backed IdleTimeout"),
    ));
    transport_config.keep_alive_interval(Some(std::time::Duration::from_secs(2)));
    client_config.transport_config(Arc::new(transport_config));

    Ok(client_config)
}

/// **Insecure by design, spike-only.** Accepts any server certificate
/// without any validation at all -- no chain check, no hostname check, no
/// expiry check. This is only acceptable because this crate's sole purpose
/// is proving the Quinn/UniFFI/TurboModule toolchain against a throwaway
/// local dev server presenting a self-signed cert generated at that
/// server's startup (see `apps/api/examples/quic_echo_server.rs`). This
/// verifier must never be reused for anything that isn't this spike.
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
        // Quinn's default `ring` crypto provider's full supported set --
        // this verifier never actually checks signatures, but rustls
        // requires an accurate list to negotiate the handshake.
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

// ---------------------------------------------------------------------
// Persistent connection (issue #75)
// ---------------------------------------------------------------------
//
// Everything below extends this crate beyond `quic_ping`'s one-shot round
// trip into a long-lived [`QuicConnection`], capable of carrying
// `apps/api/src/quic.rs`'s (issue #73) real wire protocol for the lifetime
// of a chat session: one client-opened bidirectional stream used as a
// persistent control channel, newline-delimited JSON frames,
// `{"type":"auth","token":...}` as the first frame, and QUIC application
// close codes 4001 (auth failure) / 4002 (replaced by a newer connection).
// This is new, additive UniFFI surface -- `quic_ping` above is untouched
// and remains available as a standalone manual-smoke-test tool (see its own
// doc comment).
//
// Reuses (does not reinvent) the exact same dev-cert trust posture as
// `quic_ping`: `resolve_addr` and `build_dev_client_config` above are
// called as-is -- see
// `docs/decisions/0011-quic-dev-cert-trust-remains-dev-only.md`.

/// QUIC application error code `apps/api/src/quic.rs` (issue #73) sends
/// when the first frame isn't a valid `auth` frame with a token that
/// authenticates. Numerically mirrors that module's `CLOSE_UNAUTHORIZED`
/// (and WS's `CLOSE_UNAUTHORIZED`, which it in turn mirrors).
const CLOSE_CODE_UNAUTHORIZED: u64 = 4001;

/// How long [`QuicConnection::connect`] waits, after writing the auth
/// frame, to see whether the server closes the connection before
/// concluding the token was accepted.
///
/// The wire protocol (issue #73) has no explicit "auth ok" frame -- a
/// successful auth is silent, the server just starts relaying. So this is
/// a bounded heuristic, not a real acknowledgement: if the server takes
/// longer than this to reject a bad token, `connect` still returns `Ok`,
/// and the rejection is instead reported later via
/// [`QuicConnectionListener::on_closed`] once the connection actually
/// closes. 200ms is generous relative to same-host integration tests and a
/// same-network mobile client talking to its own backend, since the
/// server-side check (`authenticate_first_frame` in `apps/api/src/quic.rs`)
/// does no I/O beyond a JSON parse and an in-memory/DB token lookup --
/// nowhere near 200ms of added latency in the success case, where `connect`
/// always waits out this whole window (nothing else could tell it sooner
/// that the server is *not* about to close the connection).
const AUTH_RESULT_GRACE: Duration = Duration::from_millis(200);

/// Pushed to the JS side as frames/close notifications arrive on a
/// [`QuicConnection`]'s control stream, asynchronously and independently of
/// any specific `connect`/`send` call -- implemented on the JS side by the
/// generated TurboModule glue (the mobile driver, the next issue in this
/// batch), and passed in to [`QuicConnection::connect`].
///
/// A UniFFI callback interface: when the *foreign* (JS) side implements
/// this trait, calls to `on_frame`/`on_closed` cross the FFI boundary via
/// UniFFI's generated callback machinery. When this crate's own tests
/// implement it directly in Rust (see `tests/connection.rs`), these are
/// just ordinary trait method calls -- no FFI involved.
#[uniffi::export(callback_interface)]
pub trait QuicConnectionListener: Send + Sync {
    /// Called once per newline-delimited JSON frame received on the
    /// control stream (the trailing newline is stripped, the frame's text
    /// is otherwise unparsed/unvalidated -- same division of
    /// responsibility as `apps/api/src/quic.rs`, which also treats framing
    /// and payload parsing as separate concerns).
    fn on_frame(&self, frame: String);

    /// Called exactly once, when the control stream ends for any reason --
    /// the server closed the connection (including an auth rejection that
    /// arrived after [`AUTH_RESULT_GRACE`] had already elapsed), a network
    /// failure, or [`QuicConnection::close`] was called locally. No further
    /// `on_frame` calls follow. `reason` is a human-readable description,
    /// not a machine code, but it includes the QUIC application error code
    /// when the peer closed with one (e.g. `4001`/`4002`) so a caller that
    /// cares can still find it via substring match.
    fn on_closed(&self, reason: String);
}

/// A persistent QUIC connection to `apps/api`'s real listener (issue #73):
/// opened once via [`QuicConnection::connect`], then
/// [`QuicConnection::send`] and the [`QuicConnectionListener`] callback
/// carry frames for the life of the connection, until
/// [`QuicConnection::close`] or the peer closes it.
#[derive(Debug, uniffi::Object)]
pub struct QuicConnection {
    connection: quinn::Connection,
    endpoint: quinn::Endpoint,
    send: AsyncMutex<quinn::SendStream>,
    // Aborted by `close()` so a locally-initiated close doesn't also fire
    // `listener.on_closed` -- the caller already knows it closed the
    // connection itself. `std::sync::Mutex` (not tokio's) is fine here:
    // `close()` is synchronous and only ever holds this lock for the
    // instant it takes to `take()` the handle.
    reader_task: StdMutex<Option<JoinHandle<()>>>,
}

#[uniffi::export]
impl QuicConnection {
    /// Opens a QUIC connection to `host:port`, opens the one control
    /// stream, and writes `{"type":"auth","token":"<token>"}` plus a
    /// trailing newline as its first frame -- see this module's doc
    /// comment for the full wire protocol. Reuses the exact same dev-cert
    /// trust posture as [`quic_ping`] (`build_dev_client_config`, not
    /// reimplemented).
    ///
    /// `listener`'s `on_frame`/`on_closed` are called for every frame
    /// subsequently received on the control stream, for the lifetime of
    /// the connection -- see [`QuicConnectionListener`].
    ///
    /// Returns `Err(QuicClientError::AuthFailed)` if the server closes the
    /// connection with application error code `4001` within
    /// [`AUTH_RESULT_GRACE`] of the auth frame being written; see that
    /// constant's doc comment for why a rejection that arrives later than
    /// that is instead reported via `listener.on_closed` rather than from
    /// here.
    #[uniffi::constructor]
    pub async fn connect(
        host: String,
        port: u16,
        token: String,
        listener: Box<dyn QuicConnectionListener>,
    ) -> Result<Self, QuicClientError> {
        match RUNTIME
            .spawn(connect_impl(host, port, token, listener))
            .await
        {
            Ok(result) => result,
            Err(join_error) => Err(QuicClientError::ConnectionFailed {
                message: format!("internal quic-relay-client task panicked: {join_error}"),
            }),
        }
    }

    /// Writes `frame` plus a trailing newline to the control stream.
    pub async fn send(self: Arc<Self>, frame: String) -> Result<(), QuicClientError> {
        match RUNTIME.spawn(send_frame(self, frame)).await {
            Ok(result) => result,
            Err(join_error) => Err(QuicClientError::StreamIoFailed {
                message: format!("internal quic-relay-client task panicked: {join_error}"),
            }),
        }
    }

    /// Closes the connection. Harmless to call more than once, or after the
    /// peer already closed the connection (Quinn no-ops a close on an
    /// already-closed connection). Aborts this connection's background
    /// reader task first, so `listener.on_closed` is not called for a close
    /// the caller itself initiated -- the caller already knows.
    pub fn close(&self) {
        if let Some(reader_task) = self.reader_task.lock().unwrap().take() {
            reader_task.abort();
        }
        self.connection.close(0u32.into(), b"closed by client");
        self.endpoint.close(0u32.into(), b"closed by client");
    }
}

/// The actual body of [`QuicConnection::connect`] -- a free function, not
/// an associated function inside the `#[uniffi::export]`ed impl block.
/// `#[uniffi::export]` treats *every* function in that block as exported
/// UniFFI surface (even a private one, and even a constructor-shaped one
/// without a `self` receiver isn't supported there at all), so any helper
/// that shouldn't itself become part of the public API has to live outside
/// it -- see also [`send_frame`] below. Run on [`RUNTIME`], same division
/// as [`quic_ping_impl`] above.
async fn connect_impl(
    host: String,
    port: u16,
    token: String,
    listener: Box<dyn QuicConnectionListener>,
) -> Result<QuicConnection, QuicClientError> {
    let remote_addr = resolve_addr(&host, port).await?;
    let client_config = build_dev_client_config()?;

    let mut endpoint = quinn::Endpoint::client("0.0.0.0:0".parse().unwrap()).map_err(|error| {
        QuicClientError::ConnectionFailed {
            message: format!("failed to bind local UDP socket: {error}"),
        }
    })?;
    endpoint.set_default_client_config(client_config);

    let connecting = endpoint.connect(remote_addr, &host).map_err(|error| {
        QuicClientError::ConnectionFailed {
            message: format!("failed to start QUIC connection: {error}"),
        }
    })?;

    let connection = connecting
        .await
        .map_err(|error| QuicClientError::ConnectionFailed {
            message: format!("QUIC/TLS handshake failed: {error}"),
        })?;

    let (mut send, recv) =
        connection
            .open_bi()
            .await
            .map_err(|error| QuicClientError::ConnectionFailed {
                message: format!("failed to open control stream: {error}"),
            })?;

    let auth_frame = build_auth_frame(&token)?;
    send.write_all(auth_frame.as_bytes())
        .await
        .map_err(|error| QuicClientError::StreamIoFailed {
            message: format!("failed to write auth frame: {error}"),
        })?;

    // See `AUTH_RESULT_GRACE`'s doc comment: the wire protocol has no
    // explicit "auth ok" frame, so this is a bounded heuristic, not a real
    // acknowledgement.
    let closed_within_grace = tokio::select! {
        close_reason = connection.closed() => Some(close_reason),
        () = tokio::time::sleep(AUTH_RESULT_GRACE) => None,
    };
    if let Some(close_reason) = closed_within_grace {
        endpoint.close(0u32.into(), b"connect failed");
        return Err(classify_early_close(close_reason));
    }

    let reader_task = tokio::spawn(run_reader_loop(recv, connection.clone(), listener));

    Ok(QuicConnection {
        connection,
        endpoint,
        send: AsyncMutex::new(send),
        reader_task: StdMutex::new(Some(reader_task)),
    })
}

/// The actual body of [`QuicConnection::send`] -- a free function, not an
/// associated function inside the `#[uniffi::export]`ed impl block, for the
/// same reason as [`connect_impl`]: a function in that impl block, even a
/// private one with a `self` receiver, becomes part of the exported UniFFI
/// surface, which this helper deliberately is not.
async fn send_frame(connection: Arc<QuicConnection>, frame: String) -> Result<(), QuicClientError> {
    let mut send = connection.send.lock().await;
    send.write_all(frame.as_bytes())
        .await
        .map_err(|error| QuicClientError::StreamIoFailed {
            message: format!("failed to write frame: {error}"),
        })?;
    send.write_all(b"\n")
        .await
        .map_err(|error| QuicClientError::StreamIoFailed {
            message: format!("failed to write frame delimiter: {error}"),
        })
}

/// Reads newline-delimited frames off `recv` and pushes each to
/// `listener.on_frame`, for as long as the control stream stays open. When
/// it ends (for any reason), calls `listener.on_closed` exactly once with a
/// human-readable description -- see [`QuicConnectionListener::on_closed`].
async fn run_reader_loop(
    recv: quinn::RecvStream,
    connection: quinn::Connection,
    listener: Box<dyn QuicConnectionListener>,
) {
    let mut reader = BufReader::new(recv);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Err(_) => break,
            Ok(_) => {
                let frame = line.trim_end_matches(['\r', '\n']).to_string();
                listener.on_frame(frame);
            }
        }
    }

    let reason = match connection.close_reason() {
        Some(error) => describe_close_reason(&error),
        None => "control stream ended".to_string(),
    };
    listener.on_closed(reason);
}

/// Builds `connect`'s auth frame (`{"type":"auth","token":"<token>"}` plus
/// a trailing newline) as real JSON, so `token` is escaped correctly if it
/// ever contains characters that would need it -- matching
/// `apps/api/src/quic.rs`'s use of `serde_json` on the other side of this
/// same wire protocol.
fn build_auth_frame(token: &str) -> Result<String, QuicClientError> {
    let mut text = serde_json::to_string(&serde_json::json!({
        "type": "auth",
        "token": token,
    }))
    .map_err(|error| QuicClientError::StreamIoFailed {
        message: format!("failed to encode auth frame: {error}"),
    })?;
    text.push('\n');
    Ok(text)
}

/// Classifies a connection closure observed within [`AUTH_RESULT_GRACE`] of
/// writing the auth frame: application error code
/// [`CLOSE_CODE_UNAUTHORIZED`] means the token was rejected
/// ([`QuicClientError::AuthFailed`]); anything else is some other early
/// closure ([`QuicClientError::ConnectionFailed`]).
fn classify_early_close(error: quinn::ConnectionError) -> QuicClientError {
    if let quinn::ConnectionError::ApplicationClosed(app_close) = &error {
        if u64::from(app_close.error_code) == CLOSE_CODE_UNAUTHORIZED {
            return QuicClientError::AuthFailed {
                message: describe_close_reason(&error),
            };
        }
    }
    QuicClientError::ConnectionFailed {
        message: format!("connection closed before auth could be confirmed: {error}"),
    }
}

/// Formats a [`quinn::ConnectionError`] for [`QuicConnectionListener::on_closed`]
/// and [`QuicClientError`] messages, including the application error code
/// and peer-supplied reason text when the peer closed the connection with
/// one (rather than e.g. a transport-level failure or idle timeout).
fn describe_close_reason(error: &quinn::ConnectionError) -> String {
    match error {
        quinn::ConnectionError::ApplicationClosed(app_close) => format!(
            "closed by peer with application error code {} ({})",
            u64::from(app_close.error_code),
            String::from_utf8_lossy(&app_close.reason)
        ),
        other => format!("{other}"),
    }
}
