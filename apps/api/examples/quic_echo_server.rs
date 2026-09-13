//! **Throwaway, spike-only. Not product code.**
//!
//! This is a minimal Quinn (QUIC) echo server, built solely to give
//! `packages/quic-relay-client`'s `quic_ping` UniFFI function something
//! real to talk to for issue #67's spike (prove Quinn can be exposed to
//! React Native as a TurboModule via `uniffi-bindgen-react-native`). See
//! `docs/superpowers/specs/2026-09-13-quic-quinn-transport-design.md`.
//!
//! It is deliberately **not** wired into `apps/api`'s real binary
//! (`src/main.rs`) or any route/service -- it does not share state, ports,
//! or code with the real Axum app. It exists only to be run by hand (or by
//! a mobile device on the same LAN) while manually verifying the spike's
//! test screen.
//!
//! ## Run it
//!
//! ```sh
//! cargo run --example quic_echo_server --manifest-path apps/api/Cargo.toml
//! ```
//!
//! It listens on UDP port **4433** on `0.0.0.0` (documented here as the
//! spike's fixed local port -- there is no env var for it, matching the
//! rest of this file's "throwaway, not configurable" nature). Any
//! bidirectional QUIC stream it receives is echoed back byte-for-byte.
//!
//! ## TLS
//!
//! QUIC mandates TLS 1.3 unconditionally -- there is no plaintext option.
//! This server generates a fresh, self-signed dev certificate in memory on
//! every startup via `rcgen` (never persisted to disk, never committed to
//! the repo), the same "clearly-labeled dev-only non-secret" spirit as
//! `AUTH_SECRET`'s dev default in `.env.example` -- except this value is
//! regenerated per run rather than a fixed default, since nothing needs it
//! to be stable across restarts. `packages/quic-relay-client`'s `quic_ping`
//! is deliberately written to accept any server certificate without
//! verification (see that crate's `DangerousDevOnlyCertVerifier`), which is
//! what makes trusting this freshly-generated, never-pinned cert possible.
//! This is a dev-only shortcut with no production TLS/cert/deployment story
//! -- see issue #67's "out of scope".

use std::sync::Arc;

const LISTEN_ADDR: &str = "0.0.0.0:4433";
const MAX_REQUEST_BYTES: usize = 64 * 1024;

#[tokio::main]
async fn main() {
    // Quinn's default crypto backend (`rustls-ring`) needs an installed
    // `rustls` crypto provider; nothing else in this standalone example
    // installs one first.
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("failed to install rustls ring crypto provider");

    let server_config = build_server_config();
    let endpoint = quinn::Endpoint::server(server_config, LISTEN_ADDR.parse().unwrap())
        .unwrap_or_else(|err| panic!("failed to bind QUIC listener on {LISTEN_ADDR}: {err}"));

    println!("quic_echo_server (spike, issue #67): listening on {LISTEN_ADDR}");
    println!("  self-signed dev cert generated fresh for this run -- not persisted");
    println!("  echoes back whatever bytes it receives on a bidirectional stream");

    while let Some(connecting) = endpoint.accept().await {
        tokio::spawn(async move {
            match connecting.await {
                Ok(connection) => {
                    println!("accepted connection from {}", connection.remote_address());
                    handle_connection(connection).await;
                }
                Err(err) => eprintln!("connection handshake failed: {err}"),
            }
        });
    }
}

async fn handle_connection(connection: quinn::Connection) {
    loop {
        let (mut send, mut recv) = match connection.accept_bi().await {
            Ok(stream) => stream,
            Err(err) => {
                println!("connection closed ({err}); no more streams");
                return;
            }
        };

        let data = match recv.read_to_end(MAX_REQUEST_BYTES).await {
            Ok(data) => data,
            Err(err) => {
                eprintln!("failed to read request stream: {err}");
                continue;
            }
        };

        println!("echoing {} byte(s): {:?}", data.len(), data);

        if let Err(err) = send.write_all(&data).await {
            eprintln!("failed to write echo response: {err}");
            continue;
        }
        if let Err(err) = send.finish() {
            eprintln!("failed to finish echo response stream: {err}");
        }
    }
}

fn build_server_config() -> quinn::ServerConfig {
    let cert_key =
        rcgen::generate_simple_self_signed(vec!["localhost".to_string(), "127.0.0.1".to_string()])
            .expect("failed to generate self-signed dev cert");
    let cert_der = cert_key.cert.der().clone();
    let key_der: rustls::pki_types::PrivateKeyDer<'static> = cert_key.signing_key.into();

    let rustls_config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![cert_der], key_der)
        .expect("failed to build TLS server config from dev cert");

    let quic_crypto = quinn::crypto::rustls::QuicServerConfig::try_from(rustls_config)
        .expect("failed to build QUIC TLS server config");

    quinn::ServerConfig::with_crypto(Arc::new(quic_crypto))
}
