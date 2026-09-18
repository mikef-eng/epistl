//! `PATCH /api/username` -- lets an already-registered user change their own
//! username, authenticated the same way as `/api/push-tokens` and
//! `/api/account` (existing session-token middleware; see
//! `crate::auth::AuthenticatedUser`).
//!
//! This deliberately does not go through Better Auth's `/sign-up/email`-style
//! plugin machinery (see `auth::signup`'s own duplicate-detection dance) --
//! it's a plain authenticated CRUD-style route straight against the `users`
//! table (`migrations/0008_add_username_to_users.sql`), matching
//! `push_tokens.rs`'s pattern. Per issue #184's own scoping, this stays out
//! of `apps/api/src/auth.rs` entirely and does not need crypto-reviewer
//! sign-off.
//!
//! Uniqueness is enforced by the database's existing `users_username_key`
//! `UNIQUE` constraint rather than a separate pre-check `SELECT` -- a plain
//! `UPDATE ... RETURNING` either succeeds outright (including the no-op case
//! of re-submitting the caller's own current username, which never conflicts
//! with itself) or fails with a unique-violation naming that exact
//! constraint, which this handler translates to `409`. This avoids a
//! check-then-update race between the pre-check and the write.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::patch;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::auth::{AppState, AuthenticatedUser};

/// The `UNIQUE` constraint on `users.username`, added by
/// `migrations/0008_add_username_to_users.sql`.
const USERNAME_UNIQUE_CONSTRAINT: &str = "users_username_key";

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/username", patch(change_username))
        .with_state(state)
}

fn internal_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "internal_error" })),
    )
        .into_response()
}

fn bad_request(error: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response()
}

#[derive(Debug, Deserialize, Default)]
struct ChangeUsernamePayload {
    #[serde(default)]
    username: Option<String>,
}

/// Same format rule as signup: 3-32 characters, `^[a-zA-Z0-9_]+$`.
fn is_valid_username(username: &str) -> bool {
    (3..=32).contains(&username.len())
        && username
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn is_username_unique_violation(err: &sqlx::Error) -> bool {
    match err {
        sqlx::Error::Database(db_err) => {
            db_err.is_unique_violation() && db_err.constraint() == Some(USERNAME_UNIQUE_CONSTRAINT)
        }
        _ => false,
    }
}

async fn change_username(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Json(payload): Json<ChangeUsernamePayload>,
) -> Response {
    let username = payload.username.unwrap_or_default();
    if !is_valid_username(&username) {
        return bad_request("invalid_username");
    }

    // Normalized to lowercase the same way Better Auth's own
    // `validate_username`/`normalize_username` normalizes usernames set at
    // signup (see `auth::signup`'s comment) -- keeps `users.username`
    // consistently lowercase so the `UNIQUE` constraint actually catches
    // case-variant duplicates instead of letting e.g. "Alice" and "alice"
    // coexist as distinct rows.
    let normalized = username.to_lowercase();

    let updated = sqlx::query_scalar::<_, String>(
        r#"
        UPDATE users
        SET username = $1, updated_at = now()
        WHERE id = $2
        RETURNING username
        "#,
    )
    .bind(&normalized)
    .bind(user.user.id)
    .fetch_one(&state.pool)
    .await;

    match updated {
        Ok(username) => (StatusCode::OK, Json(json!({ "username": username }))).into_response(),
        Err(err) if is_username_unique_violation(&err) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": "username already taken" })),
        )
            .into_response(),
        Err(_) => internal_error(),
    }
}
