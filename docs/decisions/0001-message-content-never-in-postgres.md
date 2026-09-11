# 0001: Message content is never durably stored in Postgres

## Context

Postgres holds identity data: users, contacts, sessions. Early messaging
design considered a `messages` table for simplicity. Epistl's model is
closer to WhatsApp than a typical chat CRUD app: the server should not be
a durable store of message content by default.

## Decision

Message **content** (plaintext today, ciphertext once E2EE lands) is never
written to a durable Postgres table. Postgres is for users, contacts, and
sessions only.

A message may pass through a transient, in-memory relay on the server just
long enough to deliver it to a connected recipient, then it is gone from
the server. This is a delivery hop, not storage. Offline/durable delivery
queueing (when added) belongs in NATS JetStream with a short TTL — still
transient, never a `messages` table in Postgres.

## Consequences

- No `messages` table migration in `apps/api`.
- The WebSocket relay endpoint does not persist message bodies anywhere.
- Durable message history lives only on-device — see
  [0002](0002-scylla-backup-is-opt-in.md) and
  [0003](0003-opaque-message-envelope.md).
- A Coder proposing a Postgres messages table must treat this as a
  conflicting architecture change, not a routine implementation detail —
  raise it with the user before implementing, don't just build it.
