//! Integration tests for `quic_ping` (issue #67 spike).
//!
//! Spins up a minimal in-process Quinn echo server -- deliberately mirroring
//! `apps/api/examples/quic_echo_server.rs`'s shape (self-signed `rcgen` dev
//! cert, echo whatever it receives back on the same bidirectional stream) --
//! and exercises `quic_ping` against it over a real loopback QUIC
//! connection.

use std::net::SocketAddr;
use std::sync::Arc;

use quic_relay_client::{quic_ping, QuicClientError};
use rustls::pki_types::PrivateKeyDer;

fn install_ring_provider_once() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

/// Starts a throwaway Quinn echo server bound to an OS-assigned loopback
/// port and returns its address. The server task runs for the lifetime of
/// the test process; that's fine for a short-lived test binary.
async fn spawn_echo_server() -> SocketAddr {
    install_ring_provider_once();

    let cert_key = rcgen::generate_simple_self_signed(vec!["localhost".to_string()])
        .expect("failed to generate dev cert for test echo server");
    let cert_der = cert_key.cert.der().clone();
    let key_der: PrivateKeyDer<'static> = cert_key.signing_key.into();

    let server_crypto = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![cert_der], key_der)
        .expect("failed to build test echo server TLS config");

    let quic_crypto = quinn::crypto::rustls::QuicServerConfig::try_from(server_crypto)
        .expect("failed to build test echo server QUIC TLS config");
    let server_config = quinn::ServerConfig::with_crypto(Arc::new(quic_crypto));

    let endpoint = quinn::Endpoint::server(server_config, "127.0.0.1:0".parse().unwrap())
        .expect("failed to bind test echo server");
    let local_addr = endpoint
        .local_addr()
        .expect("failed to read test echo server's local address");

    tokio::spawn(async move {
        while let Some(connecting) = endpoint.accept().await {
            tokio::spawn(async move {
                let Ok(connection) = connecting.await else {
                    return;
                };
                while let Ok((mut send, mut recv)) = connection.accept_bi().await {
                    let Ok(data) = recv.read_to_end(64 * 1024).await else {
                        return;
                    };
                    let _ = send.write_all(&data).await;
                    let _ = send.finish();
                }
            });
        }
    });

    local_addr
}

#[tokio::test]
async fn quic_ping_round_trips_against_a_real_quic_server() {
    let addr = spawn_echo_server().await;

    let response = quic_ping("127.0.0.1".to_string(), addr.port())
        .await
        .expect("quic_ping should succeed against a live echo server");

    assert_eq!(response, b"ping");
}

#[tokio::test]
async fn quic_ping_reports_a_typed_connection_error_when_nothing_is_listening() {
    // Bind and immediately drop a socket to get a port that's very likely
    // free but that nothing is listening on for the duration of the test.
    let probe = std::net::UdpSocket::bind("127.0.0.1:0").expect("failed to bind probe socket");
    let unused_port = probe.local_addr().unwrap().port();
    drop(probe);

    let result = quic_ping("127.0.0.1".to_string(), unused_port).await;

    assert!(
        matches!(result, Err(QuicClientError::ConnectionFailed { .. })),
        "expected ConnectionFailed, got: {result:?}"
    );
}
