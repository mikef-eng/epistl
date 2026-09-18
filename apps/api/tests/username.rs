//! Integration tests for `PATCH /api/username` (issue #184).
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
        push_notifier: std::sync::Arc::new(api::push::ExpoPushNotifier::new()),
        avatar_store: api::avatars::AvatarStore::from_env()
            .expect("failed to build AvatarStore for test"),
    }
}

fn unique_email(label: &str) -> String {
    format!("{label}-{}@example.com", Uuid::new_v4())
}

/// A username satisfying Better Auth's own `validate_username` (3-30 chars,
/// `[a-zA-Z0-9_.]`), unique per call.
fn unique_username(label: &str) -> String {
    let sanitized: String = label
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let mut username = format!("{sanitized}_{}", Uuid::new_v4().simple()).to_lowercase();
    username.truncate(30);
    username
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
    let username = unique_username(label);
    let (status, body) = request(
        api::app(state),
        "POST",
        "/signup",
        None,
        Some(json!({ "email": email, "password": "correct-horse-battery", "username": username })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "signup failed: {body:?}");
    let session_token = body["token"].as_str().unwrap().to_string();

    let user_id: Uuid = sqlx::query("SELECT user_id FROM sessions WHERE token = $1")
        .bind(&session_token)
        .fetch_one(pool)
        .await
        .expect("session row must exist")
        .get("user_id");

    (session_token, user_id, email)
}

#[tokio::test]
async fn change_username_succeeds_and_persists() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (session_token, user_id, _email) = signup_user(&pool, state.clone(), "un-ok").await;
    let new_username = unique_username("un-new");

    let (status, body) = request(
        api::app(state),
        "PATCH",
        "/api/username",
        Some(&session_token),
        Some(json!({ "username": new_username })),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "change failed: {body:?}");
    assert_eq!(body["username"], new_username);

    let persisted: String = sqlx::query_scalar("SELECT username FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .expect("user row must exist");
    assert_eq!(persisted, new_username);
}

#[tokio::test]
async fn change_username_normalizes_to_lowercase() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (session_token, user_id, _email) = signup_user(&pool, state.clone(), "un-mixed").await;
    let new_username = unique_username("un-mixed-new");
    let mixed_case = new_username.to_uppercase();

    let (status, body) = request(
        api::app(state),
        "PATCH",
        "/api/username",
        Some(&session_token),
        Some(json!({ "username": mixed_case })),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "change failed: {body:?}");
    assert_eq!(
        body["username"], new_username,
        "response should reflect the lowercase-normalized username"
    );

    let persisted: String = sqlx::query_scalar("SELECT username FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .expect("user row must exist");
    assert_eq!(
        persisted, new_username,
        "stored username should be lowercase-normalized"
    );
}

#[tokio::test]
async fn change_username_case_variant_of_another_users_username_returns_409() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (_first_token, first_user_id, _first_email) =
        signup_user(&pool, state.clone(), "un-case-taken-a").await;
    let (second_token, _second_user_id, _second_email) =
        signup_user(&pool, state.clone(), "un-case-taken-b").await;

    let first_username: String = sqlx::query_scalar("SELECT username FROM users WHERE id = $1")
        .bind(first_user_id)
        .fetch_one(&pool)
        .await
        .expect("user row must exist");
    let uppercased = first_username.to_uppercase();

    let (status, body) = request(
        api::app(state),
        "PATCH",
        "/api/username",
        Some(&second_token),
        Some(json!({ "username": uppercased })),
    )
    .await;

    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "a case-variant of an existing username should still conflict: {body:?}"
    );
    assert_eq!(body, json!({ "error": "username already taken" }));
}

#[tokio::test]
async fn change_username_to_own_current_value_is_a_noop_success() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (session_token, user_id, _email) = signup_user(&pool, state.clone(), "un-noop").await;

    let current_username: String = sqlx::query_scalar("SELECT username FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .expect("user row must exist");

    let (status, body) = request(
        api::app(state),
        "PATCH",
        "/api/username",
        Some(&session_token),
        Some(json!({ "username": current_username })),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "no-op change failed: {body:?}");
    assert_eq!(body["username"], current_username);
}

#[tokio::test]
async fn change_username_to_another_users_username_returns_409() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (_first_token, _first_user_id, _first_email) =
        signup_user(&pool, state.clone(), "un-taken-a").await;
    let (second_token, _second_user_id, _second_email) =
        signup_user(&pool, state.clone(), "un-taken-b").await;

    let first_username: String = sqlx::query_scalar("SELECT username FROM users WHERE id = $1")
        .bind(_first_user_id)
        .fetch_one(&pool)
        .await
        .expect("user row must exist");

    let (status, body) = request(
        api::app(state),
        "PATCH",
        "/api/username",
        Some(&second_token),
        Some(json!({ "username": first_username })),
    )
    .await;

    assert_eq!(status, StatusCode::CONFLICT, "{body:?}");
    assert_eq!(body, json!({ "error": "username already taken" }));
}

#[tokio::test]
async fn change_username_invalid_format_returns_400() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (session_token, _user_id, _email) = signup_user(&pool, state.clone(), "un-invalid").await;

    // Too short, and contains a character outside `[a-zA-Z0-9_]`.
    for invalid in ["ab", "has space", "has-dash", "a".repeat(33).as_str(), ""] {
        let (status, body) = request(
            api::app(state.clone()),
            "PATCH",
            "/api/username",
            Some(&session_token),
            Some(json!({ "username": invalid })),
        )
        .await;

        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "input {invalid:?}: {body:?}"
        );
        assert_eq!(body, json!({ "error": "invalid_username" }));
    }
}

#[tokio::test]
async fn change_username_missing_field_returns_400() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (session_token, _user_id, _email) = signup_user(&pool, state.clone(), "un-missing").await;

    let (status, body) = request(
        api::app(state),
        "PATCH",
        "/api/username",
        Some(&session_token),
        Some(json!({})),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({ "error": "invalid_username" }));
}

#[tokio::test]
async fn change_username_without_session_returns_401() {
    let state = test_state().await;

    let (status, body) = request(
        api::app(state),
        "PATCH",
        "/api/username",
        None,
        Some(json!({ "username": unique_username("un-no-session") })),
    )
    .await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, json!({ "error": "unauthorized" }));
}
