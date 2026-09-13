# Mutual contacts (friend requests) — design

Status: approved by user. First of four sub-projects decomposed from a broader "make the app less barebones" feature request (settings section, friends & conversations management UX, search — each deferred to their own future brainstorm).

## Context

`apps/api/src/contacts.rs` and `migrations/0003_create_contacts_table.sql` implement contacts as directed, one-way rows by explicit original design (issue #3's "out of scope": "adding a contact never adds the caller to the other user's list"). In practice this means A can add B and immediately message B, while B has no record of A and no way to message back until B separately adds A. This was flagged as a real gap, not a preference: "one friend adding another should automatically add them back (currently its one way)."

Fixing this touches the relationship model itself (not just UI), and several other features raised in the same conversation — friend/conversation management, "search for friends" (the discover-new-people half) — depend on what "being someone's contact" means. This sub-project settles that foundation first.

`docs/decisions/0009-tanstack-store-and-query-for-network-layer.md` (merged same day) settles that live-relay frames are consumed client-side via TanStack Store's subscription, and server state via TanStack Query — this design is the first real feature built against that interface.

## Decision: request/accept, not silent auto-mutual

Adding a contact becomes a request that the recipient must explicitly accept before the relationship is mutual and messaging is allowed — not an automatic two-way add on request alone. This is a larger scope than a silent auto-mutual add (new pending-state schema, a requests surface, accept/decline endpoints) but was the user's explicit choice over the lighter alternative.

**Crossed requests are surfaced, not auto-merged.** If A requests B while B already has an outstanding pending request to A, the server does not silently create a mutual relationship. It rejects A's request with a distinct outcome carrying B's existing request's id, and the client prompts A to accept that existing request instead — the merge into a mutual contact still requires an explicit accept action, just surfaced at the point A tried to add rather than requiring a separate trip to a pending-requests list.

**Removal is mutual.** Removing a contact deletes the relationship for both sides (both directed `contacts` rows), not just the caller's own view of it. Re-establishing the relationship after removal is a normal fresh request/accept cycle.

## Data model

New table, `contact_requests`:

```sql
CREATE TABLE contact_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'declined'
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    responded_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX contact_requests_pending_pair_idx
    ON contact_requests (requester_user_id, recipient_user_id)
    WHERE status = 'pending';

CREATE INDEX contact_requests_recipient_idx ON contact_requests (recipient_user_id);
```

The existing `contacts` table (`migrations/0003_create_contacts_table.sql`) is unchanged in shape — still two directed rows per relationship, unique `(owner_user_id, contact_user_id)` — but its meaning narrows: a row only ever exists once a request has been accepted, both directions inserted atomically in the same transaction. A declined row in `contact_requests` is left in place (audit trail, future rate-limiting) but does not block a fresh `pending` request later, since uniqueness is scoped to `WHERE status = 'pending'`.

`apps/api/src/ws.rs`'s `handle_send` gate (`SELECT EXISTS(... FROM contacts WHERE owner_user_id = $1 AND contact_user_id = $2)`, line ~283) requires no change: it already only ever checks `contacts`, and pending/declined requests never populate that table.

## API surface

All under `apps/api/src/contacts.rs`, following the module's existing response conventions (typed `{"error": "<code>"}` bodies, `internal_error()` for DB failures):

- **`POST /api/contacts/requests { email }`** — creates a pending request.
  - `201` with the created request on success.
  - `409 incoming_request_exists` (body includes the existing request's `id`) if the recipient already has a pending request to the caller — the crossed-request case above.
  - `409 already_pending` if the caller already has an outstanding request to this recipient.
  - `409 already_contact` if they're already mutual.
  - `404 user_not_found` / `400 cannot_add_self` — unchanged from today's `add_contact`.
- **`GET /api/contacts/requests`** — lists the caller's pending requests, both incoming (`recipient_user_id = caller`) and outgoing (`requester_user_id = caller`, for showing "request sent, awaiting reply").
- **`POST /api/contacts/requests/{id}/accept`** — caller must be the request's recipient. Atomically inserts both `contacts` rows and marks the request resolved (deleted, or `status = 'accepted'` then excluded from future pending queries — implementation's choice, not load-bearing for this spec).
- **`POST /api/contacts/requests/{id}/decline`** — caller must be the request's recipient. Marks `status = 'declined'`, `responded_at = now()`. No `contacts` rows created.
- **`DELETE /api/contacts/{user_id}`** (existing route) — now deletes both directed `contacts` rows in one transaction, not just the caller's.

**Live push:** on request creation, accept, and mutual removal, the server best-effort-pushes a new frame (`contact_request`, `contact_accepted`, `contact_removed`) to the other party over their live connection if currently connected — the same best-effort pattern `queue_for_offline_delivery` already uses for chat messages, except backed by durable Postgres state rather than the transient JetStream queue, since a missed push just means the recipient's next `GET /api/contacts/requests` (or `/api/contacts`) reflects the current state regardless. No JetStream involvement for these frames.

## Client wiring

Per ADR 0009: new frame types arrive through the TanStack Store's existing `lastFrame` state, not a separate socket handler. Receiving `contact_request`, `contact_accepted`, or `contact_removed` triggers `queryClient.invalidateQueries(['contacts'])` and/or `['contactRequests']`, letting the existing (per ADR 0009) Query hooks refetch — no bespoke state management for this feature. New Query hooks: `useContactRequestsQuery()` (`['contactRequests']`), `useSendContactRequestMutation()`, `useAcceptContactRequestMutation()`, `useDeclineContactRequestMutation()`, `useRemoveContactMutation()` (updated to reflect mutual removal), each invalidating `['contacts']`/`['contactRequests']` as appropriate on success.

`AddContactScreen.tsx`'s existing "add by email" flow becomes "send a request by email." A `409 incoming_request_exists` response surfaces an inline prompt ("B already sent you a request") with an Accept action calling `useAcceptContactRequestMutation()` on the carried request id, rather than a generic error message.

## Testing

- New `apps/api` integration tests (extending `tests/contacts.rs` or a new `tests/contact_requests.rs`), against the real test Postgres: create → accept → both sides see each other in `GET /api/contacts`; create → decline → no `contacts` rows, requester can re-request later; crossed-request returns `incoming_request_exists` and does not create `contacts` rows; mutual removal deletes both directions.
- One new case in `tests/ws.rs`: a requester with only a *pending* (not yet accepted) request still gets `not_a_contact` on send — confirms the existing gate needs no change but is exercised against the new pending state.
- Mobile: tests for the new Query hooks against a mocked `client.ts`; a test confirming a `contact_accepted` frame arriving via the transport store triggers a `['contacts']` refetch.
- `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test` for `apps/api`; `npm run lint && npm run typecheck && npm test` for `apps/mobile`.

## Out of scope

- Blocking/reporting a user, or rate-limiting repeated requests from the same sender after a decline.
- Any UI beyond `AddContactScreen`'s updated flow and a minimal pending-requests list — a fuller friends-management screen is sub-project C (deferred, its own future brainstorm).
- Settings section, dark mode, conversation search, friend-discovery search — all deferred, separate sub-projects from the same decomposition.
- Any change to `docs/decisions/0001-message-content-never-in-postgres.md`'s scope — `contact_requests` stores only relationship metadata (user id pairs, status, timestamps), never message content or key material, consistent with `contacts`' existing constraint.

## Non-goals

- Making contacts anything other than symmetric once accepted — no "follow without being followed back" model.
- Persisting or replaying missed push frames through JetStream — these are durable-Postgres-backed state, not transient delivery; a missed live push is fully recovered by the next `GET`, unlike offline chat messages (ADR 0008).
