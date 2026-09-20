//! `GET /api/messages/queued/{from_user_id}` -- read-only peek at the oldest
//! message queued for the authenticated caller from a given sender (issue
//! #249), for background/extension decrypt-for-notification flows (#173).
//!
//! The offline queue is a WorkQueue-retention JetStream stream, so creating
//! any consumer would remove messages on ack. This route therefore never
//! creates a consumer: it walks the caller's subject with the stream's raw
//! message-get API, which is read-only. The envelope stays queued for
//! delivery over `/ws`. The subject is derived from the authenticated user
//! id only. The server never decodes `body_b64`.

use async_nats::jetstream::stream::RawMessageErrorKind;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::{AppState, AuthenticatedUser};

/// Upper bound on queued messages inspected per request (same cap as the
/// `/ws` connect-time fetch).
const MAX_QUEUED_MESSAGES_PER_FETCH: usize = 256;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/messages/queued/{from_user_id}", get(get_queued))
        .with_state(state)
}

fn internal_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "internal_error" })),
    )
        .into_response()
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "not_found" }))).into_response()
}

async fn get_queued(
    user: AuthenticatedUser,
    State(state): State<AppState>,
    Path(from_user_id): Path<Uuid>,
) -> Response {
    let jetstream = async_nats::jetstream::new(state.nats.clone());
    let stream = match jetstream
        .get_stream(crate::nats::effective_stream_name())
        .await
    {
        Ok(stream) => stream,
        Err(_) => return internal_error(),
    };

    let subject = crate::nats::effective_offline_subject(user.user.id);
    let from = from_user_id.to_string();
    let mut next_seq: u64 = 0;

    for _ in 0..MAX_QUEUED_MESSAGES_PER_FETCH {
        let raw = match stream
            .get_first_raw_message_by_subject(&subject, next_seq)
            .await
        {
            Ok(raw) => raw,
            Err(err) if matches!(err.kind(), RawMessageErrorKind::NoMessageFound) => {
                return not_found()
            }
            Err(_) => return internal_error(),
        };
        next_seq = raw.sequence + 1;

        let Ok(payload) = serde_json::from_slice::<Value>(&raw.payload) else {
            continue;
        };
        if payload.get("from").and_then(Value::as_str) == Some(from.as_str()) {
            return (
                StatusCode::OK,
                Json(json!({
                    "from": payload.get("from"),
                    "body_b64": payload.get("body_b64"),
                    "sent_at": payload.get("sent_at"),
                })),
            )
                .into_response();
        }
    }

    not_found()
}
