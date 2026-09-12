# 0006: PQXDH session key derivation, fail-closed ratchet, and MVP trust model

## Context

[0005](0005-pqxdh-handshake-classical-ratchet.md) decided the overall
protocol shape — a PQXDH-style hybrid handshake feeding a classical Double
Ratchet — but left the concrete KDF constructions, domain-separation
strings, out-of-order handling, and prekey trust model unspecified. Issue
#40 (`apps/mobile/src/crypto/session.ts`, the handshake + ratchet state
machine) and issue #41 (the wire/byte envelope format and `ChatScreen.tsx`
wiring) both need to agree on these details without re-deriving them
independently. This ADR is written by #40's Coder and is explicitly meant
to be **extended, not re-litigated,** by whichever of #40/#41 lands second
— it covers only what #40 actually implements (session establishment and
the ratchet math); #41 should append its own wire-format section here
rather than opening a competing document.

## Decision

### KDF primitives

- **`KDF_RK(rootKey, dhOutput)`** — HKDF-SHA256 (`@noble/hashes/hkdf.js` +
  `@noble/hashes/sha2.js`), `hkdf(sha256, dhOutput, rootKey, KDF_RK_INFO, 64)`
  split into a new 32-byte root key and 32-byte chain key. `dhOutput` is
  the IKM, the current root key is the salt (both are secret; HKDF's salt
  argument does not need to be public, only non-attacker-controlled), and
  `KDF_RK_INFO` (`"epistl/v1/pqxdh/kdf_rk"`) is a fixed, non-secret
  domain-separation string distinguishing this call from any other HKDF
  call in the codebase using the same hash — not from the per-pair info
  string used once at handshake time (see below).
- **`KDF_CK(chainKey)`** — HMAC-SHA256 (`@noble/hashes/hmac.js` +
  `@noble/hashes/sha2.js`) with the fixed single-byte inputs `0x01`
  (next chain key) and `0x02` (message key), per the Double Ratchet
  spec's reference implementation notes
  (https://signal.org/docs/specifications/doubleratchet/).
- **Initial root key (`rootKey0`)** — derived once per handshake directly
  via `hkdf(sha256, concatBytes(dhOutput, kyberSharedSecret), undefined,
  infoBytes, 32)`, where `infoBytes = utf8("epistl/v1/pqxdh/root/" +
  lower + "/" + higher)` and `lower`/`higher` are the two parties'
  user ids sorted lexicographically. Sorting makes the info string
  symmetric: both the initiator and the responder compute the identical
  string regardless of who initiated, without needing a separate
  "am I Alice or Bob" flag. This IKM concatenates the classical X25519 DH
  output with the ML-KEM-768 shared secret, so `rootKey0` is
  post-quantum-safe even though everything derived from it afterward via
  `KDF_RK`/ratchet steps is only classically safe (accepted in 0005).
  After computing `rootKey0`, one `KDF_RK(rootKey0, dhOutput)` step (over
  the *classical* DH output only, not the Kyber shared secret again)
  produces the actual starting root key and initial sending/receiving
  chain — this keeps `rootKey0` from ever being used directly as a chain
  key, and reuses the same `KDF_RK` primitive the ongoing ratchet uses
  rather than a bespoke one-off construction.

### Fail-closed out-of-order handling

`deriveNextReceivingMessageKey` returns `{ rejected: true }` — never
throws — for a message whose `messageNumber` doesn't match the receiving
chain's expected next number, and leaves the caller's `state` untouched.
There is no Signal-style `MKSKIPPED` skipped-message-key cache in this
MVP: a message that arrives out of order (or is dropped) is simply
unreadable, not recoverable later. This is a deliberate simplification,
not an oversight, for two reasons:

1. `apps/api/src/ws.rs` is currently a stub for a future NATS-backed
   relay whose delivery-order and at-least-once/at-most-once
   characteristics are not yet fixed. Building skipped-key recovery
   against an unstable delivery model risks building it against the
   wrong assumptions and having to redo it once the relay is real.
2. Fail-closed is the safer default for a security-sensitive ratchet:
   silently buffering skipped message keys is additional stateful
   complexity (unbounded-ish growth, eviction policy, a new place for a
   key-material bug to hide) that a later issue can add deliberately,
   with its own acceptance criteria, once the relay's real delivery
   semantics are known — not something to bolt on speculatively now.

A future issue may add `MKSKIPPED`-style recovery once the relay's
delivery semantics are settled; that is a new issue, not a silent change
to this behavior.

### No OPK, no separate signed prekey

Full X3DH/Signal-style handshakes use a one-time prekey (OPK, consumed
and replaced per handshake) and a signed prekey that is distinct from,
and rotated independently of, the long-term identity key. This MVP uses
neither:

- No OPK — every handshake reuses the contact's currently-published
  X25519/Kyber keys from `user_keys` (issue #35) rather than consuming a
  single-use prekey. This trades away OPK's extra deniability/replay
  property for simplicity; revisiting it (server-side OPK pool,
  consumption/replenishment logic) is a new issue, not something to add
  incidentally here.
- No separate signed prekey — the "prekey" that gets Dilithium-signed
  (`PREKEY_SIGNATURE_CONTEXT`, issue #36) is the same long-lived
  X25519/Kyber identity keypair used for every handshake, not a
  shorter-lived, independently rotated prekey. This means there is
  currently no key rotation story beyond full re-registration of a
  device's identity.

Both are explicit, accepted MVP simplifications versus full X3DH — see
issue #40's Notes — not gaps to silently "improve" mid-implementation.

### TOFU-plus-signature trust (`verifyPrekeyBundle`)

`verifyPrekeyBundle` verifies that a contact's server-reported
`x25519PublicKey`/`kyberPublicKey` were signed by the Dilithium
`dilithiumPublicKey` the server also reports for that contact — i.e. the
three keys are cryptographically bound together and weren't tampered
with in transit or by a compromised server *after* the contact's first
key upload. It does **not** independently verify that the
`dilithiumPublicKey` itself genuinely belongs to the claimed contact: the
device trusts whatever identity key the server first reports for a given
user (trust-on-first-use), the same trust model Signal shipped for years
before adding out-of-band safety-number verification. `verifyPrekeyBundle`
returning `false` blocks session creation entirely (see issue #40); a
user-facing fingerprint/safety-number comparison UI to strengthen this
trust model further is out of scope for both #40 and #41 (issue #40's
Notes) and would be a new, separate issue.

## Consequences

- `apps/mobile/src/crypto/session.ts` implements exactly this: `KDF_RK`/
  `KDF_CK` as specified above, the `"epistl/v1/pqxdh/root/<lower>/<higher>"`
  domain-separated initial root derivation, fail-closed (not
  recovery-attempting) out-of-order rejection, and `verifyPrekeyBundle`
  as a TOFU-plus-signature check, not a full identity-verification
  mechanism.
- Issue #41 (wire/byte envelope format) should append its own section to
  this file covering envelope byte layout, AEAD choice, and how header
  fields (`dhPublicKey`/`previousChainLength`/`messageNumber`) are
  serialized, rather than opening a separate ADR — this document is
  explicitly meant to be extended by whichever of #40/#41 lands second.
- Any future move to add `MKSKIPPED`-style skipped-key recovery, a
  server-side OPK pool, independently-rotated signed prekeys, or
  out-of-band safety-number verification supersedes the relevant
  paragraph above via a new numbered ADR — not a silent change during an
  unrelated PR.
