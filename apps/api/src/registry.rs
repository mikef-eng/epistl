//! In-memory registry of connected users' live outbound-frame senders.
//!
//! This exists solely so the shared relay logic in [`crate::relay`] can
//! look up a currently-connected recipient's connection and write a frame
//! directly to it, regardless of which transport (WebSocket today, QUIC in
//! the future -- see issue #72/#73) that connection came in over. It is
//! intentionally **not** backed by Postgres or any other durable store:
//! entries disappear the moment a connection disconnects, and nothing here
//! ever touches disk.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

/// A transport-agnostic outbound frame carried through a
/// [`ConnectionRegistry`] entry. Produced by the shared relay logic in
/// [`crate::relay`], which has no dependency on any specific transport
/// crate; each transport's own glue module (e.g. [`crate::ws`] for
/// WebSocket) translates a `Frame` into that transport's wire
/// representation on the way out, and translates inbound wire frames back
/// into the shapes `crate::relay` expects on the way in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    /// A JSON text frame -- relayed messages, acks, and errors alike, all
    /// serialized to their `{"type": ..., ...}` wire shape already.
    Text(String),
    /// A connection-level close, carrying a close code and a
    /// human-readable reason. WS maps this onto
    /// `axum::extract::ws::CloseFrame`; used for both the
    /// unauthorized-connect close and the same-user replaced-connection
    /// close.
    Close { code: u16, reason: String },
}

/// The channel used to push frames out to a connected user's transport
/// connection. A background task per connection owns the actual transport
/// sink and forwards everything received here onto it, translating `Frame`
/// into that transport's own wire representation (see `ws::handle_socket`
/// for the WebSocket case).
pub type Sender = mpsc::UnboundedSender<Frame>;

/// Maps a connected user's id to the sender half of their connection's
/// outbound channel. Cloning a [`ConnectionRegistry`] is cheap and shares
/// the same underlying map (`Arc`-backed), matching how
/// [`crate::auth::AppState`] is cloned per-request.
#[derive(Clone, Default)]
pub struct ConnectionRegistry(Arc<RwLock<HashMap<Uuid, Sender>>>);

impl ConnectionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers `sender` as the live connection for `user_id`, returning
    /// the previous connection's sender (if any) so the caller can close it
    /// out with the "replaced" close code.
    pub async fn insert(&self, user_id: Uuid, sender: Sender) -> Option<Sender> {
        self.0.write().await.insert(user_id, sender)
    }

    /// Looks up the live sender for `user_id`, e.g. to relay a message to
    /// them. Returns `None` if they aren't currently connected.
    pub async fn get(&self, user_id: &Uuid) -> Option<Sender> {
        self.0.read().await.get(user_id).cloned()
    }

    /// Removes the registry entry for `user_id`, but only if it still
    /// points at `sender`. This is what a disconnecting connection's
    /// cleanup calls -- without the identity check, a stale connection
    /// shutting down after being replaced could clobber the newer
    /// connection's entry.
    pub async fn remove_if_current(&self, user_id: &Uuid, sender: &Sender) {
        let mut guard = self.0.write().await;
        if let Some(existing) = guard.get(user_id) {
            if existing.same_channel(sender) {
                guard.remove(user_id);
            }
        }
    }
}
