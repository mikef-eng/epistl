//! Library crate for the Epistl API.
//!
//! Split out from `main.rs` so integration tests (under `tests/`) can build
//! and exercise the real Axum router — including the shared auth
//! extractor — against a Postgres test database, instead of re-implementing
//! routing in each test file.

pub mod auth;
pub mod db;

use axum::routing::get;
use axum::Router;
use sqlx::PgPool;

/// Builds the full application router.
///
/// Sub-routers that need database access (e.g. [`auth::router`]) are given
/// their state via `.with_state` here, so the returned [`Router`] is fully
/// realized (`Router<()>`) and ready to hand to `axum::serve` or a test's
/// `oneshot` call.
pub fn app(pool: PgPool) -> Router {
    let public_routes = Router::new().route("/health", get(health));
    let auth_routes = auth::router().with_state(pool);

    public_routes.merge(auth_routes)
}

async fn health() -> &'static str {
    "ok"
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use sqlx::postgres::PgPoolOptions;
    use tower::ServiceExt;

    #[tokio::test]
    async fn health_returns_ok() {
        // `/health` never touches the pool, so a lazily-connecting pool
        // (no real connection attempt) is enough to build the router.
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://localhost/unused")
            .unwrap();
        let app = app(pool);
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&body[..], b"ok");
    }
}
