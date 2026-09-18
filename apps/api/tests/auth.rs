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

async fn test_app() -> Router {
    api::app(test_state().await)
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
    // Mixed-case on purpose, truncated to Better Auth's 30-char max, to
    // exercise its own `normalize_username` (lowercasing) end to end.
    let mut raw_username = format!("SignupSuccess_{}", Uuid::new_v4().simple());
    raw_username.truncate(30);
    assert_ne!(raw_username, raw_username.to_lowercase());

    let (status, body) = post_json(
        test_app().await,
        "/signup",
        json!({ "email": email, "password": "correct-horse-battery", "username": raw_username }),
    )
    .await;

    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["user"]["email"], email);
    // The response's persisted username is Better Auth's own normalized
    // (lowercased) form, regardless of the casing sent in the request.
    assert_eq!(body["user"]["username"], raw_username.to_lowercase());
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

    let user_row = sqlx::query("SELECT email, username, password_hash FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .expect("user row must exist");
    assert_eq!(user_row.get::<String, _>("email"), email);
    assert_eq!(
        user_row.get::<String, _>("username"),
        raw_username.to_lowercase()
    );
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
    // Regression test (issue #183): unaffected by the new username
    // handling. Uses a *different* username for the second attempt so this
    // is unambiguously exercising the email-conflict path (distinct from
    // the username-conflict path covered by
    // `signup_duplicate_username_returns_409` below), now that every
    // signup request carries a username.
    let email = unique_email("signup-dup");

    let (first_status, _) = post_json(
        test_app().await,
        "/signup",
        json!({ "email": email, "password": "correct-horse-battery", "username": unique_username("dup-email-first") }),
    )
    .await;
    assert_eq!(first_status, StatusCode::CREATED);

    let (status, body) = post_json(
        test_app().await,
        "/signup",
        json!({ "email": email, "password": "correct-horse-battery", "username": unique_username("dup-email-second") }),
    )
    .await;

    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body, json!({ "error": "email already registered" }));
}

#[tokio::test]
async fn signup_duplicate_username_returns_409_and_email_stays_available() {
    let username = unique_username("dup-username");
    let first_email = unique_email("signup-dup-username-first");
    let second_email = unique_email("signup-dup-username-second");

    let (first_status, _) = post_json(
        test_app().await,
        "/signup",
        json!({ "email": first_email, "password": "correct-horse-battery", "username": username }),
    )
    .await;
    assert_eq!(first_status, StatusCode::CREATED);

    let (status, body) = post_json(
        test_app().await,
        "/signup",
        json!({ "email": second_email, "password": "correct-horse-battery", "username": username }),
    )
    .await;

    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body, json!({ "error": "username already taken" }));

    // The pre-check runs before any user row is created, so the rejected
    // attempt's email was never registered -- it's immediately reusable
    // with a fresh username.
    let (retry_status, retry_body) = post_json(
        test_app().await,
        "/signup",
        json!({ "email": second_email, "password": "correct-horse-battery", "username": unique_username("dup-username-retry") }),
    )
    .await;
    assert_eq!(
        retry_status,
        StatusCode::CREATED,
        "second_email should still be unregistered: {retry_body:?}"
    );
}

#[tokio::test]
async fn signup_missing_username_returns_400() {
    let (status, body) = post_json(
        test_app().await,
        "/signup",
        json!({ "email": unique_email("signup-missing-username"), "password": "correct-horse-battery" }),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({ "error": "username required" }));
}

#[tokio::test]
async fn signup_empty_username_returns_400() {
    let (status, body) = post_json(
        test_app().await,
        "/signup",
        json!({ "email": unique_email("signup-empty-username"), "password": "correct-horse-battery", "username": "" }),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({ "error": "username required" }));
}

#[tokio::test]
async fn signup_invalid_username_format_returns_400() {
    // Better Auth's own `validate_username`: 3-30 chars, `[a-zA-Z0-9_.]`.
    // Exercise each rejection reason -- a space, an out-of-alphabet
    // character, too short, and too long -- without reimplementing the
    // rule ourselves.
    let cases = ["has space", "has-hyphen", "ab", &"a".repeat(31)];

    for username in cases {
        let (status, body) = post_json(
            test_app().await,
            "/signup",
            json!({
                "email": unique_email("signup-invalid-username"),
                "password": "correct-horse-battery",
                "username": username,
            }),
        )
        .await;

        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "username {username:?} should have been rejected, got body {body:?}"
        );
    }
}

#[tokio::test]
async fn signup_missing_email_returns_400() {
    let (status, body) = post_json(
        test_app().await,
        "/signup",
        json!({ "password": "correct-horse-battery", "username": unique_username("signup-missing-email") }),
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
        json!({ "email": "not-an-email", "password": "correct-horse-battery", "username": unique_username("signup-malformed-email") }),
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
        json!({ "email": email, "password": "", "username": unique_username("signup-empty-pw") }),
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
        json!({ "email": email, "password": password, "username": unique_username("login-success") }),
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
        json!({ "email": email, "password": "correct-horse-battery", "username": unique_username("login-wrong-pw") }),
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
        json!({ "email": email, "password": "correct-horse-battery", "username": unique_username("protected-route") }),
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
        json!({ "email": email, "password": "correct-horse-battery", "username": unique_username("protected-route-expired") }),
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
