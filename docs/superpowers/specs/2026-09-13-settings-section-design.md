# Settings section — design

Status: approved by user. Second of four sub-projects decomposed from a broader "less barebones app" feature request (sub-project A, mutual contacts, specced separately in `docs/superpowers/specs/2026-09-13-mutual-contacts-design.md`; C and D follow this one in the same pass).

## Context

`apps/mobile` has no settings screen, no persisted local preferences, and no theming system today — `ContactsScreen`/`ChatScreen`/etc. are the entire authenticated app surface, reached via a single native-stack navigator (`App.tsx`, `src/navigation/types.ts`) with no drawer or tab bar. There is also no log-out flow anywhere in the app — a real gap, arguably more basic than the theming request that prompted this sub-project.

## Decisions made during brainstorming

1. **Entry point: a gear icon in `ContactsScreen`'s header**, pushing a new `SettingsScreen` stack route. No new navigation pattern (drawer, tabs) is introduced — consistent with the app's current single-stack structure.
2. **Scope for this pass: appearance (dark mode), log out, notification preferences (inert placeholder), account info display, and delete account/data.** All five ship together as one coherent v1 rather than dark-mode-only.
3. **Non-sensitive preferences use a new `@react-native-async-storage/async-storage` dependency**, not `expo-secure-store` (reserved elsewhere in this app for actual secrets — tokens, key material). Theme/notification prefs don't need OS-keychain backing.
4. **Dark mode uses NativeWind v4's built-in `colorScheme` API** (already available via the existing `nativewind` dependency, no new package needed) rather than a hand-rolled theme context.

## Design

### Architecture & persistence

New `apps/mobile/src/screens/SettingsScreen.tsx`. `App.tsx` gains a `Settings: undefined` route in `RootStackParamList`; `ContactsScreen` gets a header-right gear icon (`navigation.navigate('Settings')`). A small `src/settings/preferences.ts` module wraps AsyncStorage reads/writes for the two persisted local prefs (theme choice, notification toggle), following the same "one small module, testable in isolation" pattern as `api/session.ts`.

Theme applies via `colorScheme.set('system' | 'light' | 'dark')` immediately on toggle in `SettingsScreen`, and is re-applied from the persisted value in `App.tsx` before the navigation tree renders (avoiding a flash of the wrong theme on cold start).

### Appearance

A 3-way control: System / Light / Dark. Selecting persists to `preferences.ts` and calls `colorScheme.set()` immediately for instant re-render. This is the only setting with any actual visual effect today; the app's existing Tailwind classes (`bg-white`, `text-black`, etc. throughout the current screens) will need `dark:` variants added where they don't already have sensible dark defaults — that pass is part of this sub-project's implementation, not deferred, since shipping a dark-mode toggle that doesn't actually darken most screens would be a broken feature, not a smaller one.

### Notifications (inert placeholder)

A single toggle, persisted via `preferences.ts`, explicitly **not wired to any actual notification behavior** — no push notification system (`expo-notifications`, APNs/FCM, server-side push) exists anywhere in this app. The UI must not imply the toggle currently does anything; label it clearly (e.g. a "coming soon" note under the toggle) rather than presenting it as a working control. This reserves the UI surface and the persisted preference for when real notification infrastructure is built as its own future sub-project — building the actual delivery mechanism is explicitly out of scope here.

### Account info

Read-only display of the logged-in user's email. `apps/mobile/src/api/session.ts` currently persists only the session token and user id (`SESSION_TOKEN_KEY`, `SESSION_USER_ID_KEY`); this adds `saveEmail`/`getEmail` (`SESSION_EMAIL_KEY`) following the exact same pattern, populated from `AuthResponse.user`'s email at `login`/`signup` success in `api/client.ts`.

### Log out

Does not exist anywhere in the app today. Adds `clearSession()` to `session.ts`, clearing the token, user id, and email keys together (one call, not three separate ones at each call site, to avoid a future caller forgetting one). `SettingsScreen`'s log-out button calls `clearSession()` then `navigation.reset({ index: 0, routes: [{ name: 'Login' }] })` — a reset, not a `navigate`, so the back button can't return to authenticated screens afterward.

Deliberately **does not** touch crypto identity (`crypto/identity.ts`), stored ratchet sessions (`crypto/session.ts`), or local chat history (`storage/messages.ts`) — those are tied to the device's cryptographic identity, not the auth session. Logging back in as the same user finds the same identity and message history intact, matching how this app already treats identity/history as device-local and session-independent.

### Delete account/data

Destructive; requires explicit confirmation (a type-the-email-to-confirm input or a double `Alert.alert` step — implementation's choice, not load-bearing for this spec) before any request is sent.

New endpoint: `DELETE /api/account` (`apps/api/src/`, module TBD by the Coder — likely alongside or near `auth.rs`), authenticated, deletes the caller's `users` row. `users` is owned by `better-auth`'s SeaORM store (`migrations/0001_create_users_table.sql`, reconciled in `0004_reconcile_better_auth_schema.sql`), but `contacts`, `user_keys`, and `sessions` all already declare `ON DELETE CASCADE` on `users(id)` — deleting the `users` row cascades through everything this app owns without any manual cleanup. Whether the Coder calls into `better-auth`'s own account-deletion capability (if the crate exposes one) or performs the delete directly via `sqlx` is an implementation choice; the requirement is only that the `users` row (and therefore its cascaded rows) is gone on success.

On **confirmed server-side success only** (never before, and never on failure — to avoid orphaning local crypto material against an account that still exists), the client performs a full local wipe, strictly more thorough than log out: session (as log out does) **plus** crypto identity (`crypto/identity.ts`), stored ratchet sessions (`crypto/session.ts`), and local chat history (`storage/messages.ts`) — there's no server-side account left to log back into, so nothing device-local should remain either.

### Error handling

`DELETE /api/account` failures surface an inline error on `SettingsScreen` and leave all local state untouched. Follows the existing typed `{"error": "<code>"}` response pattern used throughout `apps/api` (`contacts.rs`, `auth.rs`).

### Testing

- Mobile: `SettingsScreen` render/interaction tests (theme toggle persists and applies via `colorScheme`; log out resets nav and clears only session state; delete-account requires confirmation, calls the endpoint, and wipes local state only on success — verified via a mocked failure case leaving state untouched too). New `session.ts` tests for `saveEmail`/`getEmail`/`clearSession`. New `preferences.ts` tests for the two persisted prefs.
- API: a new integration test confirming `DELETE /api/account` requires authentication and correctly cascades (contacts, keys, sessions all gone for that user afterward).
- `npm run lint && npm run typecheck && npm test` for `apps/mobile`; `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test` for `apps/api`.

## Out of scope

- Building any real push-notification delivery mechanism — the notifications toggle is a persisted, inert placeholder only.
- Editing account info (email, password) — this pass is read-only display.
- A tab bar/drawer navigation restructure — Settings is reached via a single header icon on the existing stack.
- Per-conversation or per-contact settings (e.g. muting a specific chat) — sub-project C's territory if it comes up there.
- Any change to `docs/decisions/0001-message-content-never-in-postgres.md`'s scope, or to `crypto/session.ts`'s forward-secrecy invariant (per ADR 0009's existing carve-out) — the delete-account wipe calls `crypto/session.ts`'s existing storage functions from the outside; it does not change how ratchet state itself is derived or stored.

## Non-goals

- Making dark mode the default — System stays the default selection, matching platform convention.
- A settings-sync-across-devices story — preferences are local-device-only (AsyncStorage), same locality as the rest of this app's device-bound state.
