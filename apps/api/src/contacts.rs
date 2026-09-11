//! `GET/POST /api/contacts` and `DELETE /api/contacts/{user_id}`.
//!
//! Contacts are owned outright by this app (see
//! `migrations/0003_create_contacts_table.sql`), not mediated through
//! `better-auth`'s SeaORM store, so this module talks to the `contacts` /
//! `users` tables directly via `sqlx` against `AppState::pool`.
//!
//! One-directional by design (issue #3's "out of scope"): adding a contact
//! never adds the caller to the other user's list.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::auth::{AppState, AuthenticatedUser};

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/contacts", get(list_contacts).post(add_contact))
        .route("/api/contacts/{user_id}", delete(remove_contact))
        .with_state(state)
}

#[derive(Serialize, sqlx::FromRow)]
struct ContactView {
    user_id: Uuid,
    email: String,
    added_at: DateTime<Utc>,
}

fn internal_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "internal_error" })),
    )
        .into_response()
}

async fn list_contacts(user: AuthenticatedUser, State(state): State<AppState>) -> Response {
    let contacts = sqlx::query_as::<_, ContactView>(
        r#"
        SELECT c.contact_user_id AS user_id, u.email AS email, c.created_at AS added_at
        FROM contacts c
        JOIN users u ON u.id = c.contact_user_id
        WHERE c.owner_user_id = $1
        ORDER BY c.created_at ASC
        "#,
    )
    .bind(user.user.id)
    .fetch_all(&state.pool)
    .await;

    match contacts {
        Ok(contacts) => (StatusCode::OK, Json(json!({ "contacts": contacts }))).into_response(),
        Err(_) => internal_error(),
    }
}

#[derive(Debug, Deserialize, Default)]
struct AddContactPayload {
    #[serde(default)]
    email: Option<String>,
}

async fn add_contact(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Json(payload): Json<AddContactPayload>,
) -> Response {
    let email = payload.email.unwrap_or_default();

    let target =
        sqlx::query_as::<_, (Uuid, String)>("SELECT id, email FROM users WHERE email = $1")
            .bind(&email)
            .fetch_optional(&state.pool)
            .await;

    let (target_id, target_email) = match target {
        Ok(Some(row)) => row,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "user_not_found" })),
            )
                .into_response()
        }
        Err(_) => return internal_error(),
    };

    if target_id == user.user.id {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "cannot_add_self" })),
        )
            .into_response();
    }

    let inserted = sqlx::query_as::<_, (DateTime<Utc>,)>(
        r#"
        INSERT INTO contacts (owner_user_id, contact_user_id)
        VALUES ($1, $2)
        ON CONFLICT (owner_user_id, contact_user_id) DO NOTHING
        RETURNING created_at
        "#,
    )
    .bind(user.user.id)
    .bind(target_id)
    .fetch_optional(&state.pool)
    .await;

    match inserted {
        Ok(Some((added_at,))) => (
            StatusCode::CREATED,
            Json(json!({
                "user_id": target_id,
                "email": target_email,
                "added_at": added_at,
            })),
        )
            .into_response(),
        Ok(None) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": "already_added" })),
        )
            .into_response(),
        Err(_) => internal_error(),
    }
}

async fn remove_contact(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Path(contact_user_id): Path<Uuid>,
) -> Response {
    let result =
        sqlx::query("DELETE FROM contacts WHERE owner_user_id = $1 AND contact_user_id = $2")
            .bind(user.user.id)
            .bind(contact_user_id)
            .execute(&state.pool)
            .await;

    match result {
        Ok(result) if result.rows_affected() > 0 => StatusCode::NO_CONTENT.into_response(),
        Ok(_) => (StatusCode::NOT_FOUND, Json(json!({ "error": "not_found" }))).into_response(),
        Err(_) => internal_error(),
    }
}
