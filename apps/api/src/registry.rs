//! In-memory registry of connected users' live WebSocket senders.
//!
//! This exists solely so the `/ws` relay (see [`crate::ws`]) can look up a
//! currently-connected recipient's socket and write a frame directly to it.
//! It is intentionally **not** backed by Postgres or any other durable
//! store: entries disappear the moment a socket disconnects, and nothing
//! here ever touches disk.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::ws::Message;
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

/// The channel used to push frames out to a connected user's socket. A
/// background task per connection owns the actual `WebSocket` sink and
/// forwards everything received here onto it (see `ws::handle_socket`).
pub type Sender = mpsc::UnboundedSender<Message>;

/// Maps a connected user's id to the sender half of their socket's outbound
/// channel. Cloning a [`ConnectionRegistry`] is cheap and shares the same
/// underlying map (`Arc`-backed), matching how [`crate::auth::AppState`] is
/// cloned per-request.
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
