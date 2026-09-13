//! `GET/POST /api/contacts`, `DELETE /api/contacts/{user_id}`, and
//! `GET/POST /api/contacts/requests`.
//!
//! Contacts are owned outright by this app (see
//! `migrations/0003_create_contacts_table.sql`), not mediated through
//! `better-auth`'s SeaORM store, so this module talks to the `contacts` /
//! `contact_requests` / `users` tables directly via `sqlx` against
//! `AppState::pool`.
//!
//! `add_contact`/`list_contacts`/`remove_contact` remain one-directional by
//! design (issue #3's "out of scope"): adding a contact never adds the
//! caller to the other user's list.
//!
//! `GET /api/contacts` additionally `LEFT JOIN`s `user_keys` (issue #35) so
//! callers can fetch a contact's PQXDH public key bundle in the same
//! request; a contact who hasn't uploaded keys yet still appears, with all
//! four key fields `null`.
//!
//! `contact_requests` (issue #79, first of the mutual-contacts batch --
//! see `docs/superpowers/specs/2026-09-13-mutual-contacts-design.md`)
//! implements the pending-request half of that design: creating and
//! listing requests. Issue #80 adds accept/decline. Mutual removal lands
//! in a later issue in the same batch.
//!
//! Accept (issue #80) atomically inserts both directed `contacts` rows
//! and deletes the resolved `contact_requests` row in one transaction --
//! `status` only ever holds `'pending'` or `'declined'` (see
//! `migrations/0006_create_contact_requests_table.sql`), never
//! `'accepted'`, since the `contacts` table itself is the record of an
//! accepted relationship. Decline sets `status = 'declined'` and leaves
//! the row in place as an audit trail (and to keep the pending-uniqueness
//! index from blocking a fresh request, since it's scoped to
//! `WHERE status = 'pending'`).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::auth::{AppState, AuthenticatedUser};

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/contacts", get(list_contacts).post(add_contact))
        .route("/api/contacts/{user_id}", delete(remove_contact))
        .route(
            "/api/contacts/requests",
            get(list_contact_requests).post(create_contact_request),
        )
        .route(
            "/api/contacts/requests/{id}/accept",
            post(accept_contact_request),
        )
        .route(
            "/api/contacts/requests/{id}/decline",
            post(decline_contact_request),
        )
        .with_state(state)
}

#[derive(sqlx::FromRow)]
struct ContactRow {
    user_id: Uuid,
    email: String,
    added_at: DateTime<Utc>,
    x25519_public_key: Option<Vec<u8>>,
    kyber_public_key: Option<Vec<u8>>,
    dilithium_public_key: Option<Vec<u8>>,
    prekey_signature: Option<Vec<u8>>,
}

#[derive(Serialize)]
struct ContactView {
    user_id: Uuid,
    email: String,
    added_at: DateTime<Utc>,
    x25519_public_key_b64: Option<String>,
    kyber_public_key_b64: Option<String>,
    dilithium_public_key_b64: Option<String>,
    prekey_signature_b64: Option<String>,
}

impl From<ContactRow> for ContactView {
    fn from(row: ContactRow) -> Self {
        ContactView {
            user_id: row.user_id,
            email: row.email,
            added_at: row.added_at,
            x25519_public_key_b64: row.x25519_public_key.map(|bytes| BASE64.encode(bytes)),
            kyber_public_key_b64: row.kyber_public_key.map(|bytes| BASE64.encode(bytes)),
            dilithium_public_key_b64: row.dilithium_public_key.map(|bytes| BASE64.encode(bytes)),
            prekey_signature_b64: row.prekey_signature.map(|bytes| BASE64.encode(bytes)),
        }
    }
}

fn internal_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "internal_error" })),
    )
        .into_response()
}

async fn list_contacts(user: AuthenticatedUser, State(state): State<AppState>) -> Response {
    let contacts = sqlx::query_as::<_, ContactRow>(
        r#"
        SELECT
            c.contact_user_id AS user_id,
            u.email AS email,
            c.created_at AS added_at,
            k.x25519_public_key AS x25519_public_key,
            k.kyber_public_key AS kyber_public_key,
            k.dilithium_public_key AS dilithium_public_key,
            k.prekey_signature AS prekey_signature
        FROM contacts c
        JOIN users u ON u.id = c.contact_user_id
        LEFT JOIN user_keys k ON k.user_id = c.contact_user_id
        WHERE c.owner_user_id = $1
        ORDER BY c.created_at ASC
        "#,
    )
    .bind(user.user.id)
    .fetch_all(&state.pool)
    .await;

    match contacts {
        Ok(contacts) => {
            let contacts: Vec<ContactView> = contacts.into_iter().map(ContactView::from).collect();
            (StatusCode::OK, Json(json!({ "contacts": contacts }))).into_response()
        }
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

#[derive(Debug, Deserialize, Default)]
struct CreateContactRequestPayload {
    #[serde(default)]
    email: Option<String>,
}

async fn create_contact_request(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Json(payload): Json<CreateContactRequestPayload>,
) -> Response {
    let email = payload.email.unwrap_or_default();

    let target =
        sqlx::query_as::<_, (Uuid, String)>("SELECT id, email FROM users WHERE email = $1")
            .bind(&email)
            .fetch_optional(&state.pool)
            .await;

    let (target_id, _target_email) = match target {
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

    let already_contact = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM contacts
            WHERE (owner_user_id = $1 AND contact_user_id = $2)
               OR (owner_user_id = $2 AND contact_user_id = $1)
        )
        "#,
    )
    .bind(user.user.id)
    .bind(target_id)
    .fetch_one(&state.pool)
    .await;

    match already_contact {
        Ok(true) => {
            return (
                StatusCode::CONFLICT,
                Json(json!({ "error": "already_contact" })),
            )
                .into_response()
        }
        Ok(false) => {}
        Err(_) => return internal_error(),
    }

    // Crossed request: the target already has a pending request to the
    // caller. Surface it rather than silently merging -- the caller must
    // explicitly accept it.
    let incoming = sqlx::query_as::<_, (Uuid,)>(
        r#"
        SELECT id FROM contact_requests
        WHERE requester_user_id = $1 AND recipient_user_id = $2 AND status = 'pending'
        "#,
    )
    .bind(target_id)
    .bind(user.user.id)
    .fetch_optional(&state.pool)
    .await;

    match incoming {
        Ok(Some((request_id,))) => {
            return (
                StatusCode::CONFLICT,
                Json(json!({
                    "error": "incoming_request_exists",
                    "request_id": request_id,
                })),
            )
                .into_response()
        }
        Ok(None) => {}
        Err(_) => return internal_error(),
    }

    let inserted = sqlx::query_as::<_, ContactRequestRow>(
        r#"
        INSERT INTO contact_requests (requester_user_id, recipient_user_id)
        VALUES ($1, $2)
        ON CONFLICT (requester_user_id, recipient_user_id) WHERE status = 'pending' DO NOTHING
        RETURNING id, requester_user_id, recipient_user_id, status, created_at
        "#,
    )
    .bind(user.user.id)
    .bind(target_id)
    .fetch_optional(&state.pool)
    .await;

    match inserted {
        Ok(Some(row)) => (StatusCode::CREATED, Json(json!(row))).into_response(),
        Ok(None) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": "already_pending" })),
        )
            .into_response(),
        Err(_) => internal_error(),
    }
}

#[derive(sqlx::FromRow, Serialize)]
struct ContactRequestRow {
    id: Uuid,
    requester_user_id: Uuid,
    recipient_user_id: Uuid,
    status: String,
    created_at: DateTime<Utc>,
}

#[derive(sqlx::FromRow, Serialize)]
struct ContactRequestPartyView {
    id: Uuid,
    user_id: Uuid,
    email: String,
    created_at: DateTime<Utc>,
}

async fn list_contact_requests(user: AuthenticatedUser, State(state): State<AppState>) -> Response {
    let incoming = sqlx::query_as::<_, ContactRequestPartyView>(
        r#"
        SELECT cr.id AS id, u.id AS user_id, u.email AS email, cr.created_at AS created_at
        FROM contact_requests cr
        JOIN users u ON u.id = cr.requester_user_id
        WHERE cr.recipient_user_id = $1 AND cr.status = 'pending'
        ORDER BY cr.created_at ASC
        "#,
    )
    .bind(user.user.id)
    .fetch_all(&state.pool)
    .await;

    let incoming = match incoming {
        Ok(rows) => rows,
        Err(_) => return internal_error(),
    };

    let outgoing = sqlx::query_as::<_, ContactRequestPartyView>(
        r#"
        SELECT cr.id AS id, u.id AS user_id, u.email AS email, cr.created_at AS created_at
        FROM contact_requests cr
        JOIN users u ON u.id = cr.recipient_user_id
        WHERE cr.requester_user_id = $1 AND cr.status = 'pending'
        ORDER BY cr.created_at ASC
        "#,
    )
    .bind(user.user.id)
    .fetch_all(&state.pool)
    .await;

    let outgoing = match outgoing {
        Ok(rows) => rows,
        Err(_) => return internal_error(),
    };

    (
        StatusCode::OK,
        Json(json!({ "incoming": incoming, "outgoing": outgoing })),
    )
        .into_response()
}

fn not_recipient_error() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "error": "not_recipient" })),
    )
        .into_response()
}

fn request_not_found_error() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": "request_not_found" })),
    )
        .into_response()
}

/// Outcome of [`load_pending_request_as_recipient`]'s checks. Kept as a
/// small enum (rather than returning `Response` directly in the `Err` case)
/// so the `Result` stays cheap to move around -- see
/// `clippy::result_large_err`.
enum LoadPendingRequestError {
    NotFound,
    NotRecipient,
    Internal,
}

impl LoadPendingRequestError {
    fn into_response(self) -> Response {
        match self {
            LoadPendingRequestError::NotFound => request_not_found_error(),
            LoadPendingRequestError::NotRecipient => not_recipient_error(),
            LoadPendingRequestError::Internal => internal_error(),
        }
    }
}

/// Loads the request's `(requester_user_id, recipient_user_id, status)` and
/// applies the recipient/pending checks shared by accept and decline. `Ok`
/// carries the row once both checks pass; `Err` carries the outcome to
/// return immediately.
///
/// Order matters for what a caller can learn: a missing id can't be
/// attributed to a recipient at all, so it's `404` regardless of who's
/// asking. An existing id whose caller isn't the recipient is `403`,
/// regardless of status. Only once the caller is confirmed as the
/// recipient does a non-`pending` status become a (deliberately
/// indistinguishable-from-missing) `404`.
async fn load_pending_request_as_recipient(
    executor: impl sqlx::PgExecutor<'_>,
    request_id: Uuid,
    caller_id: Uuid,
) -> Result<(Uuid, Uuid), LoadPendingRequestError> {
    let row = sqlx::query_as::<_, (Uuid, Uuid, String)>(
        "SELECT requester_user_id, recipient_user_id, status FROM contact_requests WHERE id = $1",
    )
    .bind(request_id)
    .fetch_optional(executor)
    .await;

    let (requester_id, recipient_id, status) = match row {
        Ok(Some(row)) => row,
        Ok(None) => return Err(LoadPendingRequestError::NotFound),
        Err(_) => return Err(LoadPendingRequestError::Internal),
    };

    if recipient_id != caller_id {
        return Err(LoadPendingRequestError::NotRecipient);
    }
    if status != "pending" {
        return Err(LoadPendingRequestError::NotFound);
    }

    Ok((requester_id, recipient_id))
}

async fn accept_contact_request(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Path(request_id): Path<Uuid>,
) -> Response {
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return internal_error(),
    };

    let (requester_id, recipient_id) =
        match load_pending_request_as_recipient(&mut *tx, request_id, user.user.id).await {
            Ok(ids) => ids,
            Err(err) => return err.into_response(),
        };

    let inserted = sqlx::query(
        r#"
        INSERT INTO contacts (owner_user_id, contact_user_id)
        VALUES ($1, $2), ($2, $1)
        ON CONFLICT (owner_user_id, contact_user_id) DO NOTHING
        "#,
    )
    .bind(requester_id)
    .bind(recipient_id)
    .execute(&mut *tx)
    .await;

    if inserted.is_err() {
        return internal_error();
    }

    let deleted = sqlx::query("DELETE FROM contact_requests WHERE id = $1")
        .bind(request_id)
        .execute(&mut *tx)
        .await;

    if deleted.is_err() {
        return internal_error();
    }

    match tx.commit().await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => internal_error(),
    }
}

async fn decline_contact_request(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Path(request_id): Path<Uuid>,
) -> Response {
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return internal_error(),
    };

    if let Err(err) = load_pending_request_as_recipient(&mut *tx, request_id, user.user.id).await {
        return err.into_response();
    }

    let updated = sqlx::query(
        r#"
        UPDATE contact_requests
        SET status = 'declined', responded_at = now()
        WHERE id = $1 AND status = 'pending'
        "#,
    )
    .bind(request_id)
    .execute(&mut *tx)
    .await;

    let updated = match updated {
        Ok(result) => result,
        Err(_) => return internal_error(),
    };

    if updated.rows_affected() == 0 {
        // Raced with another resolution between the load above and this
        // update -- same indistinguishable-from-missing 404.
        return request_not_found_error();
    }

    match tx.commit().await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => internal_error(),
    }
}
