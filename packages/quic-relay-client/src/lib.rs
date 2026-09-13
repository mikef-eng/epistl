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
use std::sync::{Arc, LazyLock};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};

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
    // Spike-appropriate timeout: fail fast against an unreachable/dead
    // server rather than waiting on Quinn's much longer default idle
    // timeout. Not a product-grade retry/backoff policy -- out of scope
    // for this spike (see issue #67's "out of scope").
    let mut transport_config = quinn::TransportConfig::default();
    transport_config.max_idle_timeout(Some(
        std::time::Duration::from_secs(5)
            .try_into()
            .expect("5s fits in Quinn's VarInt-backed IdleTimeout"),
    ));
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
