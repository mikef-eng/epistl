//! Integration tests for `DELETE /api/account`, against a real Postgres
//! instance and the real `better-auth`-backed `AuthenticatedUser` extractor.
//!
//! Requires `DATABASE_URL` to point at a reachable Postgres (see
//! `docker-compose.yml` for local dev, or the `postgres:16` CI service).

use api::AppState;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use tower::ServiceExt;
use uuid::Uuid;

/// A fixed test secret -- `better-auth` requires at least 32 bytes. Not a
/// real secret; only ever used against ephemeral/local test databases.
const TEST_SECRET: &str = "test-only-secret-do-not-use-in-prod-32+";

async fn test_pool() -> PgPool {
    // Loads DATABASE_URL/AUTH_SECRET from a repo-root .env if present and
    // not already set (e.g. by CI). Safe to call redundantly per-test.
    dotenvy::dotenv().ok();
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set to run this integration test");
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await
        .expect("failed to connect to Postgres");

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("failed to run migrations");

    pool
}

async fn test_state() -> AppState {
    dotenvy::dotenv().ok();
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set to run this integration test");
    let auth = api::auth::build_auth(&database_url, TEST_SECRET)
        .await
        .expect("failed to build BetterAuth for test");
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await
        .expect("failed to connect to Postgres");
    let nats_url =
        std::env::var("NATS_URL").expect("NATS_URL must be set to run this integration test");
    let nats = async_nats::connect(&nats_url)
        .await
        .expect("failed to connect to NATS");
    AppState {
        auth,
        pool,
        registry: api::registry::ConnectionRegistry::new(),
        nats,
        search_rate_limiter: api::search::SearchRateLimiter::new(),
    }
}

fn unique_email(label: &str) -> String {
    format!("{label}-{}@example.com", Uuid::new_v4())
}

async fn request(
    app: Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let body = match body {
        Some(value) => {
            builder = builder.header("content-type", "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };

    let response = app.oneshot(builder.body(body).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: Value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).expect("response body was not valid JSON")
    };
    (status, json)
}

/// Signs up a fresh user and returns `(token, user_id, email)`.
async fn signup_user(pool: &PgPool, state: AppState, label: &str) -> (String, Uuid, String) {
    let email = unique_email(label);
    let (status, body) = request(
        api::app(state),
        "POST",
        "/signup",
        None,
        Some(json!({ "email": email, "password": "correct-horse-battery" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "signup failed: {body:?}");
    let token = body["token"].as_str().unwrap().to_string();

    let user_id: Uuid = sqlx::query("SELECT user_id FROM sessions WHERE token = $1")
        .bind(&token)
        .fetch_one(pool)
        .await
        .expect("session row must exist")
        .get("user_id");

    (token, user_id, email)
}

#[tokio::test]
async fn delete_account_without_token_returns_401() {
    let state = test_state().await;

    let (status, body) = request(api::app(state), "DELETE", "/api/account", None, None).await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, json!({ "error": "unauthorized" }));
}

/// Acceptance criterion: deleting the account cascades through `contacts`,
/// `user_keys`, and `sessions` -- verified directly against Postgres.
#[tokio::test]
async fn delete_account_cascades_contacts_keys_and_sessions() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (owner_token, owner_id, _owner_email) =
        signup_user(&pool, state.clone(), "delete-account-owner").await;
    let (_other_token, other_id, other_email) =
        signup_user(&pool, state.clone(), "delete-account-other").await;

    // Give the caller a contact row.
    let (add_status, _) = request(
        api::app(state.clone()),
        "POST",
        "/api/contacts",
        Some(&owner_token),
        Some(json!({ "email": other_email })),
    )
    .await;
    assert_eq!(add_status, StatusCode::CREATED);

    // Give the caller a user_keys row.
    let (keys_status, _) = request(
        api::app(state.clone()),
        "POST",
        "/api/keys",
        Some(&owner_token),
        Some(json!({
            "x25519_public_key_b64": base64_of(32),
            "kyber_public_key_b64": base64_of(1184),
            "dilithium_public_key_b64": base64_of(1952),
            "prekey_signature_b64": base64_of(3309),
        })),
    )
    .await;
    assert_eq!(keys_status, StatusCode::OK);

    // Sanity check: rows exist before deletion.
    let sessions_before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sessions WHERE user_id = $1")
            .bind(owner_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(sessions_before > 0);
    let contacts_before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM contacts WHERE owner_user_id = $1")
            .bind(owner_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(contacts_before, 1);
    let keys_before: i64 = sqlx::query_scalar("SELECT count(*) FROM user_keys WHERE user_id = $1")
        .bind(owner_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(keys_before, 1);

    let (status, body) = request(
        api::app(state.clone()),
        "DELETE",
        "/api/account",
        Some(&owner_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(body, Value::Null);

    let users_after: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE id = $1")
        .bind(owner_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(users_after, 0);

    let sessions_after: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sessions WHERE user_id = $1")
            .bind(owner_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(sessions_after, 0);

    let contacts_after: i64 =
        sqlx::query_scalar("SELECT count(*) FROM contacts WHERE owner_user_id = $1")
            .bind(owner_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(contacts_after, 0);

    let keys_after: i64 = sqlx::query_scalar("SELECT count(*) FROM user_keys WHERE user_id = $1")
        .bind(owner_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(keys_after, 0);

    // Deleting the account did not touch the other user.
    let other_exists: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE id = $1")
        .bind(other_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(other_exists, 1);

    // Session token is now invalid.
    let (status, body) = request(
        api::app(state),
        "DELETE",
        "/api/account",
        Some(&owner_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, json!({ "error": "unauthorized" }));
}

fn base64_of(len: usize) -> String {
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;
    BASE64.encode(vec![0u8; len])
}
