//! Epistl API library crate.
//!
//! Split out from `main.rs` so integration tests under `apps/api/tests/`
//! can build the same `Router` the binary serves, against a real Postgres
//! instance.

pub mod auth;
pub mod contacts;
pub mod db;

use axum::routing::get;
use axum::Router;

pub use auth::{AppState, AuthenticatedUser};

/// Build the full application router: `/health` plus the auth routes from
/// [`auth::router`] and the contacts routes from [`contacts::router`].
pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .merge(auth::router(state.clone()))
        .merge(contacts::router(state))
}

async fn health() -> &'static str {
    "ok"
}
