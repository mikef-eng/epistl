//! Integration tests for `POST /api/keys` and its effect on `GET
//! /api/contacts` (issue #35).
//!
//! Requires `DATABASE_URL` to point at a reachable Postgres (see
//! `docker-compose.yml` for local dev, or the `postgres:16` CI service).

use api::AppState;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
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

/// Deterministic filler bytes of a given length, distinguished by `seed` so
/// re-uploads produce different key material than the first upload.
fn filler_bytes(len: usize, seed: u8) -> Vec<u8> {
    (0..len).map(|i| seed.wrapping_add(i as u8)).collect()
}

fn valid_keys_payload(seed: u8) -> Value {
    json!({
        "x25519_public_key_b64": BASE64.encode(filler_bytes(32, seed)),
        "kyber_public_key_b64": BASE64.encode(filler_bytes(1184, seed)),
        "dilithium_public_key_b64": BASE64.encode(filler_bytes(1952, seed)),
        "prekey_signature_b64": BASE64.encode(filler_bytes(3309, seed)),
    })
}

#[tokio::test]
async fn upload_keys_success_returns_200_and_visible_via_contacts() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (uploader_token, uploader_id, uploader_email) =
        signup_user(&pool, state.clone(), "upload-success-uploader").await;
    let (owner_token, _owner_id, _owner_email) =
        signup_user(&pool, state.clone(), "upload-success-owner").await;

    let payload = valid_keys_payload(1);
    let (status, body) = request(
        api::app(state.clone()),
        "POST",
        "/api/keys",
        Some(&uploader_token),
        Some(payload.clone()),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "upload failed: {body:?}");
    assert_eq!(body["user_id"], uploader_id.to_string());
    assert!(body["updated_at"].is_string());

    // Owner adds the uploader as a contact, and should see the uploaded
    // keys via GET /api/contacts.
    let (add_status, _) = request(
        api::app(state.clone()),
        "POST",
        "/api/contacts",
        Some(&owner_token),
        Some(json!({ "email": uploader_email })),
    )
    .await;
    assert_eq!(add_status, StatusCode::CREATED);

    let (list_status, list_body) = request(
        api::app(state),
        "GET",
        "/api/contacts",
        Some(&owner_token),
        None,
    )
    .await;
    assert_eq!(list_status, StatusCode::OK);
    let contacts = list_body["contacts"].as_array().unwrap();
    assert_eq!(contacts.len(), 1);
    assert_eq!(contacts[0]["user_id"], uploader_id.to_string());
    assert_eq!(
        contacts[0]["x25519_public_key_b64"],
        payload["x25519_public_key_b64"]
    );
    assert_eq!(
        contacts[0]["kyber_public_key_b64"],
        payload["kyber_public_key_b64"]
    );
    assert_eq!(
        contacts[0]["dilithium_public_key_b64"],
        payload["dilithium_public_key_b64"]
    );
    assert_eq!(
        contacts[0]["prekey_signature_b64"],
        payload["prekey_signature_b64"]
    );
}

#[tokio::test]
async fn upload_keys_reupload_replaces_previous_values() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (uploader_token, uploader_id, _uploader_email) =
        signup_user(&pool, state.clone(), "upload-reupload-uploader").await;

    let first_payload = valid_keys_payload(1);
    let (first_status, _) = request(
        api::app(state.clone()),
        "POST",
        "/api/keys",
        Some(&uploader_token),
        Some(first_payload),
    )
    .await;
    assert_eq!(first_status, StatusCode::OK);

    let second_payload = valid_keys_payload(2);
    let (second_status, second_body) = request(
        api::app(state.clone()),
        "POST",
        "/api/keys",
        Some(&uploader_token),
        Some(second_payload.clone()),
    )
    .await;
    assert_eq!(second_status, StatusCode::OK);
    assert_eq!(second_body["user_id"], uploader_id.to_string());

    let row = sqlx::query(
        "SELECT x25519_public_key, kyber_public_key, dilithium_public_key, prekey_signature FROM user_keys WHERE user_id = $1",
    )
    .bind(uploader_id)
    .fetch_one(&pool)
    .await
    .expect("user_keys row must exist");

    assert_eq!(
        BASE64.encode(row.get::<Vec<u8>, _>("x25519_public_key")),
        second_payload["x25519_public_key_b64"].as_str().unwrap()
    );
    assert_eq!(
        BASE64.encode(row.get::<Vec<u8>, _>("kyber_public_key")),
        second_payload["kyber_public_key_b64"].as_str().unwrap()
    );
    assert_eq!(
        BASE64.encode(row.get::<Vec<u8>, _>("dilithium_public_key")),
        second_payload["dilithium_public_key_b64"].as_str().unwrap()
    );
    assert_eq!(
        BASE64.encode(row.get::<Vec<u8>, _>("prekey_signature")),
        second_payload["prekey_signature_b64"].as_str().unwrap()
    );
}

#[tokio::test]
async fn upload_keys_invalid_x25519_length_returns_400() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (token, _id, _email) = signup_user(&pool, state.clone(), "upload-bad-x25519").await;

    let mut payload = valid_keys_payload(1);
    payload["x25519_public_key_b64"] = json!(BASE64.encode(filler_bytes(31, 1)));

    let (status, body) = request(
        api::app(state),
        "POST",
        "/api/keys",
        Some(&token),
        Some(payload),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({ "error": "invalid_x25519_key" }));
}

#[tokio::test]
async fn upload_keys_invalid_kyber_length_returns_400() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (token, _id, _email) = signup_user(&pool, state.clone(), "upload-bad-kyber").await;

    let mut payload = valid_keys_payload(1);
    payload["kyber_public_key_b64"] = json!(BASE64.encode(filler_bytes(1183, 1)));

    let (status, body) = request(
        api::app(state),
        "POST",
        "/api/keys",
        Some(&token),
        Some(payload),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({ "error": "invalid_kyber_key" }));
}

#[tokio::test]
async fn upload_keys_invalid_dilithium_length_returns_400() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (token, _id, _email) = signup_user(&pool, state.clone(), "upload-bad-dilithium").await;

    let mut payload = valid_keys_payload(1);
    payload["dilithium_public_key_b64"] = json!(BASE64.encode(filler_bytes(1951, 1)));

    let (status, body) = request(
        api::app(state),
        "POST",
        "/api/keys",
        Some(&token),
        Some(payload),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({ "error": "invalid_dilithium_key" }));
}

#[tokio::test]
async fn upload_keys_invalid_prekey_signature_length_returns_400() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (token, _id, _email) = signup_user(&pool, state.clone(), "upload-bad-sig").await;

    let mut payload = valid_keys_payload(1);
    payload["prekey_signature_b64"] = json!(BASE64.encode(filler_bytes(3308, 1)));

    let (status, body) = request(
        api::app(state),
        "POST",
        "/api/keys",
        Some(&token),
        Some(payload),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({ "error": "invalid_prekey_signature" }));
}

#[tokio::test]
async fn upload_keys_missing_field_returns_400() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (token, _id, _email) = signup_user(&pool, state.clone(), "upload-missing-field").await;

    let mut payload = valid_keys_payload(1);
    payload
        .as_object_mut()
        .unwrap()
        .remove("dilithium_public_key_b64");

    let (status, body) = request(
        api::app(state),
        "POST",
        "/api/keys",
        Some(&token),
        Some(payload),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({ "error": "invalid_input" }));
}

#[tokio::test]
async fn upload_keys_non_base64_field_returns_400() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (token, _id, _email) = signup_user(&pool, state.clone(), "upload-non-b64").await;

    let mut payload = valid_keys_payload(1);
    payload["kyber_public_key_b64"] = json!("not valid base64!!!");

    let (status, body) = request(
        api::app(state),
        "POST",
        "/api/keys",
        Some(&token),
        Some(payload),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({ "error": "invalid_input" }));
}

#[tokio::test]
async fn upload_keys_without_token_returns_401() {
    let state = test_state().await;

    let (status, body) = request(
        api::app(state),
        "POST",
        "/api/keys",
        None,
        Some(valid_keys_payload(1)),
    )
    .await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, json!({ "error": "unauthorized" }));
}

#[tokio::test]
async fn list_contacts_with_no_uploaded_keys_shows_all_null() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (owner_token, _owner_id, _owner_email) =
        signup_user(&pool, state.clone(), "no-keys-owner").await;
    let (_contact_token, contact_id, contact_email) =
        signup_user(&pool, state.clone(), "no-keys-contact").await;

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
    assert_eq!(contacts[0]["x25519_public_key_b64"], Value::Null);
    assert_eq!(contacts[0]["kyber_public_key_b64"], Value::Null);
    assert_eq!(contacts[0]["dilithium_public_key_b64"], Value::Null);
    assert_eq!(contacts[0]["prekey_signature_b64"], Value::Null);
}
