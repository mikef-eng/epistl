//! Outbound push notification sending via the Expo Push Notification
//! service's HTTPS API (`https://exp.host/--/api/v2/push/send`) -- the
//! standard delivery mechanism for this Expo-managed app, covering both
//! iOS/APNs and Android/FCM behind one unified endpoint without this API
//! needing direct Apple/Google credentials.
//!
//! This module originally only built the sending capability as a
//! standalone, independently-testable unit (issue #167) --
//! [`send_push_notification`] just takes a token as a plain parameter, with
//! no knowledge of `push_tokens` (issue #166) or any delivery event. Issue
//! #168 wires it into the actual offline-delivery path
//! (`crate::relay::queue_for_offline_delivery`) via the [`PushNotifier`]
//! trait below, which reads tokens out of `push_tokens` itself rather than
//! this module doing so. Stale-token cleanup on a `DeviceNotRegistered`
//! rejection is still not built -- this module only surfaces that outcome
//! to its caller via [`PushError::Rejected`].
//!
//! Per `docs/decisions/0001-message-content-never-in-postgres.md` /
//! `docs/decisions/0003-opaque-message-envelope.md`'s spirit, message
//! content must never reach a third-party relay like Expo: the `body` text
//! sent here is always the caller-supplied generic, non-content string
//! (e.g. `"You have a new message"`), and `data` must stay limited to a
//! small, identity-only payload (e.g. `{"type": "message", "fromUserId":
//! "<uuid>"}`, needed later for tap-to-navigate) -- this module doesn't
//! enforce that at the type level, so callers must not pass message
//! plaintext/ciphertext/envelope bytes into `title`/`body`/`data`.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

/// Expo's push API endpoint. See
/// <https://docs.expo.dev/push-notifications/sending-notifications/#http2-api>.
pub const EXPO_PUSH_API_URL: &str = "https://exp.host/--/api/v2/push/send";

/// Errors [`send_push_notification`] can return.
#[derive(Debug, PartialEq, Eq)]
pub enum PushError {
    /// Expo accepted the HTTP request but reported it could not deliver to
    /// this specific token -- e.g. `DeviceNotRegistered` (the token is no
    /// longer valid). Carries Expo's own error code, when present, plus its
    /// human-readable message.
    Rejected {
        expo_error_code: Option<String>,
        message: String,
    },
    /// The request itself failed: a network error, a 5xx from Expo, or a
    /// response whose body didn't match Expo's documented shape.
    RequestFailed(String),
}

impl fmt::Display for PushError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PushError::Rejected {
                expo_error_code,
                message,
            } => match expo_error_code {
                Some(code) => write!(f, "Expo rejected the push token ({code}): {message}"),
                None => write!(f, "Expo rejected the push: {message}"),
            },
            PushError::RequestFailed(reason) => {
                write!(f, "push request to Expo failed: {reason}")
            }
        }
    }
}

impl std::error::Error for PushError {}

/// Expo's push receipt/ticket, as embedded in the `data` field of a push
/// send response. See
/// <https://docs.expo.dev/push-notifications/sending-notifications/#response-format>.
#[derive(Debug, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum ExpoPushTicket {
    Ok,
    Error {
        message: String,
        details: Option<ExpoPushErrorDetails>,
    },
}

#[derive(Debug, Deserialize)]
struct ExpoPushErrorDetails {
    error: Option<String>,
}

/// A push-send response for a single message: `{"data": {...}}`. Extra
/// fields (e.g. `id` on a success ticket) are ignored -- this type only
/// pulls out what's needed to distinguish success from a per-token
/// rejection.
#[derive(Debug, Deserialize)]
struct ExpoPushResponse {
    data: Option<ExpoPushTicket>,
}

/// Sends a push notification for `token` via Expo's push API.
///
/// `title`/`body` must be content-free (see this module's docs); `data` is
/// a small opaque JSON payload (e.g. `{"type": "message", "fromUserId":
/// "<uuid>"}`) forwarded to the device as-is.
///
/// Returns `Ok(())` once Expo confirms the message was queued for
/// delivery. Returns [`PushError::Rejected`] when Expo accepted the
/// request but reports it can't deliver to this token (e.g.
/// `DeviceNotRegistered`), and [`PushError::RequestFailed`] for a network
/// error, a 5xx from Expo, or an unparseable response.
pub async fn send_push_notification(
    client: &reqwest::Client,
    token: &str,
    title: &str,
    body: &str,
    data: Value,
) -> Result<(), PushError> {
    send_push_notification_to(client, EXPO_PUSH_API_URL, token, title, body, data).await
}

/// Same as [`send_push_notification`], but against an explicit `endpoint`
/// rather than the real [`EXPO_PUSH_API_URL`] -- the test seam tests point
/// at a local `wiremock` server, mirroring `crate::nats::connect`/
/// `connect_with`'s split.
async fn send_push_notification_to(
    client: &reqwest::Client,
    endpoint: &str,
    token: &str,
    title: &str,
    body: &str,
    data: Value,
) -> Result<(), PushError> {
    let payload = json!({
        "to": token,
        "title": title,
        "body": body,
        "data": data,
    });

    let response = client
        .post(endpoint)
        .json(&payload)
        .send()
        .await
        .map_err(|err| PushError::RequestFailed(err.to_string()))?;

    let status = response.status();
    let body_text = response
        .text()
        .await
        .map_err(|err| PushError::RequestFailed(format!("failed to read response body: {err}")))?;

    if status.is_server_error() {
        return Err(PushError::RequestFailed(format!(
            "Expo returned {status}: {body_text}"
        )));
    }

    let parsed: ExpoPushResponse = serde_json::from_str(&body_text).map_err(|err| {
        PushError::RequestFailed(format!(
            "failed to parse Expo response ({status}): {err} (body: {body_text})"
        ))
    })?;

    match parsed.data {
        Some(ExpoPushTicket::Ok) => Ok(()),
        Some(ExpoPushTicket::Error { message, details }) => Err(PushError::Rejected {
            expo_error_code: details.and_then(|d| d.error),
            message,
        }),
        None => Err(PushError::RequestFailed(format!(
            "Expo response ({status}) missing `data`: {body_text}"
        ))),
    }
}

/// Object-safe seam over [`send_push_notification`], so callers that need
/// to trigger a push as a side effect of some other event (issue #168's
/// `crate::relay::queue_for_offline_delivery`) can depend on a trait object
/// instead of a concrete `reqwest::Client`, letting integration tests
/// inject a mock notifier instead of exercising the real Expo push API (or
/// even a `wiremock` server) end to end.
///
/// Not `async_trait`-based -- this crate doesn't otherwise depend on
/// `async_trait`, so the trait method returns a manually boxed future
/// instead, which needs no extra dependency for a single trait.
pub trait PushNotifier: Send + Sync {
    /// Same contract as [`send_push_notification`]: `title`/`body` must
    /// stay content-free, and `data` stays limited to a small identity-only
    /// payload -- this trait doesn't enforce that at the type level either.
    fn send_push<'a>(
        &'a self,
        token: &'a str,
        title: &'a str,
        body: &'a str,
        data: Value,
    ) -> Pin<Box<dyn Future<Output = Result<(), PushError>> + Send + 'a>>;
}

/// The real [`PushNotifier`] used at runtime: sends via
/// [`send_push_notification`] against the actual Expo push API, using a
/// shared `reqwest::Client` (connection pooling across every push this
/// process ever sends, rather than a fresh client per call).
pub struct ExpoPushNotifier {
    client: reqwest::Client,
}

impl ExpoPushNotifier {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }
}

impl Default for ExpoPushNotifier {
    fn default() -> Self {
        Self::new()
    }
}

impl PushNotifier for ExpoPushNotifier {
    fn send_push<'a>(
        &'a self,
        token: &'a str,
        title: &'a str,
        body: &'a str,
        data: Value,
    ) -> Pin<Box<dyn Future<Output = Result<(), PushError>> + Send + 'a>> {
        Box::pin(send_push_notification(
            &self.client,
            token,
            title,
            body,
            data,
        ))
    }
}

/// Shared, `Clone`-cheap handle to a [`PushNotifier`], suitable for storing
/// on `crate::auth::AppState` (which is itself cloned per-request/per-task
/// the same way `pool`/`registry`/`nats` are).
pub type SharedPushNotifier = Arc<dyn PushNotifier>;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn successful_send_returns_ok() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/--/api/v2/push/send"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "status": "ok", "id": "receipt-id-123" }
            })))
            .mount(&server)
            .await;

        let client = reqwest::Client::new();
        let endpoint = format!("{}/--/api/v2/push/send", server.uri());

        let result = send_push_notification_to(
            &client,
            &endpoint,
            "ExponentPushToken[abc123]",
            "New message",
            "You have a new message",
            json!({ "type": "message", "fromUserId": "11111111-1111-1111-1111-111111111111" }),
        )
        .await;

        assert_eq!(result, Ok(()));
    }

    #[tokio::test]
    async fn expo_rejection_is_reported_as_rejected() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/--/api/v2/push/send"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "status": "error",
                    "message": "\"ExponentPushToken[bad]\" is not a registered push notification recipient",
                    "details": { "error": "DeviceNotRegistered" }
                }
            })))
            .mount(&server)
            .await;

        let client = reqwest::Client::new();
        let endpoint = format!("{}/--/api/v2/push/send", server.uri());

        let result = send_push_notification_to(
            &client,
            &endpoint,
            "ExponentPushToken[bad]",
            "New message",
            "You have a new message",
            json!({ "type": "message", "fromUserId": "11111111-1111-1111-1111-111111111111" }),
        )
        .await;

        match result {
            Err(PushError::Rejected {
                expo_error_code,
                message,
            }) => {
                assert_eq!(expo_error_code.as_deref(), Some("DeviceNotRegistered"));
                assert!(message.contains("not a registered push notification recipient"));
            }
            other => panic!("expected Rejected, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn server_error_is_reported_as_request_failed() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/--/api/v2/push/send"))
            .respond_with(ResponseTemplate::new(500).set_body_string("internal error"))
            .mount(&server)
            .await;

        let client = reqwest::Client::new();
        let endpoint = format!("{}/--/api/v2/push/send", server.uri());

        let result = send_push_notification_to(
            &client,
            &endpoint,
            "ExponentPushToken[abc123]",
            "New message",
            "You have a new message",
            json!({ "type": "message", "fromUserId": "11111111-1111-1111-1111-111111111111" }),
        )
        .await;

        match result {
            Err(PushError::RequestFailed(_)) => {}
            other => panic!("expected RequestFailed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn network_failure_is_reported_as_request_failed() {
        let client = reqwest::Client::new();
        // Port 1 is not listening in any test environment; the connection
        // attempt itself fails before any response is available.
        let result = send_push_notification_to(
            &client,
            "http://127.0.0.1:1/--/api/v2/push/send",
            "ExponentPushToken[abc123]",
            "New message",
            "You have a new message",
            json!({ "type": "message", "fromUserId": "11111111-1111-1111-1111-111111111111" }),
        )
        .await;

        match result {
            Err(PushError::RequestFailed(_)) => {}
            other => panic!("expected RequestFailed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn public_entry_point_targets_expo_url_by_default() {
        // send_push_notification (the public entry point) always targets
        // EXPO_PUSH_API_URL -- exercised indirectly by asserting the
        // constant matches Expo's documented endpoint, since actually
        // calling send_push_notification would make a real network
        // request.
        assert_eq!(EXPO_PUSH_API_URL, "https://exp.host/--/api/v2/push/send");
    }
}
