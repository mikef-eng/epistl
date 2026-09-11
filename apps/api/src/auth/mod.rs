//! Signup, login, and `Authorization: Bearer <token>` session validation.
//!
//! Backed directly by the `users` / `sessions` tables introduced in the
//! schema/migrations issue. Those tables were hand-written to mirror the
//! upstream Better Auth data model (see the comments in
//! `apps/api/migrations/0001_create_users_table.sql`) because `better-auth-rs`
//! 0.1.0 — the version available on crates.io at the time this module was
//! written — does not yet ship any usable API (its published `src/lib.rs` is
//! a placeholder `add(left, right)` function). Rather than block this issue
//! on an upstream crate that isn't ready, password hashing, token issuance,
//! and session lookups are implemented directly here against the
//! Better-Auth-shaped schema, so a real `better-auth-rs` integration can
//! swap this module out later without touching the schema or the wire
//! format of these endpoints.
//!
//! Passwords are hashed with Argon2 (via the `argon2`/`password-hash`
//! crates) before ever reaching the database, are never logged, and are
//! never echoed back in a response body.

use std::sync::OnceLock;

use argon2::password_hash::rand_core::{OsRng, RngCore};
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::{FromRef, FromRequestParts, State};
use axum::http::{header, request::Parts, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// How long an issued session token remains valid.
const SESSION_TTL_DAYS: i64 = 30;

/// Minimum acceptable password length, per this issue's acceptance
/// criteria.
const MIN_PASSWORD_LEN: usize = 8;

/// Postgres error code for a unique constraint violation, used to detect a
/// duplicate-email signup race without a separate existence check.
const UNIQUE_VIOLATION: &str = "23505";

/// Routes for `/api/auth/*`. Callers merge this with `.with_state(pool)`
/// into the main app router.
pub fn router() -> Router<PgPool> {
    Router::new()
        .route("/api/auth/signup", post(signup))
        .route("/api/auth/login", post(login))
}

#[derive(Debug, Deserialize, Default)]
struct Credentials {
    #[serde(default)]
    email: String,
    #[serde(default)]
    password: String,
}

#[derive(Debug, Serialize)]
struct AuthResponse {
    user_id: String,
    email: String,
    token: String,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

fn error_response(status: StatusCode, error: &'static str) -> Response {
    (
        status,
        Json(ErrorBody {
            error,
            message: None,
        }),
    )
        .into_response()
}

fn invalid_input(message: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(ErrorBody {
            error: "invalid_input",
            message: Some(message.to_string()),
        }),
    )
        .into_response()
}

async fn signup(State(pool): State<PgPool>, Json(body): Json<Credentials>) -> Response {
    let email = body.email.trim();
    if email.is_empty() {
        return invalid_input("email is required");
    }
    if body.password.len() < MIN_PASSWORD_LEN {
        return invalid_input("password must be at least 8 characters");
    }

    let password_hash = match hash_password(&body.password) {
        Ok(hash) => hash,
        Err(_) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
    };

    let inserted =
        sqlx::query("INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id")
            .bind(email)
            .bind(&password_hash)
            .fetch_one(&pool)
            .await;

    let user_id: Uuid = match inserted {
        Ok(row) => row.get("id"),
        Err(err) if is_unique_violation(&err) => {
            return error_response(StatusCode::CONFLICT, "email_taken");
        }
        Err(_) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
    };

    match create_session(&pool, user_id).await {
        Ok(token) => (
            StatusCode::CREATED,
            Json(AuthResponse {
                user_id: user_id.to_string(),
                email: email.to_string(),
                token,
            }),
        )
            .into_response(),
        Err(_) => error_response(StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
    }
}

async fn login(State(pool): State<PgPool>, Json(body): Json<Credentials>) -> Response {
    let email = body.email.trim();
    if email.is_empty() || body.password.is_empty() {
        return invalid_input("email and password are required");
    }

    let found = sqlx::query("SELECT id, email, password_hash FROM users WHERE email = $1")
        .bind(email)
        .fetch_optional(&pool)
        .await;

    let found = match found {
        Ok(found) => found,
        Err(_) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
    };

    let Some(row) = found else {
        // No such user: still run a password verification against a fixed
        // dummy hash so this branch takes roughly as long as the "wrong
        // password" branch below, rather than returning immediately. Both
        // branches return an identical response either way, but this
        // avoids an easy timing oracle for email enumeration.
        let _ = verify_password("irrelevant", dummy_hash());
        return error_response(StatusCode::UNAUTHORIZED, "invalid_credentials");
    };

    let user_id: Uuid = row.get("id");
    let user_email: String = row.get("email");
    let password_hash: Option<String> = row.get("password_hash");

    let matches = password_hash
        .as_deref()
        .map(|hash| verify_password(&body.password, hash))
        .unwrap_or(false);

    if !matches {
        return error_response(StatusCode::UNAUTHORIZED, "invalid_credentials");
    }

    match create_session(&pool, user_id).await {
        Ok(token) => (
            StatusCode::OK,
            Json(AuthResponse {
                user_id: user_id.to_string(),
                email: user_email,
                token,
            }),
        )
            .into_response(),
        Err(_) => error_response(StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
    }
}

fn hash_password(password: &str) -> Result<String, argon2::password_hash::Error> {
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default().hash_password(password.as_bytes(), &salt)?;
    Ok(hash.to_string())
}

fn verify_password(password: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// A precomputed Argon2 hash used only to equalize timing between "unknown
/// email" and "wrong password" login failures. Computed lazily once, from a
/// fixed non-secret string — it is never compared against real user input
/// in a way that matters (the outcome is discarded).
fn dummy_hash() -> &'static str {
    static HASH: OnceLock<String> = OnceLock::new();
    HASH.get_or_init(|| {
        hash_password("epistl-timing-equalization-dummy").expect("dummy hash must compute")
    })
    .as_str()
}

fn is_unique_violation(err: &sqlx::Error) -> bool {
    err.as_database_error()
        .and_then(|db_err| db_err.code())
        .map(|code| code == UNIQUE_VIOLATION)
        .unwrap_or(false)
}

async fn create_session(pool: &PgPool, user_id: Uuid) -> Result<String, sqlx::Error> {
    let token = generate_token();
    let expires_at = Utc::now() + Duration::days(SESSION_TTL_DAYS);

    sqlx::query("INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)")
        .bind(user_id)
        .bind(&token)
        .bind(expires_at)
        .execute(pool)
        .await?;

    Ok(token)
}

/// Generates a 256-bit, cryptographically random bearer token, hex-encoded.
fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Extractor that validates `Authorization: Bearer <token>` against the
/// `sessions` table and resolves the owning user.
///
/// `pub` so it can be reused directly by other routers (e.g. the contacts
/// endpoints) that need to require authentication — add `AuthUser` as a
/// handler parameter and axum will run this extraction before the handler
/// body runs, rejecting with `401 {"error": "unauthorized"}` on any
/// missing/invalid/expired token.
pub struct AuthUser {
    pub user_id: Uuid,
    pub email: String,
}

/// Rejection type for [`AuthUser`]. Always renders as `401
/// {"error": "unauthorized"}` — the specific reason (missing header,
/// malformed header, unknown token, expired token) is intentionally not
/// distinguished in the response.
pub struct AuthRejection;

impl IntoResponse for AuthRejection {
    fn into_response(self) -> Response {
        error_response(StatusCode::UNAUTHORIZED, "unauthorized")
    }
}

impl<S> FromRequestParts<S> for AuthUser
where
    PgPool: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = AuthRejection;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|token| !token.is_empty())
            .ok_or(AuthRejection)?;

        let pool = PgPool::from_ref(state);

        let row = sqlx::query(
            "SELECT sessions.user_id AS user_id, users.email AS email \
             FROM sessions \
             JOIN users ON users.id = sessions.user_id \
             WHERE sessions.token = $1 AND sessions.expires_at > now()",
        )
        .bind(token)
        .fetch_optional(&pool)
        .await
        .map_err(|_| AuthRejection)?;

        row.map(|row| AuthUser {
            user_id: row.get("user_id"),
            email: row.get("email"),
        })
        .ok_or(AuthRejection)
    }
}
