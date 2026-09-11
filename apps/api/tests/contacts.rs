//! Integration tests for `GET/POST /api/contacts` and
//! `DELETE /api/contacts/{user_id}`, against a real Postgres instance and
//! the real `better-auth`-backed `AuthenticatedUser` extractor.
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
    AppState { auth, pool }
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
async fn list_contacts_empty_returns_empty_array() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (token, _user_id, _email) = signup_user(&pool, state.clone(), "list-empty").await;

    let (status, body) = request(api::app(state), "GET", "/api/contacts", Some(&token), None).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "contacts": [] }));
}

#[tokio::test]
async fn add_contact_success_returns_201() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (owner_token, _owner_id, _owner_email) =
        signup_user(&pool, state.clone(), "add-success-owner").await;
    let (_contact_token, contact_id, contact_email) =
        signup_user(&pool, state.clone(), "add-success-contact").await;

    let (status, body) = request(
        api::app(state),
        "POST",
        "/api/contacts",
        Some(&owner_token),
        Some(json!({ "email": contact_email })),
    )
    .await;

    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["user_id"], contact_id.to_string());
    assert_eq!(body["email"], contact_email);
    assert!(body["added_at"].is_string());
}

#[tokio::test]
async fn add_contact_reflects_in_list() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (owner_token, _owner_id, _owner_email) =
        signup_user(&pool, state.clone(), "add-list-owner").await;
    let (_contact_token, contact_id, contact_email) =
        signup_user(&pool, state.clone(), "add-list-contact").await;

    let (add_status, _) = request(
        api::app(state.clone()),
        "POST",
        "/api/contacts",
        Some(&owner_token),
        Some(json!({ "email": contact_email })),
    )
    .await;
    assert_eq!(add_status, StatusCode::CREATED);

    let (status, body) = request(
        api::app(state),
        "GET",
        "/api/contacts",
        Some(&owner_token),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let contacts = body["contacts"].as_array().unwrap();
    assert_eq!(contacts.len(), 1);
    assert_eq!(contacts[0]["user_id"], contact_id.to_string());
    assert_eq!(contacts[0]["email"], contact_email);
    assert!(contacts[0]["added_at"].is_string());
}

#[tokio::test]
async fn add_contact_duplicate_returns_409() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (owner_token, _owner_id, _owner_email) =
        signup_user(&pool, state.clone(), "add-dup-owner").await;
    let (_contact_token, _contact_id, contact_email) =
        signup_user(&pool, state.clone(), "add-dup-contact").await;

    let (first_status, _) = request(
        api::app(state.clone()),
        "POST",
        "/api/contacts",
        Some(&owner_token),
        Some(json!({ "email": contact_email })),
    )
    .await;
    assert_eq!(first_status, StatusCode::CREATED);

    let (status, body) = request(
        api::app(state),
        "POST",
        "/api/contacts",
        Some(&owner_token),
        Some(json!({ "email": contact_email })),
    )
    .await;

    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body, json!({ "error": "already_added" }));
}

#[tokio::test]
async fn add_contact_self_returns_400() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (owner_token, _owner_id, owner_email) =
        signup_user(&pool, state.clone(), "add-self-owner").await;

    let (status, body) = request(
        api::app(state),
        "POST",
        "/api/contacts",
        Some(&owner_token),
        Some(json!({ "email": owner_email })),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({ "error": "cannot_add_self" }));
}

#[tokio::test]
async fn add_contact_nonexistent_email_returns_404() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (owner_token, _owner_id, _owner_email) =
        signup_user(&pool, state.clone(), "add-missing-owner").await;

    let (status, body) = request(
        api::app(state),
        "POST",
        "/api/contacts",
        Some(&owner_token),
        Some(json!({ "email": unique_email("nobody") })),
    )
    .await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, json!({ "error": "user_not_found" }));
}

#[tokio::test]
async fn delete_contact_success_returns_204() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (owner_token, _owner_id, _owner_email) =
        signup_user(&pool, state.clone(), "delete-success-owner").await;
    let (_contact_token, contact_id, contact_email) =
        signup_user(&pool, state.clone(), "delete-success-contact").await;

    let (add_status, _) = request(
        api::app(state.clone()),
        "POST",
        "/api/contacts",
        Some(&owner_token),
        Some(json!({ "email": contact_email })),
    )
    .await;
    assert_eq!(add_status, StatusCode::CREATED);

    let (status, body) = request(
        api::app(state.clone()),
        "DELETE",
        &format!("/api/contacts/{contact_id}"),
        Some(&owner_token),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(body, Value::Null);

    let (list_status, list_body) = request(
        api::app(state),
        "GET",
        "/api/contacts",
        Some(&owner_token),
        None,
    )
    .await;
    assert_eq!(list_status, StatusCode::OK);
    assert_eq!(list_body, json!({ "contacts": [] }));
}

#[tokio::test]
async fn delete_contact_nonexistent_returns_404() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (owner_token, _owner_id, _owner_email) =
        signup_user(&pool, state.clone(), "delete-missing-owner").await;

    let (status, body) = request(
        api::app(state),
        "DELETE",
        &format!("/api/contacts/{}", Uuid::new_v4()),
        Some(&owner_token),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, json!({ "error": "not_found" }));
}

#[tokio::test]
async fn list_contacts_without_token_returns_401() {
    let state = test_state().await;

    let (status, body) = request(api::app(state), "GET", "/api/contacts", None, None).await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, json!({ "error": "unauthorized" }));
}

#[tokio::test]
async fn add_contact_without_token_returns_401() {
    let state = test_state().await;

    let (status, body) = request(
        api::app(state),
        "POST",
        "/api/contacts",
        None,
        Some(json!({ "email": "whoever@example.com" })),
    )
    .await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, json!({ "error": "unauthorized" }));
}

#[tokio::test]
async fn delete_contact_without_token_returns_401() {
    let state = test_state().await;

    let (status, body) = request(
        api::app(state),
        "DELETE",
        &format!("/api/contacts/{}", Uuid::new_v4()),
        None,
        None,
    )
    .await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, json!({ "error": "unauthorized" }));
}
