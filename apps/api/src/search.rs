//! `GET /api/users/search` -- authenticated, rate-limited, prefix-match
//! discover-search (issue #99), replacing the exact-email-only lookup
//! `AddContactScreen` used before. See
//! `docs/superpowers/specs/2026-09-13-search-design.md`, "Discover search",
//! for the design this implements.
//!
//! Deliberately its own module rather than folded into `contacts.rs`: this
//! is discovery (any user can be found by a prefix of their email; no
//! relationship status is implied or returned), not contact management,
//! and it carries a rate limit that must stay scoped to only this route
//! (issue #99's "out of scope": no other endpoint gets rate-limited here).
//!
//! ## Why not `tower::limit::RateLimitLayer`
//!
//! `apps/api` has no rate-limiting layer before this issue.
//! `tower::limit::RateLimitLayer` (available via the `limit` feature added
//! to `apps/api/Cargo.toml` in this same change) is the obvious first
//! thing to reach for, but its semantics don't fit this route's contract:
//!
//! - It implements *backpressure*, not load-shedding. Once a caller
//!   exhausts its budget, the wrapped service's `poll_ready` returns
//!   `Pending` until the window resets -- a caller waits out the window
//!   rather than getting an error back. This issue instead wants an
//!   immediate `429`.
//! - Its `RateLimit<S>` service doesn't implement `Clone`, but axum's
//!   `Router::layer` requires the wrapped service to be `Clone` (a
//!   `Router` itself must stay cheaply cloneable -- e.g. once per
//!   connection).
//!
//! So this module implements a small fixed-window counter instead, wired
//! in via `axum::middleware::from_fn_with_state` (itself backed by
//! `tower`'s `Layer`/`Service` traits): [`SearchRateLimiter`] holds its
//! count behind an `Arc<Mutex<_>>`, is trivially `Clone` (so it survives
//! being carried around on further `AppState` clones, e.g. across the
//! per-request `Router` rebuilds this crate's own integration tests do),
//! and rejects immediately with `429 { "error": "rate_limited" }` once a
//! window's budget is spent, rather than ever going `Pending`.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Query, Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::auth::{AppState, AuthenticatedUser};

/// Below this length (measured in `char`s, not bytes), `q` returns an
/// empty result list without touching Postgres at all: short enough to
/// match a huge fraction of rows, wasteful to run, and not useful to a
/// caller who's still typing.
const MIN_QUERY_LEN: usize = 3;

/// Matches are capped at this many rows -- plenty for a type-ahead
/// dropdown; a caller who needs a specific match should narrow the query
/// rather than page through results. `pub` for the same reason as
/// [`RATE_LIMIT_MAX_REQUESTS`]: so `tests/search.rs` can seed exactly
/// enough rows to exercise the cap without hardcoding a second copy of the
/// number.
pub const RESULT_LIMIT: i64 = 20;

/// How many requests a single [`SearchRateLimiter`] allows within
/// [`RATE_LIMIT_WINDOW`] before returning `429`. Chosen generously above
/// plausible type-ahead usage (roughly one request per keystroke, so a
/// user typing a full query well within the window is nowhere near this)
/// while still bounding scripted abuse. Not load-tested; revisit if real
/// traffic says otherwise.
// `pub` (rather than a private module const like [`MIN_QUERY_LEN`]/
// [`RESULT_LIMIT`] above) so `tests/search.rs`'s rate-limit test can drive
// exactly this many requests instead of hardcoding a second copy of the
// number that could silently drift out of sync with this one.
pub const RATE_LIMIT_MAX_REQUESTS: u32 = 30;
const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(60);

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/users/search", get(search_users))
        .route_layer(middleware::from_fn_with_state(state.clone(), rate_limit))
        .with_state(state)
}

/// A shared, cheaply-`Clone`-able fixed-window request counter. See the
/// module docs for why this exists instead of `tower::limit::RateLimitLayer`.
#[derive(Clone)]
pub struct SearchRateLimiter {
    inner: Arc<Mutex<Window>>,
}

struct Window {
    started_at: Instant,
    count: u32,
}

impl SearchRateLimiter {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Window {
                started_at: Instant::now(),
                count: 0,
            })),
        }
    }

    /// Returns `true` (and counts the request against the current window)
    /// if the caller is still within budget, `false` if the window's
    /// budget is already spent.
    fn try_acquire(&self) -> bool {
        let mut window = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        if now.duration_since(window.started_at) >= RATE_LIMIT_WINDOW {
            window.started_at = now;
            window.count = 0;
        }
        if window.count >= RATE_LIMIT_MAX_REQUESTS {
            false
        } else {
            window.count += 1;
            true
        }
    }
}

impl Default for SearchRateLimiter {
    fn default() -> Self {
        Self::new()
    }
}

fn rate_limited_error() -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({ "error": "rate_limited" })),
    )
        .into_response()
}

async fn rate_limit(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if state.search_rate_limiter.try_acquire() {
        next.run(request).await
    } else {
        rate_limited_error()
    }
}

#[derive(Debug, Deserialize, Default)]
struct SearchQueryParams {
    #[serde(default)]
    q: Option<String>,
}

#[derive(sqlx::FromRow, Serialize)]
struct SearchUserRow {
    user_id: Uuid,
    email: String,
    username: String,
}

fn internal_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "internal_error" })),
    )
        .into_response()
}

async fn search_users(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Query(params): Query<SearchQueryParams>,
) -> Response {
    let query = params.q.unwrap_or_default();

    if query.chars().count() < MIN_QUERY_LEN {
        return (StatusCode::OK, Json(json!({ "users": [] }))).into_response();
    }

    let rows = sqlx::query_as::<_, SearchUserRow>(
        r#"
        SELECT id AS user_id, email, username
        FROM users
        WHERE (email ILIKE $1 || '%' OR username ILIKE $1 || '%')
          AND id <> $2
        ORDER BY email ASC
        LIMIT $3
        "#,
    )
    .bind(&query)
    .bind(user.user.id)
    .bind(RESULT_LIMIT)
    .fetch_all(&state.pool)
    .await;

    match rows {
        Ok(rows) => (StatusCode::OK, Json(json!({ "users": rows }))).into_response(),
        Err(_) => internal_error(),
    }
}
