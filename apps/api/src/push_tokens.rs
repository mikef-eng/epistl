//! `POST /api/push-tokens` -- registers (upserts) the caller's per-device
//! push notification token (e.g. an Expo push token), authenticated the
//! same way as `/api/contacts` (existing session-token middleware; see
//! `crate::auth::AuthenticatedUser`).
//!
//! Storage lives in `push_tokens` (see
//! `migrations/0007_create_push_tokens_table.sql`) -- this table is
//! device-wake-up-ping metadata, not message content, so it does not
//! conflict with `docs/decisions/0001-message-content-never-in-postgres.md`.
//!
//! `token` is unique across the whole table, not just per-user: a device
//! can only ever be registered to one user's `user_id` at a time, so
//! re-registering a token previously associated with a *different* user
//! (e.g. a shared/reused device re-logging in as a different account)
//! reassigns the existing row to the new caller rather than erroring or
//! leaving two rows for the same token. Re-registering the same token for
//! the *same* user is a no-op beyond bumping nothing (idempotent, no
//! duplicate row, no error).
//!
//! This issue (#166) is server-only: no sending path and no mobile-side
//! caller live here yet -- see the issue's "Out of scope".

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::auth::{AppState, AuthenticatedUser};

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/push-tokens", post(register_push_token))
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
struct RegisterPushTokenPayload {
    #[serde(default)]
    token: Option<String>,
}

async fn register_push_token(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Json(payload): Json<RegisterPushTokenPayload>,
) -> Response {
    let token = payload.token.unwrap_or_default();
    if token.is_empty() {
        return bad_request("invalid_input");
    }

    // `token` is UNIQUE across the whole table (not per-user), so
    // ON CONFLICT (token) reassigns an existing row's `user_id` when the
    // same token was previously registered by a different user, and is a
    // true no-op (same user_id, same token) when re-registered by the same
    // user -- both are idempotent, single-row outcomes.
    let upserted = sqlx::query_as::<_, (Uuid, DateTime<Utc>)>(
        r#"
        INSERT INTO push_tokens (user_id, token)
        VALUES ($1, $2)
        ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id
        RETURNING id, created_at
        "#,
    )
    .bind(user.user.id)
    .bind(&token)
    .fetch_one(&state.pool)
    .await;

    match upserted {
        Ok((id, created_at)) => (
            StatusCode::OK,
            Json(json!({
                "id": id,
                "user_id": user.user.id,
                "created_at": created_at,
            })),
        )
            .into_response(),
        Err(_) => internal_error(),
    }
}
