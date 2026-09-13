//! Integration tests for `POST/GET /api/contacts/requests`, against a real
//! Postgres instance and the real `better-auth`-backed `AuthenticatedUser`
//! extractor.
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

async fn send_request(state: AppState, token: &str, target_email: &str) -> (StatusCode, Value) {
    request(
        api::app(state),
        "POST",
        "/api/contacts/requests",
        Some(token),
        Some(json!({ "email": target_email })),
    )
    .await
}

#[tokio::test]
async fn create_contact_request_success_returns_201() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (requester_token, requester_id, _requester_email) =
        signup_user(&pool, state.clone(), "create-success-requester").await;
    let (_recipient_token, recipient_id, recipient_email) =
        signup_user(&pool, state.clone(), "create-success-recipient").await;

    let (status, body) = send_request(state, &requester_token, &recipient_email).await;

    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["requester_user_id"], requester_id.to_string());
    assert_eq!(body["recipient_user_id"], recipient_id.to_string());
    assert_eq!(body["status"], "pending");
    assert!(body["id"].is_string());
    assert!(body["created_at"].is_string());
}

#[tokio::test]
async fn create_contact_request_already_pending_returns_409() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (requester_token, _requester_id, _requester_email) =
        signup_user(&pool, state.clone(), "already-pending-requester").await;
    let (_recipient_token, _recipient_id, recipient_email) =
        signup_user(&pool, state.clone(), "already-pending-recipient").await;

    let (first_status, _) = send_request(state.clone(), &requester_token, &recipient_email).await;
    assert_eq!(first_status, StatusCode::CREATED);

    let (status, body) = send_request(state, &requester_token, &recipient_email).await;

    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body, json!({ "error": "already_pending" }));
}

#[tokio::test]
async fn create_contact_request_already_contact_returns_409() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (requester_token, requester_id, _requester_email) =
        signup_user(&pool, state.clone(), "already-contact-requester").await;
    let (_recipient_token, recipient_id, recipient_email) =
        signup_user(&pool, state.clone(), "already-contact-recipient").await;

    sqlx::query("INSERT INTO contacts (owner_user_id, contact_user_id) VALUES ($1, $2), ($2, $1)")
        .bind(requester_id)
        .bind(recipient_id)
        .execute(&pool)
        .await
        .expect("failed to seed mutual contact rows");

    let (status, body) = send_request(state, &requester_token, &recipient_email).await;

    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body, json!({ "error": "already_contact" }));
}

/// Crossed request: B already has a pending request to A. A's attempt to
/// request B must surface B's existing request id, not silently create a
/// mutual relationship or a second, independent request row.
#[tokio::test]
async fn create_contact_request_crossed_returns_incoming_request_exists() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (a_token, a_id, a_email) = signup_user(&pool, state.clone(), "crossed-a").await;
    let (b_token, b_id, b_email) = signup_user(&pool, state.clone(), "crossed-b").await;

    // B requests A first.
    let (b_request_status, b_request_body) = send_request(state.clone(), &b_token, &a_email).await;
    assert_eq!(b_request_status, StatusCode::CREATED);
    let existing_request_id = b_request_body["id"].as_str().unwrap().to_string();

    // A now requests B -- should surface B's existing request instead of
    // creating a new row or a `contacts` row.
    let (status, body) = send_request(state, &a_token, &b_email).await;

    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        body,
        json!({ "error": "incoming_request_exists", "request_id": existing_request_id })
    );

    let contacts_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM contacts
         WHERE (owner_user_id = $1 AND contact_user_id = $2)
            OR (owner_user_id = $2 AND contact_user_id = $1)",
    )
    .bind(a_id)
    .bind(b_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(contacts_count, 0);

    let requests_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM contact_requests
         WHERE (requester_user_id = $1 AND recipient_user_id = $2)
            OR (requester_user_id = $2 AND recipient_user_id = $1)",
    )
    .bind(a_id)
    .bind(b_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(requests_count, 1, "no new request row should be created");
}

#[tokio::test]
async fn create_contact_request_self_returns_400() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (token, _id, email) = signup_user(&pool, state.clone(), "create-self").await;

    let (status, body) = send_request(state, &token, &email).await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({ "error": "cannot_add_self" }));
}

#[tokio::test]
async fn create_contact_request_nonexistent_email_returns_404() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (token, _id, _email) = signup_user(&pool, state.clone(), "create-missing").await;

    let (status, body) = send_request(state, &token, &unique_email("nobody")).await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, json!({ "error": "user_not_found" }));
}

#[tokio::test]
async fn create_contact_request_without_token_returns_401() {
    let state = test_state().await;

    let (status, body) = request(
        api::app(state),
        "POST",
        "/api/contacts/requests",
        None,
        Some(json!({ "email": "whoever@example.com" })),
    )
    .await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, json!({ "error": "unauthorized" }));
}

#[tokio::test]
async fn list_contact_requests_separates_incoming_and_outgoing() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (a_token, a_id, a_email) = signup_user(&pool, state.clone(), "list-a").await;
    let (b_token, b_id, b_email) = signup_user(&pool, state.clone(), "list-b").await;
    let (c_token, c_id, c_email) = signup_user(&pool, state.clone(), "list-c").await;

    // A -> B (outgoing for A, incoming for B).
    let (a_to_b_status, _) = send_request(state.clone(), &a_token, &b_email).await;
    assert_eq!(a_to_b_status, StatusCode::CREATED);

    // C -> A (incoming for A).
    let (c_to_a_status, _) = send_request(state.clone(), &c_token, &a_email).await;
    assert_eq!(c_to_a_status, StatusCode::CREATED);

    let (status, body) = request(
        api::app(state.clone()),
        "GET",
        "/api/contacts/requests",
        Some(&a_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let outgoing = body["outgoing"].as_array().unwrap();
    assert_eq!(outgoing.len(), 1);
    assert_eq!(outgoing[0]["user_id"], b_id.to_string());
    assert_eq!(outgoing[0]["email"], b_email);
    assert!(outgoing[0]["id"].is_string());
    assert!(outgoing[0]["created_at"].is_string());

    let incoming = body["incoming"].as_array().unwrap();
    assert_eq!(incoming.len(), 1);
    assert_eq!(incoming[0]["user_id"], c_id.to_string());
    assert_eq!(incoming[0]["email"], c_email);

    let (b_status, b_body) = request(
        api::app(state),
        "GET",
        "/api/contacts/requests",
        Some(&b_token),
        None,
    )
    .await;
    assert_eq!(b_status, StatusCode::OK);
    let b_incoming = b_body["incoming"].as_array().unwrap();
    assert_eq!(b_incoming.len(), 1);
    assert_eq!(b_incoming[0]["user_id"], a_id.to_string());
    assert_eq!(b_incoming[0]["email"], a_email);
    let b_outgoing = b_body["outgoing"].as_array().unwrap();
    assert_eq!(b_outgoing.len(), 0);
}

#[tokio::test]
async fn list_contact_requests_without_token_returns_401() {
    let state = test_state().await;

    let (status, body) =
        request(api::app(state), "GET", "/api/contacts/requests", None, None).await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, json!({ "error": "unauthorized" }));
}
