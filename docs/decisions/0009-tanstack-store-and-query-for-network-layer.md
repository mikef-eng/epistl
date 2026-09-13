# 0009: TanStack Store owns transport, TanStack Query owns server state

## Context

`apps/mobile` has no state-management library today — every screen holds
its own `useState`/`useEffect`, calls `client.ts`'s fetch functions or
`ws.ts`'s `createReconnectingChatSocket` directly, and wires callbacks
(`onMessage`, `onStatusChange`) by hand. That was tenable through the
walking skeleton, the E2EE batch, and the NATS offline-delivery batch, but
issue #11's QUIC/Quinn spike
(`docs/superpowers/specs/2026-09-13-quic-quinn-transport-design.md`)
changes the shape of the problem: once the spike succeeds, the app needs
to race a QUIC connection attempt against the existing WebSocket path and
hold "whichever transport is currently active" as real, shared state — not
something a single screen's `ref` can own, since which transport is live
can change independent of any one screen's lifecycle. This is a protocol/
architecture decision with real cost of change (it dictates the interface
every future screen sends through), not a routine implementation choice,
so it's recorded here rather than left to accrete ad hoc as the QUIC work
lands.

Separately, and for the same reason (issue #11's dual-stack work is about
to build directly on top of whatever the transport interface is), this is
also the right point to settle a caching/fetching pattern for the app's
actual server state (contacts, key registration) and local chat history,
which today are each hand-rolled per screen with no shared invalidation or
loading-state convention.

## Decision

**TanStack Store owns the transport lifecycle directly**, not just a thin
routing layer in front of the existing reconnect logic. A single store
(`apps/mobile/src/transport/store.ts`, exact path for a future Coder to
confirm against repo conventions) holds:

- `status: ConnectionStatus` (`'connecting' | 'connected' | 'reconnecting'
  | 'disconnected'`)
- `activeTransport: 'ws' | 'quic' | null`
- `lastFrame: IncomingFrame | null`

and exposes actions `connect(getToken)`, `send(frame)`, `close()`. The
store's actions absorb what `createReconnectingChatSocket`
(`apps/mobile/src/api/ws.ts`) does today — exponential backoff with
jitter, the `CLOSE_UNAUTHORIZED` (4001) terminal-close rule, fetching a
fresh token on every (re)connect attempt — rather than wrapping that
function as an external dependency. `ws.ts` narrows to just the transport
driver: `buildWsUrl`, `createChatSocket`, and the wire frame types — the
primitive the store's `connect`/`send` actions call into. Once issue #11's
spike succeeds and a real QUIC listener exists, a `quic.ts` driver plugs
into the same store the same way, and the store's `connect` action becomes
the place that races QUIC vs WS and sets `activeTransport` — a design
already anticipated, not detailed, by that spec's "what happens after the
spike" section.

Screens never hold a socket handle, a ref, or register `onMessage`/
`onStatusChange` callbacks. They call the store's `send(frame)` action and
subscribe to `status`/`activeTransport`/`lastFrame` via `useStore(store,
selector)`. A screen still filters `lastFrame` by its own concern (e.g.
`ChatScreen` checking `frame.from === contactUserId`) exactly as
`handleFrame` does today — the store knows about connection state, not
per-contact routing.

**TanStack Query owns server-state reads/writes, and also local chat
history.** `client.ts`'s fetch functions (`listContacts`, `addContact`,
`removeContact`, `registerKeys`) are unchanged; a new `src/queries/`
module wraps them as `queryFn`/`mutationFn`s: `useContactsQuery()`
(`queryKey: ['contacts']`), `useAddContactMutation()` /
`useRemoveContactMutation()` (invalidating `['contacts']` on success), and
`useRegisterKeysMutation()`. Local SQLite chat history
(`storage/messages.ts`'s `getMessages`) is also brought into Query as
`useMessageHistoryQuery(contactUserId)` (`queryKey: ['messages',
contactUserId]`); after each successful `saveMessage()` write (both the
outgoing-send and incoming-receive paths in `ChatScreen`), the caller
invalidates `['messages', contactUserId]` instead of manually splicing
`setMessages`. `login`/`signup` stay plain async calls from `LoginScreen`
— one-shot auth actions, not cached/re-fetchable server state, so wrapping
them in Query buys nothing.

**Explicitly excluded from both:** the Double Ratchet session state in
`crypto/session.ts` and the envelope encode/decode logic in
`ChatScreen.handleSend`/`handleIncomingEnvelope`. This is not a narrower
scoping choice made for convenience — it is a forward-secrecy invariant.
`session.ts` already documents `loadSession` → derive → `saveSession` as a
strict, sequential, fail-closed unit per message; a generic cache sitting
between two call sites (Query's or otherwise) risks serving a stale
ratchet state to a second consumer, which either breaks forward secrecy or
reuses a message key. This stays exactly as it is today: loaded and saved
explicitly at the single point of use, no caching layer involved, under
any future extension of this ADR.

## Consequences

- `apps/mobile/package.json` gains `@tanstack/react-store` and
  `@tanstack/react-query` as new dependencies — update the Stack table in
  `README.md` in the same PR that lands this (per the Docs freshness
  section of `AGENTS.md`).
- `createReconnectingChatSocket`'s existing tests
  (`api/__tests__/ws.test.ts`) move to test the transport store's actions
  instead of a standalone factory function — same backoff/jitter/
  terminal-close assertions, new home. `ChatScreen`'s tests keep asserting
  the same observable send/receive/status behavior, now wired through the
  store and Query hooks instead of refs and manually-managed component
  state.
- The `queue_unavailable` → `deliveryFailed` marking on a specific
  optimistically-sent message stays local `ChatScreen` UI state — it's
  per-message rendering, not transport or server state, so it does not
  move into the store or Query.
- A single `QueryClientProvider` wraps the app root (alongside the
  existing navigation root).
- This ADR settles the interface; it does not implement it. Landing it is
  its own Planner-issued batch, the same pattern as ADRs 0004/0005/0008
  each preceding their own implementation issues — not folded into issue
  #11's QUIC spike, which stays scoped to proving Quinn cross-compiles
  through `uniffi-bindgen-react-native` on a bare test screen, per
  `docs/superpowers/specs/2026-09-13-quic-quinn-transport-design.md`.
  That spec's own "what happens after the spike" section (the real
  dual-stack racing logic) is the point where this ADR's transport store
  actually gets consumed.
- A future Coder proposing to route ratchet/session state, or the
  envelope encode/decode step, through TanStack Query or Store is
  proposing a conflicting change to a forward-secrecy invariant and must
  raise it with the user first, the same as ADR 0001 requires for a
  literal Postgres `messages` table.
