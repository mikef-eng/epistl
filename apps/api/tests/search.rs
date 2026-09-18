//! Integration tests for `GET /api/users/search` (issue #99), against a
//! real Postgres instance and the real `better-auth`-backed
//! `AuthenticatedUser` extractor.
//!
//! Requires `DATABASE_URL`/`NATS_URL` to point at reachable services (see
//! `docker-compose.yml` for local dev, or the CI services).

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

/// Signs a fresh user up with a caller-chosen email (rather than a
/// randomly-labelled one), so tests can control prefixes precisely.
/// Returns `(token, user_id)`.
async fn signup_user_with_email(state: AppState, pool: &PgPool, email: &str) -> (String, Uuid) {
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

    (token, user_id)
}

/// A short (12 hex char) random tag for building test-unique email
/// prefixes. Shorter than a full hyphenated [`Uuid`] so emails built from
/// several of these plus surrounding text (e.g.
/// `other-contains-prefix-{seed}-not-at-start@example.com`) stay under the
/// local-part's 64-octet RFC limit, which `better-auth`'s email validation
/// enforces.
fn short_id() -> String {
    Uuid::new_v4().simple().to_string()[..12].to_string()
}

fn user_ids(body: &Value) -> Vec<String> {
    body["users"]
        .as_array()
        .expect("users must be an array")
        .iter()
        .map(|u| u["user_id"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn search_without_token_returns_401() {
    let state = test_state().await;

    let (status, _) = request(
        api::app(state),
        "GET",
        "/api/users/search?q=abc",
        None,
        None,
    )
    .await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn search_prefix_match_excludes_substring_only_matches() {
    let pool = test_pool().await;
    let state = test_state().await;
    let seed = short_id();

    let (caller_token, _caller_id) =
        signup_user_with_email(state.clone(), &pool, &format!("caller-{seed}@example.com")).await;
    let prefix_email = format!("prefix-{seed}-match@example.com");
    let (_prefix_token, prefix_id) =
        signup_user_with_email(state.clone(), &pool, &prefix_email).await;
    // Contains "prefix-{seed}" as a substring, but not as a prefix of the
    // email -- an ILIKE '<query>%' prefix match must not return this row.
    let substring_only_email = format!("other-contains-prefix-{seed}-not-at-start@example.com");
    signup_user_with_email(state.clone(), &pool, &substring_only_email).await;

    let query = format!("prefix-{seed}");
    let (status, body) = request(
        api::app(state),
        "GET",
        &format!("/api/users/search?q={query}"),
        Some(&caller_token),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let ids = user_ids(&body);
    assert_eq!(ids, vec![prefix_id.to_string()]);
}

#[tokio::test]
async fn search_excludes_callers_own_user() {
    let pool = test_pool().await;
    let state = test_state().await;
    let seed = short_id();

    let caller_email = format!("self-{seed}-caller@example.com");
    let (caller_token, caller_id) =
        signup_user_with_email(state.clone(), &pool, &caller_email).await;
    let other_email = format!("self-{seed}-other@example.com");
    let (_other_token, other_id) = signup_user_with_email(state.clone(), &pool, &other_email).await;

    let query = format!("self-{seed}");
    let (status, body) = request(
        api::app(state),
        "GET",
        &format!("/api/users/search?q={query}"),
        Some(&caller_token),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let ids = user_ids(&body);
    assert!(!ids.contains(&caller_id.to_string()));
    assert_eq!(ids, vec![other_id.to_string()]);
}

#[tokio::test]
async fn search_results_capped_at_limit_and_ordered_by_email() {
    let pool = test_pool().await;
    let state = test_state().await;
    let seed = short_id();

    let (caller_token, _caller_id) = signup_user_with_email(
        state.clone(),
        &pool,
        &format!("cap-caller-{seed}@example.com"),
    )
    .await;

    let matching_count = api::search::RESULT_LIMIT + 5;
    let mut expected_emails = Vec::new();
    for i in 0..matching_count {
        let email = format!("cap-{seed}-{i:03}@example.com");
        signup_user_with_email(state.clone(), &pool, &email).await;
        expected_emails.push(email);
    }
    expected_emails.sort();
    let expected_emails: Vec<String> = expected_emails
        .into_iter()
        .take(api::search::RESULT_LIMIT as usize)
        .collect();

    let query = format!("cap-{seed}");
    let (status, body) = request(
        api::app(state),
        "GET",
        &format!("/api/users/search?q={query}"),
        Some(&caller_token),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let emails: Vec<String> = body["users"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["email"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(emails.len(), api::search::RESULT_LIMIT as usize);
    assert_eq!(emails, expected_emails);
}

#[tokio::test]
async fn search_below_minimum_length_returns_empty_without_matching_existing_users() {
    let pool = test_pool().await;
    let state = test_state().await;
    let seed = short_id();

    let (caller_token, _caller_id) = signup_user_with_email(
        state.clone(),
        &pool,
        &format!("short-caller-{seed}@example.com"),
    )
    .await;
    // A user that a longer version of the same query would match, to prove
    // the short-circuit really does return empty rather than happening to
    // find nothing.
    signup_user_with_email(state.clone(), &pool, &format!("ab-{seed}@example.com")).await;

    let (status, body) = request(
        api::app(state.clone()),
        "GET",
        "/api/users/search?q=ab",
        Some(&caller_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "users": [] }));

    // Missing `q` entirely behaves the same way.
    let (status, body) = request(
        api::app(state),
        "GET",
        "/api/users/search",
        Some(&caller_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "users": [] }));
}

#[tokio::test]
async fn search_exceeding_rate_limit_returns_429() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (token, _user_id) = signup_user_with_email(
        state.clone(),
        &pool,
        &format!("rate-{}@example.com", short_id()),
    )
    .await;

    let mut last_status = StatusCode::IM_A_TEAPOT;
    for _ in 0..api::search::RATE_LIMIT_MAX_REQUESTS {
        let (status, _) = request(
            api::app(state.clone()),
            "GET",
            "/api/users/search?q=abc",
            Some(&token),
            None,
        )
        .await;
        last_status = status;
    }
    assert_eq!(
        last_status,
        StatusCode::OK,
        "requests within the budget should all succeed"
    );

    let (status, body) = request(
        api::app(state),
        "GET",
        "/api/users/search?q=abc",
        Some(&token),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body, json!({ "error": "rate_limited" }));
}
