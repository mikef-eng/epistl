# Friends & conversations management UX — design

Status: approved by user. Third of four sub-projects decomposed from a broader "less barebones app" feature request. Builds directly on sub-project A's mutual-contacts relationship model (`docs/superpowers/specs/2026-09-13-mutual-contacts-design.md`, specced and merged, not yet implemented) and sits alongside sub-project B (settings section, specced same pass).

## Context

Today the app's entire post-login surface is `ContactsScreen`: a flat, alphabetical-by-add-order list of contacts with no last-message preview, no unread indicator, and no distinction between "people I know" and "conversations I'm having." There is no `conversations` concept in the data model at all — `storage/messages.ts`'s `messages` table is keyed only by `contact_user_id`, with no metadata beyond direction/body/timestamp. Sub-project A adds pending friend requests, which need somewhere to surface. This sub-project settles both: a real Conversations surface, and a Friends management surface distinct from it.

## Decisions made during brainstorming

1. **A bottom tab bar (`Conversations`, `Friends`) becomes the new post-login home**, replacing `ContactsScreen` as the landing screen — a genuine navigation restructure, not a single added screen (contrast with sub-project B's single header-icon addition). Conversations (recent-activity-sorted, with previews) and Friends (management: add, remove, requests) are different-enough concerns to be permanent peers, not one screen with the other one tap away.
2. **Sub-project A's pending requests surface inside the Friends screen** (a "Requests" section above "Friends"), not a separate screen.
3. **Unread-message tracking is in scope for this pass** — a new `read_at` column on the local `messages` table, marked read when a contact's `ChatScreen` mounts ("read on open," not scroll-based).
4. **Cross-spec consistency with sub-project B**: B placed the Settings gear icon in `ContactsScreen`'s header. Since that screen's role changes here, the gear icon moves to both new tabs' headers, navigating to the same `Settings` screen (which sits outside the tab navigator, on the root stack).

## Design

### Navigation structure

`App.tsx`'s `RootStackParamList` gains a `Main: undefined` route (a nested `Tab.Navigator` with `Conversations` and `Friends` tabs), which replaces `Contacts` as `initialRouteName` after login. `Chat`, `AddContact`, and `Settings` remain root-stack screens pushed on top of `Main`, reachable from either tab — not nested inside the tab navigator, so navigating to `Chat` or `Settings` from either tab behaves identically (a normal stack push over the tabs, not a tab-local navigation). `ContactsScreen.tsx` is retired in favor of `FriendsScreen.tsx` (see below); `RootStackParamList`'s `Contacts: undefined` entry is removed.

### Conversations screen & data model

`storage/messages.ts` changes:
- `messages` gains a nullable `read_at TEXT` column (SQLite has no native boolean; `NULL` = unread, a timestamp = read — consistent with this table's existing `TEXT`-for-timestamps convention).
- New `markContactMessagesRead(contactUserId: string): Promise<void>` — sets `read_at = <now>` on all `direction = 'incoming' AND read_at IS NULL` rows for that contact.
- New `getConversationSummaries(): Promise<ConversationSummary[]>` — one row per `contact_user_id`, with that contact's most recent message (`bodyB64`, `createdAt`, `direction`) and whether any unread incoming message exists, ordered by most-recent `createdAt` descending. Implemented as a grouped/windowed SQL query (exact query shape is the Coder's choice) rather than fetching all rows and grouping in JS, since this table can grow large over a device's lifetime.

Messages are already stored as plaintext locally (`docs/decisions/0007-local-history-stores-plaintext.md`), so building a preview snippet needs no decryption — a direct read of the summary row's `bodyB64` (already base64-of-UTF8-plaintext, same decode `ChatScreen` already does for history rows).

**Read semantics**: `ChatScreen` calls `markContactMessagesRead(contactUserId)` once, after loading that contact's history on mount (alongside its existing `getMessages` call) — "read on open," the simplest and most common pattern, not scroll-position-based.

`ConversationsScreen.tsx` (new) merges `getConversationSummaries()` with contact emails from `listContacts()` (matched by `contact_user_id`), rendering each row with email, a truncated preview of the last message, a relative timestamp, and bold/dot unread styling when that contact's summary reports unread. **A contact with no message history does not appear in this list at all** — Conversations shows conversations, not contacts; a not-yet-messaged friend is reached only via the Friends tab, exactly like today's contacts-list-opens-chat flow.

### Friends screen, requests, and removal

`FriendsScreen.tsx` replaces `ContactsScreen.tsx` (evolves its existing `listContacts`/loading/error/refresh scaffolding rather than being written from scratch) with two sections:
- **Requests** (rendered only when non-empty): incoming pending requests from sub-project A's `GET /api/contacts/requests`, each with Accept/Decline actions calling that sub-project's `POST /api/contacts/requests/{id}/accept|decline`; outgoing pending requests shown read-only as "Pending."
- **Friends**: today's accepted-contacts list, unchanged in its keys-readiness gating (`hasFullKeyBundle`) and tap-to-open-chat behavior. Each row gains a remove action (swipe-to-delete or long-press context menu — implementation's choice, not load-bearing) calling sub-project A's now-mutual `DELETE /api/contacts/{user_id}`.

"Add contact" moves from `ContactsScreen`'s current header button to `FriendsScreen`'s header, otherwise unchanged (still navigates to `AddContactScreen`, itself updated per sub-project A to the request-flow semantics).

### Error handling

Request accept/decline and friend removal follow the existing typed-`ApiError`/inline-message pattern already used throughout `ContactsScreen`/`AddContactScreen`. A failed removal or accept/decline leaves local state unchanged — no optimistic mutation that has to be rolled back — matching `ChatScreen`'s existing failure-doesn't-mutate convention (`deliveryFailed` marking, not a silent local success).

### Testing

- `storage/messages.ts`: new tests for `getConversationSummaries()` (correct per-contact grouping, correct sort order, correct unread detection across mixed read/unread rows) and `markContactMessagesRead()` (only affects incoming+unread rows for the target contact, leaves other contacts' rows untouched).
- `ConversationsScreen.tsx` / `FriendsScreen.tsx`: render/interaction tests — empty states (no conversations yet; no friends yet), unread styling present/absent, accept/decline updates the Requests section, remove updates the Friends section.
- `ChatScreen.tsx`: one new test confirming mount calls `markContactMessagesRead` for that contact.
- Tab-navigator wiring covered by this repo's existing navigation-integration test patterns (no new pattern introduced).
- `npm run lint && npm run typecheck && npm test` for `apps/mobile`.

## Out of scope

- Group conversations / multi-party chat — this app's messaging model stays strictly 1:1, unchanged by this sub-project.
- Message-level read receipts visible to the *other* party (e.g. "seen" indicators shown to the sender) — `read_at` here is purely local, device-side state for the reader's own unread badge, never transmitted.
- Blocking/reporting a friend — sub-project A's out-of-scope list already excludes this; unchanged here.
- Search (conversations or friends) — sub-project D, specced separately, next in this same pass.
- Muting or per-conversation settings — noted as a possible future extension in sub-project B's spec, not built here.

## Non-goals

- Deriving the Conversations list from anything server-side — per ADR 0001, message content never reaches Postgres, so this list is, and must remain, built entirely from local SQLite plus the existing `listContacts()` call for display metadata (email).
- Retrofitting `read_at` semantics onto sub-project A's contact-request notifications (those are a separate, already-designed accepted/pending/declined state machine, not a message to be "read").
