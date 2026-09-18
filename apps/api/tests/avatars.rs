//! Integration tests for `POST /api/avatar/upload-url`,
//! `POST /api/avatar/confirm`, and `GET /api/avatar/{user_id}` (issue
//! #189).
//!
//! Requires `DATABASE_URL` to point at a reachable Postgres, `NATS_URL` to
//! point at a reachable NATS server, and the `SEAWEEDFS_*`/
//! `AVATAR_BUCKET_NAME` env vars to point at a reachable SeaweedFS S3
//! gateway (see `docker-compose.yml`'s `seaweedfs` service) -- these tests
//! exercise a real presigned PUT/GET round trip against it with a plain
//! `reqwest::Client`, the same way this crate's existing integration tests
//! use a real Postgres rather than a mock.

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

/// Same as [`request`], but returns the raw response instead of decoding a
/// JSON body -- used for the `GET /api/avatar/{user_id}` 302 case, whose
/// body is empty and whose `Location` header is what matters.
async fn request_raw(
    app: Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
) -> axum::response::Response {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    app.oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap()
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

/// PUTs `bytes` directly to `upload_url` with the given `content_type` --
/// exactly what the mobile client would do against the presigned URL
/// returned by `POST /api/avatar/upload-url`. Uses a plain `reqwest`
/// client, not the axum test app, since the PUT goes straight to
/// SeaweedFS.
async fn put_bytes(upload_url: &str, content_type: &str, bytes: Vec<u8>) -> StatusCode {
    let http = reqwest::Client::new();
    let response = http
        .put(upload_url)
        .header("content-type", content_type)
        .body(bytes)
        .send()
        .await
        .expect("PUT to presigned upload URL failed");
    StatusCode::from_u16(response.status().as_u16()).unwrap()
}

/// GETs `url` directly (e.g. the `Location` from a `302`) with a plain
/// `reqwest` client, returning `(status, content_type, bytes)`.
async fn get_bytes(url: &str) -> (StatusCode, Option<String>, Vec<u8>) {
    let http = reqwest::Client::new();
    let response = http
        .get(url)
        .send()
        .await
        .expect("GET to presigned URL failed");
    let status = StatusCode::from_u16(response.status().as_u16()).unwrap();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let bytes = response.bytes().await.unwrap().to_vec();
    (status, content_type, bytes)
}

/// Full happy-path upload flow: requests an upload URL, PUTs `bytes`, and
/// confirms. Returns the confirm response's `(status, body)`.
async fn upload_avatar(
    state: AppState,
    session_token: &str,
    content_type: &str,
    bytes: Vec<u8>,
) -> (StatusCode, Value) {
    let (status, body) = request(
        api::app(state.clone()),
        "POST",
        "/api/avatar/upload-url",
        Some(session_token),
        Some(json!({ "contentType": content_type })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "upload-url failed: {body:?}");
    let upload_url = body["uploadUrl"].as_str().unwrap().to_string();

    let put_status = put_bytes(&upload_url, content_type, bytes).await;
    assert!(
        put_status.is_success(),
        "PUT to presigned URL failed with {put_status}"
    );

    request(
        api::app(state),
        "POST",
        "/api/avatar/confirm",
        Some(session_token),
        None,
    )
    .await
}

#[tokio::test]
async fn upload_url_returns_a_url_a_plain_http_client_can_put_to() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (session_token, _user_id, _email) =
        signup_user(&pool, state.clone(), "avatar-upload-url").await;

    let (status, body) = request(
        api::app(state),
        "POST",
        "/api/avatar/upload-url",
        Some(&session_token),
        Some(json!({ "contentType": "image/png" })),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "{body:?}");
    assert_eq!(body["contentType"], "image/png");
    let upload_url = body["uploadUrl"]
        .as_str()
        .expect("uploadUrl must be a string");

    let put_status = put_bytes(upload_url, "image/png", vec![1, 2, 3, 4]).await;
    assert!(
        put_status.is_success(),
        "expected the presigned PUT to succeed, got {put_status}"
    );
}

#[tokio::test]
async fn upload_url_rejects_invalid_content_type() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (session_token, _user_id, _email) =
        signup_user(&pool, state.clone(), "avatar-invalid-content-type").await;

    let (status, body) = request(
        api::app(state),
        "POST",
        "/api/avatar/upload-url",
        Some(&session_token),
        Some(json!({ "contentType": "text/plain" })),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({ "error": "invalid_content_type" }));
}

#[tokio::test]
async fn confirm_after_real_upload_updates_users_image_and_returns_serving_path() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (session_token, user_id, _email) =
        signup_user(&pool, state.clone(), "avatar-confirm-happy-path").await;

    let (status, body) =
        upload_avatar(state.clone(), &session_token, "image/png", vec![1, 2, 3, 4]).await;

    let expected_path = format!("/api/avatar/{user_id}");
    assert_eq!(status, StatusCode::OK, "{body:?}");
    assert_eq!(body["image"], expected_path);

    let stored_image: Option<String> = sqlx::query("SELECT image FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .expect("user row must exist")
        .get("image");
    assert_eq!(stored_image, Some(expected_path));
}

#[tokio::test]
async fn confirm_with_no_prior_upload_returns_404_and_does_not_touch_users_image() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (session_token, user_id, _email) =
        signup_user(&pool, state.clone(), "avatar-confirm-no-upload").await;

    let (status, body) = request(
        api::app(state),
        "POST",
        "/api/avatar/confirm",
        Some(&session_token),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, json!({ "error": "not_found" }));

    let stored_image: Option<String> = sqlx::query("SELECT image FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .expect("user row must exist")
        .get("image");
    assert_eq!(stored_image, None);
}

#[tokio::test]
async fn confirm_rejects_an_oversized_object_and_deletes_it() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (session_token, user_id, _email) =
        signup_user(&pool, state.clone(), "avatar-confirm-too-large").await;

    // One byte over the 5 MiB cap.
    let oversized = vec![0u8; 5 * 1024 * 1024 + 1];
    let (status, body) = upload_avatar(state.clone(), &session_token, "image/png", oversized).await;

    assert_eq!(status, StatusCode::BAD_REQUEST, "{body:?}");
    assert_eq!(body, json!({ "error": "file_too_large" }));

    let stored_image: Option<String> = sqlx::query("SELECT image FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .expect("user row must exist")
        .get("image");
    assert_eq!(stored_image, None);

    // The oversized object must have been deleted -- confirming again
    // (with nothing re-uploaded) must report `not_found`, not a stale
    // oversized object still sitting in the bucket.
    let (second_status, second_body) = request(
        api::app(state),
        "POST",
        "/api/avatar/confirm",
        Some(&session_token),
        None,
    )
    .await;
    assert_eq!(second_status, StatusCode::NOT_FOUND, "{second_body:?}");
}

#[tokio::test]
async fn reuploading_overwrites_the_previous_avatar() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (session_token, user_id, _email) =
        signup_user(&pool, state.clone(), "avatar-reupload-overwrite").await;

    let (first_status, _first_body) =
        upload_avatar(state.clone(), &session_token, "image/png", vec![1, 1, 1, 1]).await;
    assert_eq!(first_status, StatusCode::OK);

    let (second_status, second_body) = upload_avatar(
        state.clone(),
        &session_token,
        "image/jpeg",
        vec![2, 2, 2, 2, 2],
    )
    .await;
    assert_eq!(second_status, StatusCode::OK, "{second_body:?}");

    let get_response = request_raw(
        api::app(state),
        "GET",
        &format!("/api/avatar/{user_id}"),
        Some(&session_token),
    )
    .await;
    assert_eq!(get_response.status(), StatusCode::FOUND);
    let location = get_response
        .headers()
        .get("location")
        .expect("302 must set Location")
        .to_str()
        .unwrap()
        .to_string();

    let (status, content_type, bytes) = get_bytes(&location).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content_type.as_deref(), Some("image/jpeg"));
    assert_eq!(bytes, vec![2, 2, 2, 2, 2]);
}

#[tokio::test]
async fn get_avatar_for_user_with_no_avatar_returns_404() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (session_token, target_user_id, _email) =
        signup_user(&pool, state.clone(), "avatar-get-no-avatar-target").await;

    let (status, body) = request(
        api::app(state),
        "GET",
        &format!("/api/avatar/{target_user_id}"),
        Some(&session_token),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, json!({ "error": "not_found" }));
}

#[tokio::test]
async fn get_avatar_redirects_to_a_working_presigned_get_url_for_any_authenticated_caller() {
    let pool = test_pool().await;
    let state = test_state().await;
    let (owner_token, owner_id, _owner_email) =
        signup_user(&pool, state.clone(), "avatar-get-owner").await;
    let (viewer_token, _viewer_id, _viewer_email) =
        signup_user(&pool, state.clone(), "avatar-get-viewer").await;

    let (confirm_status, confirm_body) =
        upload_avatar(state.clone(), &owner_token, "image/png", vec![9, 8, 7, 6]).await;
    assert_eq!(confirm_status, StatusCode::OK, "{confirm_body:?}");

    // Any authenticated user -- not just the owner -- can fetch the
    // avatar, since avatars are not private data.
    let get_response = request_raw(
        api::app(state),
        "GET",
        &format!("/api/avatar/{owner_id}"),
        Some(&viewer_token),
    )
    .await;
    assert_eq!(get_response.status(), StatusCode::FOUND);
    let location = get_response
        .headers()
        .get("location")
        .expect("302 must set Location")
        .to_str()
        .unwrap()
        .to_string();

    let (status, content_type, bytes) = get_bytes(&location).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content_type.as_deref(), Some("image/png"));
    assert_eq!(bytes, vec![9, 8, 7, 6]);
}

#[tokio::test]
async fn upload_url_without_session_returns_401() {
    let state = test_state().await;

    let (status, body) = request(
        api::app(state),
        "POST",
        "/api/avatar/upload-url",
        None,
        Some(json!({ "contentType": "image/png" })),
    )
    .await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, json!({ "error": "unauthorized" }));
}

#[tokio::test]
async fn confirm_without_session_returns_401() {
    let state = test_state().await;

    let (status, body) = request(api::app(state), "POST", "/api/avatar/confirm", None, None).await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, json!({ "error": "unauthorized" }));
}

#[tokio::test]
async fn get_avatar_without_session_returns_401() {
    let state = test_state().await;
    let user_id = Uuid::new_v4();

    let (status, body) = request(
        api::app(state),
        "GET",
        &format!("/api/avatar/{user_id}"),
        None,
        None,
    )
    .await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, json!({ "error": "unauthorized" }));
}
