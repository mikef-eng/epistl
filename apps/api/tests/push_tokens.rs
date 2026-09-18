//! Integration tests for `POST /api/push-tokens` (issue #166).
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

fn unique_token(label: &str) -> String {
    format!("ExponentPushToken[{label}-{}]", Uuid::new_v4())
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
async fn register_push_token_first_time_succeeds_and_is_queryable() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (session_token, user_id, _email) =
        signup_user(&pool, state.clone(), "push-first-time").await;
    let push_token = unique_token("first-time");

    let (status, body) = request(
        api::app(state),
        "POST",
        "/api/push-tokens",
        Some(&session_token),
        Some(json!({ "token": push_token })),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "registration failed: {body:?}");
    assert_eq!(body["user_id"], user_id.to_string());
    assert!(body["id"].is_string());
    assert!(body["created_at"].is_string());

    let row = sqlx::query("SELECT user_id, token FROM push_tokens WHERE token = $1")
        .bind(&push_token)
        .fetch_one(&pool)
        .await
        .expect("push_tokens row must exist");
    assert_eq!(row.get::<Uuid, _>("user_id"), user_id);
    assert_eq!(row.get::<String, _>("token"), push_token);
}

#[tokio::test]
async fn register_push_token_same_user_reregister_is_idempotent() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (session_token, user_id, _email) =
        signup_user(&pool, state.clone(), "push-reregister-same").await;
    let push_token = unique_token("reregister-same");

    let (first_status, _) = request(
        api::app(state.clone()),
        "POST",
        "/api/push-tokens",
        Some(&session_token),
        Some(json!({ "token": push_token })),
    )
    .await;
    assert_eq!(first_status, StatusCode::OK);

    let (second_status, second_body) = request(
        api::app(state),
        "POST",
        "/api/push-tokens",
        Some(&session_token),
        Some(json!({ "token": push_token })),
    )
    .await;
    assert_eq!(second_status, StatusCode::OK, "{second_body:?}");
    assert_eq!(second_body["user_id"], user_id.to_string());

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM push_tokens WHERE token = $1")
        .bind(&push_token)
        .fetch_one(&pool)
        .await
        .expect("count query must succeed");
    assert_eq!(
        count, 1,
        "re-registering the same token must not duplicate rows"
    );
}

#[tokio::test]
async fn register_push_token_different_user_reassigns_row() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (first_session_token, _first_user_id, _first_email) =
        signup_user(&pool, state.clone(), "push-reassign-first").await;
    let (second_session_token, second_user_id, _second_email) =
        signup_user(&pool, state.clone(), "push-reassign-second").await;
    let push_token = unique_token("reassign");

    let (first_status, _) = request(
        api::app(state.clone()),
        "POST",
        "/api/push-tokens",
        Some(&first_session_token),
        Some(json!({ "token": push_token })),
    )
    .await;
    assert_eq!(first_status, StatusCode::OK);

    let (second_status, second_body) = request(
        api::app(state),
        "POST",
        "/api/push-tokens",
        Some(&second_session_token),
        Some(json!({ "token": push_token })),
    )
    .await;
    assert_eq!(second_status, StatusCode::OK, "{second_body:?}");
    assert_eq!(second_body["user_id"], second_user_id.to_string());

    let rows = sqlx::query("SELECT user_id FROM push_tokens WHERE token = $1")
        .bind(&push_token)
        .fetch_all(&pool)
        .await
        .expect("query must succeed");
    assert_eq!(
        rows.len(),
        1,
        "reassigning a token to a different user must not leave two rows"
    );
    assert_eq!(rows[0].get::<Uuid, _>("user_id"), second_user_id);
}

#[tokio::test]
async fn register_push_token_missing_token_returns_400() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (session_token, _user_id, _email) =
        signup_user(&pool, state.clone(), "push-missing-token").await;

    let (status, body) = request(
        api::app(state),
        "POST",
        "/api/push-tokens",
        Some(&session_token),
        Some(json!({})),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({ "error": "invalid_input" }));
}

#[tokio::test]
async fn register_push_token_empty_token_returns_400() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (session_token, _user_id, _email) =
        signup_user(&pool, state.clone(), "push-empty-token").await;

    let (status, body) = request(
        api::app(state),
        "POST",
        "/api/push-tokens",
        Some(&session_token),
        Some(json!({ "token": "" })),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({ "error": "invalid_input" }));
}

#[tokio::test]
async fn register_push_token_without_session_returns_401() {
    let state = test_state().await;

    let (status, body) = request(
        api::app(state),
        "POST",
        "/api/push-tokens",
        None,
        Some(json!({ "token": unique_token("no-session") })),
    )
    .await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, json!({ "error": "unauthorized" }));
}
