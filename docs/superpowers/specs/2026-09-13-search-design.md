# Search — design

Status: approved by user. Fourth and final sub-project decomposed from a broader "less barebones app" feature request. Builds on sub-project A (mutual contacts, specced) and sub-project C (Conversations/Friends tabs, specced), both specced earlier in this same pass.

## Context

The original request bundled "search conversations" and "search for friends" together, but they turned out to be three distinct searches once separated: discovering new people to add (server-backed, currently an exact-email-only lookup in `AddContactScreen`), filtering an already-fetched friends list (purely local), and searching within conversations (local, currently no search at all). Each has a different data source and different privacy stakes, so each is designed separately below.

## Decisions made during brainstorming

1. **Discover search becomes partial/fuzzy match**, not exact-email-only — a real new server endpoint, not just UX polish on the existing flow. This has genuine privacy stakes (letting any authenticated user enumerate other users by email fragment), so mitigations are part of the design, not an afterthought.
2. **Search results don't send a request on tap.** Each result row has an explicit add button; tapping the row itself opens a new `UserProfileScreen` (relationship-status-aware) instead. This is a real, deliberate correction from an initial "tap to add" draft — the user wanted the send-a-request action to be an unambiguous, separate gesture from viewing someone.
3. **`UserProfileScreen` is scoped to search results only.** `FriendsScreen`'s existing tap-a-friend-opens-`Chat` behavior (sub-project C, already approved) is unchanged — this new screen doesn't retrofit that flow.
4. **Conversation search includes full-text search inside message content**, not just contact-identity matching — a real SQLite FTS5 schema addition, not a simple filter.
5. **Friends-list search stays a simple local filter** — no new endpoint, no privacy stakes (already-mutual relationships).

## Design

### Discover search

New endpoint `GET /api/users/search?q=<query>` (authenticated):
- Prefix-matches email: `WHERE email ILIKE $1 || '%'`, not substring — a smaller enumeration surface and friendlier UX than substring matching (typing "a" wouldn't surface everyone with an "a" anywhere in their email).
- Excludes the caller's own user id from results.
- Enforces a minimum query length (e.g. 3 characters) before running at all — the query simply returns empty/a `400` below that length, raising the cost of a trivial single-character enumeration sweep without eliminating the risk entirely.
- Bounds results (e.g. `LIMIT 20`).
- Returns only `user_id`/`email` — no relationship status. `AddContactScreen`'s existing send-request flow (sub-project A) already returns `409 already_contact` / `already_pending` / `incoming_request_exists`, so this endpoint doesn't need to pre-compute or leak that.
- Rate-limited: this repo has no rate-limiting layer today, so this is genuinely new infrastructure — a `tower::limit::RateLimitLayer` (or equivalent), scoped to just this route, consistent with the existing Axum/tower stack rather than introducing a new HTTP framework pattern. A rate-limited request returns `429 {"error": "rate_limited"}`.

**`AddContactScreen`** replaces today's single exact-email input with a search-as-you-type field. Each result row has two independent tap targets:
- An explicit **+ (add) button** — sends a request directly via sub-project A's existing `POST /api/contacts/requests`.
- **Tapping the row itself** — opens the new `UserProfileScreen` for that user (see below), rather than sending a request. This separation is deliberate: viewing someone and requesting them are different, explicit gestures.

**`UserProfileScreen`** (new): displays the user's email and a status-aware action area, driven by that pair's current relationship state (queried via sub-project A's `GET /api/contacts/requests` plus the existing `GET /api/contacts`, or a small dedicated lookup — implementation's choice):
- **Unconnected**: "Add friend" button → `POST /api/contacts/requests`.
- **Outgoing pending** (caller already requested them): "Request pending" with a cancel option.
- **Incoming pending** (they already requested the caller): "Accept" / "Decline" — same actions as `FriendsScreen`'s Requests section, just reachable from this second entry point too.
- **Already friends**: "Friends" label, no action (removal stays a `FriendsScreen`-only action per sub-project C, not duplicated here).

This screen reuses sub-project A's existing endpoints verbatim for every action — no new relationship-mutation logic anywhere in this sub-project.

### Conversation full-text search

`storage/messages.ts` gains a new SQLite FTS5 virtual table, `messages_fts`, kept in sync with `messages` via `INSERT`/`UPDATE`/`DELETE` triggers (FTS5 is present in the SQLite build `expo-sqlite` bundles). `ConversationsScreen` gains a search bar; as-you-typed queries run two checks in parallel — a substring match against contact email (from the already-merged `listContacts()` display data) and an FTS5 query against `messages_fts` — and the two result sets are unioned: a conversation appears if *either* its contact's email or any of its message content matches. Matched conversations render with their normal most-recent-message preview, not a query-highlighted snippet — sufficient for a first pass; snippet highlighting is a nice-to-have left for later if wanted.

### Friends-list filter

A simple search-as-you-type field on `FriendsScreen`, filtering the **Friends** section only (not Requests) by email substring against the already-fetched, already-in-memory contacts list. Purely client-side — no new endpoint, since filtering relationships you're already mutually connected to carries no enumeration risk.

### Error handling

`GET /api/users/search` follows the existing typed-`{"error": "<code>"}` pattern; a rate-limited call surfaces as an inline "try again in a moment" message, not a generic failure, so it reads as an expected throttle rather than a bug. `UserProfileScreen`'s actions reuse sub-project A's existing error handling and response shapes verbatim — no new error cases introduced.

### Testing

- API: new integration tests for `GET /api/users/search` — prefix matching (not substring), excludes the caller, respects the result limit, enforces the minimum query length, and triggers `429` under the new rate limit.
- Mobile: `storage/messages.ts` tests for `messages_fts` trigger sync (insert/update/delete all reflected) and query correctness (content matches surface the right `contact_user_id`). `ConversationsScreen`/`FriendsScreen` tests for both search bars (union logic for conversations; substring filter for friends). New `UserProfileScreen` tests covering all four relationship states and their respective actions/buttons.
- `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test` for `apps/api`; `npm run lint && npm run typecheck && npm test` for `apps/mobile`.

## Out of scope

- Search-result ranking beyond prefix-match order / most-recent-first (no relevance scoring, no typo-tolerance/fuzzy-edit-distance matching).
- Query-highlighted snippets in conversation search results.
- Any avatar/profile-picture system — `UserProfileScreen` shows email only; no photo upload/storage is introduced here.
- Blocking or reporting a user from `UserProfileScreen` — sub-project A's out-of-scope list already excludes this; unchanged here.
- Rate-limiting any endpoint other than the new search endpoint — existing endpoints (`login`, `add_contact`, etc.) are unchanged by this sub-project.

## Non-goals

- Making discover search a general user directory/browse feature — it only ever returns results for an active, minimum-length query; there is no "browse all users" surface.
- Persisting search history or recent-searches locally — each search is stateless from the client's perspective.
