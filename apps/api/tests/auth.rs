//! Integration tests for `/signup`, `/login`, and the `AuthenticatedUser`
//! bearer-token extractor, against a real Postgres instance and the real
//! `better-auth` crate.
//!
//! Requires `DATABASE_URL` to point at a reachable Postgres (see
//! `docker-compose.yml` for local dev, or the `postgres:16` CI service).

use api::auth::{AppState, AuthenticatedUser};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::routing::get;
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

async fn test_app() -> Router {
    api::app(test_state().await)
}

fn unique_email(label: &str) -> String {
    format!("{label}-{}@example.com", Uuid::new_v4())
}

async fn post_json(app: Router, uri: &str, body: Value) -> (StatusCode, Value) {
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

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

#[tokio::test]
async fn signup_creates_user_and_session() {
    let pool = test_pool().await;
    let email = unique_email("signup-success");

    let (status, body) = post_json(
        test_app().await,
        "/signup",
        json!({ "email": email, "password": "correct-horse-battery" }),
    )
    .await;

    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["user"]["email"], email);
    let token = body["token"].as_str().expect("token present").to_string();
    assert!(!token.is_empty());

    // Response body never contains a password hash.
    assert!(body.get("password").is_none());
    assert!(body.get("password_hash").is_none());
    assert!(!body.to_string().contains("correct-horse-battery"));

    let session_row = sqlx::query("SELECT user_id FROM sessions WHERE token = $1")
        .bind(&token)
        .fetch_one(&pool)
        .await
        .expect("session row must exist");
    let user_id: Uuid = session_row.get("user_id");

    let user_row = sqlx::query("SELECT email, password_hash FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .expect("user row must exist");
    assert_eq!(user_row.get::<String, _>("email"), email);
    // issue #1's password_hash column is unused by this integration --
    // credentials live in the `accounts` table instead.
    assert!(user_row.get::<Option<String>, _>("password_hash").is_none());

    let account_row = sqlx::query(
        "SELECT password FROM accounts WHERE user_id = $1 AND provider_id = 'credential'",
    )
    .bind(user_id)
    .fetch_one(&pool)
    .await
    .expect("credential account row must exist");
    let password_hash: String = account_row.get("password");
    assert!(!password_hash.is_empty());
    assert_ne!(password_hash, "correct-horse-battery");
}

#[tokio::test]
async fn signup_duplicate_email_returns_409() {
    let email = unique_email("signup-dup");
    let payload = json!({ "email": email, "password": "correct-horse-battery" });

    let (first_status, _) = post_json(test_app().await, "/signup", payload.clone()).await;
    assert_eq!(first_status, StatusCode::CREATED);

    let (status, body) = post_json(test_app().await, "/signup", payload).await;

    assert_eq!(status, StatusCode::CONFLICT);
    assert!(body["error"].is_string());
}

#[tokio::test]
async fn signup_missing_email_returns_400() {
    let (status, body) = post_json(
        test_app().await,
        "/signup",
        json!({ "password": "correct-horse-battery" }),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].is_string());
}

#[tokio::test]
async fn signup_malformed_email_returns_400() {
    let (status, body) = post_json(
        test_app().await,
        "/signup",
        json!({ "email": "not-an-email", "password": "correct-horse-battery" }),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].is_string());
}

#[tokio::test]
async fn signup_empty_password_returns_400() {
    let email = unique_email("signup-empty-pw");

    let (status, body) = post_json(
        test_app().await,
        "/signup",
        json!({ "email": email, "password": "" }),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].is_string());
}

#[tokio::test]
async fn login_with_correct_credentials_returns_200_and_new_session() {
    let pool = test_pool().await;
    let email = unique_email("login-success");
    let password = "correct-horse-battery";

    let (_, signup_body) = post_json(
        test_app().await,
        "/signup",
        json!({ "email": email, "password": password }),
    )
    .await;
    let signup_token = signup_body["token"].as_str().unwrap().to_string();

    let (status, body) = post_json(
        test_app().await,
        "/login",
        json!({ "email": email, "password": password }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["user"]["email"], email);
    let login_token = body["token"].as_str().expect("token present").to_string();
    assert!(!login_token.is_empty());
    // Login issues its own session, distinct from the signup session.
    assert_ne!(login_token, signup_token);

    let session_count: i64 = sqlx::query("SELECT COUNT(*) AS count FROM sessions WHERE token = $1")
        .bind(&login_token)
        .fetch_one(&pool)
        .await
        .unwrap()
        .get("count");
    assert_eq!(session_count, 1);
}

#[tokio::test]
async fn login_with_wrong_password_returns_401() {
    let email = unique_email("login-wrong-pw");

    post_json(
        test_app().await,
        "/signup",
        json!({ "email": email, "password": "correct-horse-battery" }),
    )
    .await;

    let (status, body) = post_json(
        test_app().await,
        "/login",
        json!({ "email": email, "password": "totally-wrong-password" }),
    )
    .await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, json!({ "error": "invalid credentials" }));
}

#[tokio::test]
async fn login_with_unknown_email_returns_401_identical_to_wrong_password() {
    let email = unique_email("login-unknown");

    let (status, body) = post_json(
        test_app().await,
        "/login",
        json!({ "email": email, "password": "whatever-password" }),
    )
    .await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, json!({ "error": "invalid credentials" }));
}

fn protected_app(state: AppState) -> Router {
    async fn ping(user: AuthenticatedUser) -> String {
        format!("hello {}", user.user.email)
    }

    Router::new()
        .route("/protected/ping", get(ping))
        .with_state(state)
}

async fn test_state() -> AppState {
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
    AppState {
        auth,
        pool,
        registry: api::registry::ConnectionRegistry::new(),
    }
}

#[tokio::test]
async fn protected_route_without_token_returns_401() {
    let state = test_state().await;

    let response = protected_app(state)
        .oneshot(
            Request::builder()
                .uri("/protected/ping")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body, json!({ "error": "unauthorized" }));
}

#[tokio::test]
async fn protected_route_with_valid_token_returns_200() {
    let state = test_state().await;
    let email = unique_email("protected-route");

    let (_, signup_body) = post_json(
        api::app(state.clone()),
        "/signup",
        json!({ "email": email, "password": "correct-horse-battery" }),
    )
    .await;
    let token = signup_body["token"].as_str().unwrap().to_string();

    let response = protected_app(state)
        .oneshot(
            Request::builder()
                .uri("/protected/ping")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(&bytes[..], format!("hello {email}").as_bytes());
}

#[tokio::test]
async fn protected_route_with_invalid_token_returns_401() {
    let state = test_state().await;

    let response = protected_app(state)
        .oneshot(
            Request::builder()
                .uri("/protected/ping")
                .header("authorization", "Bearer not-a-real-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body, json!({ "error": "unauthorized" }));
}

#[tokio::test]
async fn protected_route_with_missing_bearer_prefix_returns_401() {
    let state = test_state().await;

    let response = protected_app(state)
        .oneshot(
            Request::builder()
                .uri("/protected/ping")
                .header("authorization", "not-a-bearer-header")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn protected_route_with_expired_token_returns_401() {
    let pool = test_pool().await;
    let state = test_state().await;
    let email = unique_email("protected-route-expired");

    let (_, signup_body) = post_json(
        api::app(state.clone()),
        "/signup",
        json!({ "email": email, "password": "correct-horse-battery" }),
    )
    .await;
    let token = signup_body["token"].as_str().unwrap().to_string();

    // Backdate the session's expiry so the token is now expired, without
    // going through a separate token-minting path.
    sqlx::query("UPDATE sessions SET expires_at = now() - interval '1 hour' WHERE token = $1")
        .bind(&token)
        .execute(&pool)
        .await
        .expect("failed to expire session for test");

    let response = protected_app(state)
        .oneshot(
            Request::builder()
                .uri("/protected/ping")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body, json!({ "error": "unauthorized" }));
}
