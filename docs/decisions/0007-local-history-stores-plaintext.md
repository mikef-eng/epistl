# 0007: On-device SQLite history stores plaintext, not ciphertext

## Context

Issue #41 (`apps/mobile/src/crypto/envelope.ts` + `ChatScreen.tsx` wiring)
originally specified that `apps/mobile/src/storage/messages.ts`'s
`body_b64` column would keep storing the same bytes as the WS wire payload
— i.e. the encrypted envelope — for both outgoing and incoming messages,
with history reload (`getMessages`) "decrypting-on-load" by replaying
`session.ts`'s (issue #40) ratchet state machine against the stored
envelopes in order.

That turned out to be cryptographically unworkable, discovered mid-
implementation of issue #41:

- `deriveNextSendingMessageKey`/`deriveNextReceivingMessageKey` are
  stateful and consuming — each call advances the relevant chain key one
  step via `KDF_CK` and the old key is gone (`KDF_CK` is a one-way HMAC
  step; there is no way to "rewind"). This is forward secrecy working
  exactly as intended, not a bug.
- For **outgoing** messages specifically, this makes replay fundamentally
  impossible in the general case: the sender's own historical
  per-ephemeral-key chain state required to re-derive an
  already-superseded sending-chain message key is not retained anywhere
  once a later DH ratchet step (`dhRatchetStep`, which always generates a
  *fresh random* local keypair) has occurred. Signal-family apps never
  attempt this either — they store plaintext locally for exactly this
  reason.
- For **incoming** messages, a full "replay from scratch" is *partially*
  achievable in some cases (the responder's identity keys are stable) but
  calling `deriveNextReceivingMessageKey` again outside of live receipt
  either fails closed (out-of-order rejection) once the real persisted
  ratchet state has already moved past that message, or, if done naively
  against a fresh replay state, risks desynchronizing from what the
  actual persisted `RatchetState` (and the remote party) expects.

In short: Double Ratchet's forward secrecy means *no one* — not even the
original sender, and not the receiver either, once the ratchet has
advanced — can re-derive the key for an already-consumed message. Local
history storage cannot depend on being able to decrypt-on-demand from
ciphertext after the fact.

## Decision

`apps/mobile/src/storage/messages.ts`'s schema and exported
`saveMessage`/`getMessages` API are unchanged — this ADR does not revisit
0003's "opaque bytes blob" wire-format decision for the WS relay payload,
and does not add a column. What changes is the *content* `ChatScreen.tsx`
passes as `bodyB64` to `saveMessage()`: it is now the UTF-8 plaintext,
base64-encoded (`bytesToBase64(utf8ToBytes(plaintext))`), for both
directions:

- **Outgoing**: only after the real ciphertext envelope has actually been
  sent over the WS (so a failed/never-attempted send never persists a
  "sent" history row).
- **Incoming**: only after the live envelope has been successfully
  decrypted *and* its ML-DSA-65 signature verified via
  `apps/mobile/src/crypto/envelope.ts`'s decode functions — a
  verification failure is never persisted (there is no trustworthy
  plaintext to store); it renders only as an in-session, non-durable
  "could not be verified" UI state.

History reload (`getMessages` on mount) therefore just decodes the stored
base64 back to UTF-8 directly, with no `session.ts`/`envelope.ts`
involvement at all. Only *live* incoming envelopes, received over an
active WS connection while `ChatScreen` is mounted, go through the real
decrypt/verify path.

This is a deliberate, pragmatic MVP trade-off, consistent with how every
mainstream E2EE messenger (Signal included) handles local history: E2EE
protects message content in transit and from the server/relay operator,
not from the device's own legitimate owner. It is **not** a permanent
commitment to storing plaintext at rest forever — see Consequences.

## Consequences

- `docs/decisions/0001-message-content-never-in-postgres.md` is
  unaffected and still holds: the **server** (Postgres) never stores
  message content, encrypted or otherwise. This ADR is purely about the
  **client's own local SQLite**, a different trust boundary.
- `docs/decisions/0003-opaque-message-envelope.md` is unaffected and
  still holds for the **wire format**: the WS relay payload
  (`apps/api/src/ws.rs`) is still always the opaque encrypted envelope
  from `apps/mobile/src/crypto/envelope.ts` — this ADR does not touch
  what goes over the wire, only what `ChatScreen.tsx` chooses to persist
  locally after a message has already been sent or received-and-verified.
- `apps/mobile/src/storage/messages.ts`'s `bodyB64` column now holds
  plaintext at rest, unencrypted, protected only by whatever the OS
  keychain/filesystem sandboxing provides for the SQLite file itself
  (weaker than `expo-secure-store`, which backs `session.ts`'s ratchet
  state and `identity.ts`'s key material). A device compromise (lost/
  stolen unlocked phone, malware with filesystem access) exposes local
  message history in a way it would not if history were encrypted at
  rest with a device-bound key.
- Local-storage-at-rest encryption for this SQLite content (e.g. wrapping
  the DB, or encrypting `bodyB64` with a device-bound key before the
  `INSERT`) is explicitly left for a **future** ADR/issue if wanted — not
  required by issue #41. A future ADR may add it without reopening or
  contradicting this decision; it would layer on top of (not replace)
  storing plaintext-shaped content, similar to how full-disk/at-rest
  encryption layers under other messengers' local databases.
- Any future move to encrypt local history at rest, or to reintroduce a
  ciphertext-replay approach (e.g. if `session.ts` grows an explicit
  skipped/historical-key cache for some other reason — see ADR 0006's
  own out-of-scope note on `MKSKIPPED`), supersedes the relevant part of
  this decision via a new numbered ADR, not a silent change during an
  unrelated PR.
