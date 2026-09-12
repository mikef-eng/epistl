//! `POST /api/keys` -- publishes the caller's public key bundle for the
//! PQXDH-style handshake (`docs/decisions/0005-pqxdh-handshake-classical-ratchet.md`).
//!
//! This module only stores and relays opaque public-key/signature bytes; it
//! never performs any cryptographic operation on them. Storing public keys
//! (as opposed to message content or private keys) in Postgres is settled
//! by `docs/decisions/0004-public-keys-allowed-in-postgres.md`. See
//! `migrations/0005_create_user_keys_table.sql` for the backing table.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::json;

use crate::auth::{AppState, AuthenticatedUser};

/// Fixed-size FIPS 203 / FIPS 204 / RFC 7748 lengths -- see issue #35's
/// Notes for provenance (standard-mandated, not library-specific).
const X25519_PUBLIC_KEY_LEN: usize = 32;
const KYBER_PUBLIC_KEY_LEN: usize = 1184;
const DILITHIUM_PUBLIC_KEY_LEN: usize = 1952;
const PREKEY_SIGNATURE_LEN: usize = 3309;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/keys", post(upload_keys))
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

#[derive(Debug, Deserialize, Default)]
struct UploadKeysPayload {
    #[serde(default)]
    x25519_public_key_b64: Option<String>,
    #[serde(default)]
    kyber_public_key_b64: Option<String>,
    #[serde(default)]
    dilithium_public_key_b64: Option<String>,
    #[serde(default)]
    prekey_signature_b64: Option<String>,
}

/// Base64-decodes `field`, returning `None` (a fully generic `invalid_input`
/// case) if the field is missing or not valid base64. Length validation
/// against the specific key type happens separately, after all four fields
/// have decoded successfully, so each field gets its own specific error
/// code.
fn decode_field(field: Option<&String>) -> Option<Vec<u8>> {
    let field = field?;
    BASE64.decode(field).ok()
}

async fn upload_keys(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Json(payload): Json<UploadKeysPayload>,
) -> Response {
    let Some(x25519) = decode_field(payload.x25519_public_key_b64.as_ref()) else {
        return bad_request("invalid_input");
    };
    let Some(kyber) = decode_field(payload.kyber_public_key_b64.as_ref()) else {
        return bad_request("invalid_input");
    };
    let Some(dilithium) = decode_field(payload.dilithium_public_key_b64.as_ref()) else {
        return bad_request("invalid_input");
    };
    let Some(prekey_signature) = decode_field(payload.prekey_signature_b64.as_ref()) else {
        return bad_request("invalid_input");
    };

    if x25519.len() != X25519_PUBLIC_KEY_LEN {
        return bad_request("invalid_x25519_key");
    }
    if kyber.len() != KYBER_PUBLIC_KEY_LEN {
        return bad_request("invalid_kyber_key");
    }
    if dilithium.len() != DILITHIUM_PUBLIC_KEY_LEN {
        return bad_request("invalid_dilithium_key");
    }
    if prekey_signature.len() != PREKEY_SIGNATURE_LEN {
        return bad_request("invalid_prekey_signature");
    }

    let upserted = sqlx::query_as::<_, (DateTime<Utc>,)>(
        r#"
        INSERT INTO user_keys (user_id, x25519_public_key, kyber_public_key, dilithium_public_key, prekey_signature)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id) DO UPDATE SET
            x25519_public_key = EXCLUDED.x25519_public_key,
            kyber_public_key = EXCLUDED.kyber_public_key,
            dilithium_public_key = EXCLUDED.dilithium_public_key,
            prekey_signature = EXCLUDED.prekey_signature,
            updated_at = now()
        RETURNING updated_at
        "#,
    )
    .bind(user.user.id)
    .bind(&x25519)
    .bind(&kyber)
    .bind(&dilithium)
    .bind(&prekey_signature)
    .fetch_one(&state.pool)
    .await;

    match upserted {
        Ok((updated_at,)) => (
            StatusCode::OK,
            Json(json!({ "user_id": user.user.id, "updated_at": updated_at })),
        )
            .into_response(),
        Err(_) => internal_error(),
    }
}
