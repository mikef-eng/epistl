# 0008: JetStream offline-delivery queue is a transient work queue, not storage

## Context

`docs/decisions/0001-message-content-never-in-postgres.md` anticipates
this stream directly: "Offline/durable delivery queueing (when added)
belongs in NATS JetStream with a short TTL — still transient, never a
`messages` table in Postgres." Issue #12 (stub) and this batch's issue #52
turn that prose into an actual stream config. JetStream is flexible enough
to build either a genuine durable log (`LimitsPolicy`, no age bound,
`Memory` storage never surviving a restart) or a genuine transient queue —
reconciling "transient delivery queueing" with JetStream's real
configuration knobs (retention policy, ack semantics, what "delivered"
means and when a message is removed) is a protocol/architecture decision
with real cost of change, not a routine implementation detail. This ADR
records that reconciliation so a future Coder doesn't have to re-derive it
or drift the stream toward being a message archive one config tweak at a
time.

## Decision

The `EPISTL_OFFLINE_MESSAGES` stream (`apps/api/src/nats.rs`,
`ensure_offline_stream`) is configured as:

- **`retention: WorkQueuePolicy`**, not `LimitsPolicy`. Under
  `WorkQueuePolicy`, a message is removed from the stream as soon as any
  consumer acknowledges it — the stream itself enforces "at most one
  successful delivery, then gone" as a structural property, not a
  convention the application has to also remember to implement as a
  separate delete call. `LimitsPolicy` (JetStream's default) would keep
  every message until a size/count/age limit is hit regardless of
  delivery, which is a durable-log shape, not a delivery-queue shape —
  exactly what ADR 0001 rules out.
- **`max_age`: a short, explicit, operator-tunable TTL**, read from
  `OFFLINE_QUEUE_MAX_AGE_SECS` (default 24 hours / 86400 seconds if
  unset) rather than left unbounded. `WorkQueuePolicy` alone only
  guarantees removal *after* a successful ack; without a `max_age` cap, a
  message for a recipient who never reconnects (device lost, app
  uninstalled, account abandoned) would sit in the stream forever. The
  bound is read from an env var rather than hardcoded so an operator can
  retune the offline-delivery window (e.g. shorter for a more aggressive
  privacy posture, longer to tolerate a longer expected offline period)
  without a code change and redeploy — but it always has a concrete,
  bounded default so the transience guarantee holds even if the operator
  never sets it explicitly.
- **`storage: File`**, not `Memory`. This is deliberately *not* about
  retention length — `max_age` and `WorkQueuePolicy`'s ack-based removal
  already bound total retention regardless of storage backend. It's about
  surviving an ordinary API process restart (deploy, crash-and-restart)
  while a recipient is still offline within the TTL window: `Memory`
  storage would silently drop every still-queued message on any restart,
  which is a worse and less predictable failure mode than the bounded,
  intentional expiry `max_age` already provides.
- **Definition of "delivered"**: successfully forwarded to the
  recipient's live WebSocket, *then* acknowledged — not acked merely on
  successful publish or successful fetch from the stream. Ack happens
  after the send to the live socket succeeds, so a crash between fetching
  a queued message and finishing the send leaves that message
  redeliverable (JetStream's consumer will hand it to a subsequent
  fetch/reconnect) rather than silently lost. This ordering is
  implemented in the deliver-on-reconnect issue in this batch (out of
  scope for #52 itself, which only configures the stream), but the
  ack-after-send contract is fixed here because it's what makes
  `WorkQueuePolicy`'s "ack removes the message" semantics actually mean
  "delivered," not just "picked up."

## Consequences

- This stream is explicitly a delivery queue, not a substitute for, or a
  stepping stone toward, a durable `messages` table — see ADR 0001. A
  Coder proposing to widen its retention (e.g. switching to
  `LimitsPolicy`, removing/raising `max_age`, or persisting delivered
  messages elsewhere "just in case") is proposing a conflicting
  architecture change and must raise it with the user first, the same as
  ADR 0001 already requires for a literal Postgres `messages` table.
- `apps/api/src/nats.rs::ensure_offline_stream` is idempotent
  (`Context::get_or_create_stream`): calling it again against an
  already-existing stream fetches and returns the existing stream rather
  than erroring or attempting to redefine it. It does not currently
  reconcile drift (e.g. a stream created under an older config with a
  different `max_age`) — a stream config *change* requires an explicit
  `update_stream` call, which is not built here and is left for a future
  issue if operators need to retune an already-created stream rather than
  a freshly-provisioned one.
- Publishing to `epistl.offline.<user_id>` and consuming/acking from this
  stream are both out of scope for issue #52 — see the follow-up
  publish-on-offline-send and deliver-on-reconnect issues in this batch,
  which must honor the ack-after-send-succeeds ordering above.
- No UI/user-facing surfacing of the TTL (e.g. a "message expired,
  undelivered" notification) is built by this ADR or issue #52.
