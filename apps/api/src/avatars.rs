//! `POST /api/avatar/upload-url`, `POST /api/avatar/confirm`, and
//! `GET /api/avatar/{user_id}` -- lets an authenticated user upload an
//! avatar image and any authenticated user fetch another user's avatar,
//! using **presigned SeaweedFS S3-gateway URLs** for the actual byte
//! transfer rather than proxying bytes through this API. Only an object
//! reference (this API's own `/api/avatar/{user_id}` serving path) is ever
//! stored in Postgres (`users.image`) -- never image bytes, never a raw
//! SeaweedFS/S3 URL. See
//! `docs/decisions/0018-seaweedfs-object-storage-for-avatars.md` for the
//! full design rationale, and issue #188 for the `seaweedfs`
//! docker-compose service and its env vars this module reads.
//!
//! **S3-compatible client: `aws-sdk-s3` (pinned to `1.148.0`, the version
//! resolved at implementation time via `cargo add aws-sdk-s3`).** This is
//! the official AWS Rust SDK; chosen (over e.g. `rust-s3`) because it's
//! the most actively maintained option, supports everything this module
//! needs out of the box -- a custom `endpoint_url`, `force_path_style`
//! (required: SeaweedFS's S3 gateway needs path-style addressing, not
//! virtual-hosted-style, confirmed hands-on in #188 and re-confirmed here
//! against a live `weed mini` instance), and
//! `aws_sdk_s3::presigning::PresigningConfig` for presigned PUT/GET URL
//! generation -- and needs no separate `aws-config`/STS/IMDS machinery
//! since this module only ever uses static credentials
//! (`SEAWEEDFS_S3_ACCESS_KEY`/`SEAWEEDFS_S3_SECRET_KEY`) and a fixed
//! custom endpoint. Enabled with the `behavior-version-latest` feature so
//! `aws_sdk_s3::config::BehaviorVersion::latest()` is available without
//! also depending on `aws-config`.
//!
//! **Two clients, two endpoints.** Per #188's decision doc, a presigned
//! URL's SigV4 signature is bound to the host inside it, so the endpoint
//! used to *sign* a presigned URL and the endpoint the API itself uses for
//! *server-side, same-process* admin/existence-check calls are not
//! interchangeable: [`AvatarStore`] holds one `aws_sdk_s3::Client`
//! configured against `SEAWEEDFS_INTERNAL_ENDPOINT` (used for
//! `HeadObject`/`DeleteObject`, which never leave this process) and a
//! second configured against `SEAWEEDFS_PUBLIC_ENDPOINT` (used *only* to
//! generate presigned PUT/GET URLs, since those URLs are handed to the
//! mobile client, which cannot resolve the `seaweedfs` docker-compose
//! service name). Verified hands-on against a live `weed mini` instance:
//! generating against one endpoint and connecting to the other fails with
//! `SignatureDoesNotMatch`.
//!
//! **Region.** S3 SDKs require a region value even though SeaweedFS itself
//! ignores it; [`AWS_REGION`] is a fixed, arbitrary constant (`us-east-1`)
//! and is not meant to become configurable.
//!
//! **No bucket-creation logic here.** Per #188, the `seaweedfs`
//! docker-compose service already creates `AVATAR_BUCKET_NAME` at
//! container startup via its own `S3_BUCKET` env var -- this module does
//! not create the bucket, and does not need to: it's a pure infra concern
//! now.
//!
//! **Object key / serving path.** Each user has at most one avatar object,
//! stored at a deterministic key (see [`object_key`]) that a fresh upload
//! always overwrites -- there is never an orphaned old object left behind.
//! `users.image` stores this API's own serving path (see
//! [`serving_path`]), never the SeaweedFS key or a raw presigned/S3 URL.

use std::env;
use std::fmt;
use std::time::Duration;

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_sdk_s3::error::SdkError;
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::Client as S3Client;
use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::auth::{AppState, AuthenticatedUser};

/// Fixed region value passed to the S3 SDK. SeaweedFS itself ignores it;
/// see this module's doc comment.
const AWS_REGION: &str = "us-east-1";

/// How long a presigned PUT/GET URL remains valid.
const PRESIGNED_URL_EXPIRY: Duration = Duration::from_secs(5 * 60);

/// Maximum accepted avatar size, in bytes (5 MiB). Enforced in
/// [`confirm_upload`] after the client has already PUT its bytes directly
/// to SeaweedFS -- see this module's doc comment and issue #189's
/// acceptance criteria for why this can't be enforced any earlier (the PUT
/// never passes through this API).
const MAX_AVATAR_BYTES: i64 = 5 * 1024 * 1024;

/// Content types accepted by [`request_upload_url`]. Any other value is
/// rejected with `400 {"error": "invalid_content_type"}`.
const ALLOWED_CONTENT_TYPES: &[&str] = &["image/png", "image/jpeg"];

/// Environment variable read for the internal (server-side) SeaweedFS S3
/// endpoint -- see this module's doc comment.
pub const SEAWEEDFS_INTERNAL_ENDPOINT_VAR: &str = "SEAWEEDFS_INTERNAL_ENDPOINT";

/// Environment variable read for the public (mobile-client-reachable)
/// SeaweedFS S3 endpoint -- see this module's doc comment.
pub const SEAWEEDFS_PUBLIC_ENDPOINT_VAR: &str = "SEAWEEDFS_PUBLIC_ENDPOINT";

/// Environment variable read for the SeaweedFS S3 gateway's static access
/// key (must match `docker/seaweedfs-s3-config.json`'s `accessKey`).
pub const SEAWEEDFS_S3_ACCESS_KEY_VAR: &str = "SEAWEEDFS_S3_ACCESS_KEY";

/// Environment variable read for the SeaweedFS S3 gateway's static secret
/// key (must match `docker/seaweedfs-s3-config.json`'s `secretKey`).
pub const SEAWEEDFS_S3_SECRET_KEY_VAR: &str = "SEAWEEDFS_S3_SECRET_KEY";

/// Environment variable read for the bucket avatar objects are stored in.
pub const AVATAR_BUCKET_NAME_VAR: &str = "AVATAR_BUCKET_NAME";

/// Default bucket name applied when `AVATAR_BUCKET_NAME` is unset, matching
/// `docker-compose.yml`'s own `${AVATAR_BUCKET_NAME:-avatars}` default.
const DEFAULT_AVATAR_BUCKET_NAME: &str = "avatars";

/// Deterministic per-user object key -- a fresh upload always overwrites
/// this same key, so there is never an orphaned previous avatar object.
fn object_key(user_id: Uuid) -> String {
    format!("avatars/{user_id}")
}

/// This API's own serving path for `user_id`'s avatar -- the only avatar
/// reference ever written to `users.image`.
fn serving_path(user_id: Uuid) -> String {
    format!("/api/avatar/{user_id}")
}

/// Errors from an [`AvatarStore`] operation against SeaweedFS.
#[derive(Debug)]
pub struct AvatarStoreError(String);

impl fmt::Display for AvatarStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SeaweedFS S3 operation failed: {}", self.0)
    }
}

impl std::error::Error for AvatarStoreError {}

/// Errors from [`AvatarStore::from_env`].
#[derive(Debug)]
pub struct AvatarStoreConfigError(String);

impl fmt::Display for AvatarStoreConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for AvatarStoreConfigError {}

/// Thin wrapper over two `aws_sdk_s3::Client`s (see this module's doc
/// comment for why two) plus the target bucket name. `Clone`-cheap:
/// `aws_sdk_s3::Client` is itself `Arc`-backed, the same way
/// `crate::auth::AppState`'s other shared handles (`pool`, `nats`,
/// `push_notifier`) are.
#[derive(Clone)]
pub struct AvatarStore {
    /// Configured against `SEAWEEDFS_INTERNAL_ENDPOINT` -- used only for
    /// admin/existence-check calls (`HeadObject`, `DeleteObject`) that run
    /// entirely server-side.
    internal_client: S3Client,
    /// Configured against `SEAWEEDFS_PUBLIC_ENDPOINT` -- used only to
    /// generate presigned PUT/GET URLs handed to the mobile client.
    public_client: S3Client,
    bucket: String,
}

impl AvatarStore {
    /// Builds an [`AvatarStore`] from this module's env vars (see the
    /// `*_VAR` constants above). Fails fast with a descriptive error if any
    /// required var is missing, mirroring `crate::db::connect`/
    /// `crate::nats::connect`'s existing fail-fast-at-startup convention.
    pub fn from_env() -> Result<Self, AvatarStoreConfigError> {
        let internal_endpoint = env::var(SEAWEEDFS_INTERNAL_ENDPOINT_VAR).map_err(|_| {
            AvatarStoreConfigError(format!("{SEAWEEDFS_INTERNAL_ENDPOINT_VAR} must be set"))
        })?;
        let public_endpoint = env::var(SEAWEEDFS_PUBLIC_ENDPOINT_VAR).map_err(|_| {
            AvatarStoreConfigError(format!("{SEAWEEDFS_PUBLIC_ENDPOINT_VAR} must be set"))
        })?;
        let access_key = env::var(SEAWEEDFS_S3_ACCESS_KEY_VAR).map_err(|_| {
            AvatarStoreConfigError(format!("{SEAWEEDFS_S3_ACCESS_KEY_VAR} must be set"))
        })?;
        let secret_key = env::var(SEAWEEDFS_S3_SECRET_KEY_VAR).map_err(|_| {
            AvatarStoreConfigError(format!("{SEAWEEDFS_S3_SECRET_KEY_VAR} must be set"))
        })?;
        let bucket = env::var(AVATAR_BUCKET_NAME_VAR)
            .unwrap_or_else(|_| DEFAULT_AVATAR_BUCKET_NAME.to_string());

        Ok(Self::new(
            &internal_endpoint,
            &public_endpoint,
            &access_key,
            &secret_key,
            bucket,
        ))
    }

    /// Builds an [`AvatarStore`] against explicit config, bypassing the
    /// environment -- used by [`from_env`](Self::from_env) and directly by
    /// integration tests.
    pub fn new(
        internal_endpoint: &str,
        public_endpoint: &str,
        access_key: &str,
        secret_key: &str,
        bucket: impl Into<String>,
    ) -> Self {
        Self {
            internal_client: build_client(internal_endpoint, access_key, secret_key),
            public_client: build_client(public_endpoint, access_key, secret_key),
            bucket: bucket.into(),
        }
    }

    /// Generates a presigned PUT URL (signed against
    /// `SEAWEEDFS_PUBLIC_ENDPOINT`) for `user_id`'s avatar object, valid for
    /// [`PRESIGNED_URL_EXPIRY`]. Binds `content_type` into the signed
    /// headers (SigV4 presigned URLs bind signed headers into the
    /// signature), so a PUT with a different `Content-Type` fails
    /// SeaweedFS's own signature check -- no separate server-side check is
    /// needed at PUT time, since the PUT goes directly to SeaweedFS, never
    /// through this API.
    pub async fn presigned_put_url(
        &self,
        user_id: Uuid,
        content_type: &str,
    ) -> Result<String, AvatarStoreError> {
        let presigning_config = PresigningConfig::expires_in(PRESIGNED_URL_EXPIRY)
            .map_err(|err| AvatarStoreError(err.to_string()))?;
        let presigned = self
            .public_client
            .put_object()
            .bucket(&self.bucket)
            .key(object_key(user_id))
            .content_type(content_type)
            .presigned(presigning_config)
            .await
            .map_err(|err| AvatarStoreError(err.to_string()))?;
        Ok(presigned.uri().to_string())
    }

    /// Generates a presigned GET URL (signed against
    /// `SEAWEEDFS_PUBLIC_ENDPOINT`) for `user_id`'s avatar object, valid for
    /// [`PRESIGNED_URL_EXPIRY`].
    pub async fn presigned_get_url(&self, user_id: Uuid) -> Result<String, AvatarStoreError> {
        let presigning_config = PresigningConfig::expires_in(PRESIGNED_URL_EXPIRY)
            .map_err(|err| AvatarStoreError(err.to_string()))?;
        let presigned = self
            .public_client
            .get_object()
            .bucket(&self.bucket)
            .key(object_key(user_id))
            .presigned(presigning_config)
            .await
            .map_err(|err| AvatarStoreError(err.to_string()))?;
        Ok(presigned.uri().to_string())
    }

    /// `HeadObject` against `SEAWEEDFS_INTERNAL_ENDPOINT` for `user_id`'s
    /// avatar object. Returns `Ok(Some(content_length))` if the object
    /// exists, `Ok(None)` if it doesn't (SeaweedFS reports a 404), and
    /// `Err` for any other failure (network error, unexpected response).
    pub async fn object_content_length(
        &self,
        user_id: Uuid,
    ) -> Result<Option<i64>, AvatarStoreError> {
        match self
            .internal_client
            .head_object()
            .bucket(&self.bucket)
            .key(object_key(user_id))
            .send()
            .await
        {
            Ok(output) => Ok(Some(output.content_length().unwrap_or_default())),
            // Only treat the specific "object not found" service error as
            // `None` -- any other failure (including a "bucket not found",
            // which per #188 should never actually happen since infra
            // creates it at startup) is a real error, not a 404.
            Err(SdkError::ServiceError(context)) if context.err().is_not_found() => Ok(None),
            Err(err) => Err(AvatarStoreError(err.to_string())),
        }
    }

    /// `DeleteObject` against `SEAWEEDFS_INTERNAL_ENDPOINT` for `user_id`'s
    /// avatar object -- used by [`confirm_upload`] to clean up an
    /// oversized upload rather than leaving it in the bucket.
    pub async fn delete_object(&self, user_id: Uuid) -> Result<(), AvatarStoreError> {
        self.internal_client
            .delete_object()
            .bucket(&self.bucket)
            .key(object_key(user_id))
            .send()
            .await
            .map(|_| ())
            .map_err(|err| AvatarStoreError(err.to_string()))
    }
}

fn build_client(endpoint: &str, access_key: &str, secret_key: &str) -> S3Client {
    let credentials = Credentials::new(
        access_key,
        secret_key,
        None,
        None,
        "epistl-seaweedfs-static",
    );
    let config = aws_sdk_s3::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .region(Region::new(AWS_REGION))
        .endpoint_url(endpoint)
        .credentials_provider(credentials)
        // Required: SeaweedFS's S3 gateway needs path-style addressing --
        // see this module's doc comment.
        .force_path_style(true)
        .build();
    S3Client::from_conf(config)
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/avatar/upload-url", post(request_upload_url))
        .route("/api/avatar/confirm", post(confirm_upload))
        .route("/api/avatar/{user_id}", get(get_avatar))
        .with_state(state)
}

fn internal_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "internal_error" })),
    )
        .into_response()
}

fn bad_request(error: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response()
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "not_found" }))).into_response()
}

#[derive(Debug, Deserialize, Default)]
struct UploadUrlPayload {
    #[serde(rename = "contentType", default)]
    content_type: Option<String>,
}

async fn request_upload_url(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Json(payload): Json<UploadUrlPayload>,
) -> Response {
    let content_type = payload.content_type.unwrap_or_default();
    if !ALLOWED_CONTENT_TYPES.contains(&content_type.as_str()) {
        return bad_request("invalid_content_type");
    }

    match state
        .avatar_store
        .presigned_put_url(user.user.id, &content_type)
        .await
    {
        Ok(upload_url) => (
            StatusCode::OK,
            Json(json!({ "uploadUrl": upload_url, "contentType": content_type })),
        )
            .into_response(),
        Err(_) => internal_error(),
    }
}

async fn confirm_upload(user: AuthenticatedUser, State(state): State<AppState>) -> Response {
    let content_length = match state.avatar_store.object_content_length(user.user.id).await {
        Ok(content_length) => content_length,
        Err(_) => return internal_error(),
    };

    let Some(content_length) = content_length else {
        return not_found();
    };

    if content_length > MAX_AVATAR_BYTES {
        // Best-effort cleanup: an oversized object must not be left
        // sitting in the bucket. Its absence/presence doesn't change the
        // response either way -- the request still fails with
        // `file_too_large`.
        let _ = state.avatar_store.delete_object(user.user.id).await;
        return bad_request("file_too_large");
    }

    let path = serving_path(user.user.id);
    let updated = sqlx::query("UPDATE users SET image = $1 WHERE id = $2")
        .bind(&path)
        .bind(user.user.id)
        .execute(&state.pool)
        .await;

    match updated {
        Ok(_) => (StatusCode::OK, Json(json!({ "image": path }))).into_response(),
        Err(_) => internal_error(),
    }
}

async fn get_avatar(
    _caller: AuthenticatedUser,
    State(state): State<AppState>,
    Path(user_id): Path<Uuid>,
) -> Response {
    let row = sqlx::query_as::<_, (Option<String>,)>("SELECT image FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await;

    let has_avatar = match row {
        Ok(Some((Some(_image),))) => true,
        Ok(Some((None,))) | Ok(None) => false,
        Err(_) => return internal_error(),
    };

    if !has_avatar {
        return not_found();
    }

    match state.avatar_store.presigned_get_url(user_id).await {
        Ok(url) => {
            let Ok(location) = HeaderValue::from_str(&url) else {
                return internal_error();
            };
            (StatusCode::FOUND, [(header::LOCATION, location)]).into_response()
        }
        Err(_) => internal_error(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_key_is_scoped_under_avatars_prefix() {
        let user_id = Uuid::new_v4();
        assert_eq!(object_key(user_id), format!("avatars/{user_id}"));
    }

    #[test]
    fn serving_path_is_the_apis_own_avatar_route() {
        let user_id = Uuid::new_v4();
        assert_eq!(serving_path(user_id), format!("/api/avatar/{user_id}"));
    }
}
