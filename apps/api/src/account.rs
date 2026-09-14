//! `DELETE /api/account` -- deletes the caller's own account.
//!
//! `users` is the root of the foreign-key graph: `sessions`
//! (`migrations/0002_create_sessions_table.sql`), `contacts`
//! (`migrations/0003_create_contacts_table.sql`), `user_keys`
//! (`migrations/0005_create_user_keys_table.sql`), and `contact_requests`
//! (`migrations/0006_create_contact_requests_table.sql`) all declare
//! `REFERENCES users(id) ON DELETE CASCADE`, so a single `DELETE FROM users`
//! is sufficient -- Postgres itself cascades the rest.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::delete;
use axum::{Json, Router};
use serde_json::json;

use crate::auth::{AppState, AuthenticatedUser};

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/account", delete(delete_account))
        .with_state(state)
}

fn internal_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "internal_error" })),
    )
        .into_response()
}

async fn delete_account(user: AuthenticatedUser, State(state): State<AppState>) -> Response {
    let result = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user.user.id)
        .execute(&state.pool)
        .await;

    match result {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => internal_error(),
    }
}
