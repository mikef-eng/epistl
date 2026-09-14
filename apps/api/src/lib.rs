//! Epistl API library crate.
//!
//! Split out from `main.rs` so integration tests under `apps/api/tests/`
//! can build the same `Router` the binary serves, against a real Postgres
//! instance.

pub mod account;
pub mod auth;
pub mod contacts;
pub mod db;
pub mod keys;
pub mod nats;
pub mod quic;
pub mod registry;
pub mod relay;
pub mod ws;

use axum::routing::get;
use axum::Router;

pub use auth::{AppState, AuthenticatedUser};

/// Build the full application router: `/health` plus the auth routes from
/// [`auth::router`], the contacts routes from [`contacts::router`], the
/// key-storage routes from [`keys::router`], the account routes from
/// [`account::router`], and the `/ws` relay from [`ws::router`].
pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .merge(auth::router(state.clone()))
        .merge(contacts::router(state.clone()))
        .merge(keys::router(state.clone()))
        .merge(account::router(state.clone()))
        .merge(ws::router(state))
}

async fn health() -> &'static str {
    "ok"
}
