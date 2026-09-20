# 0022: Notification preview decrypts on-device from shared Double Ratchet state

## Context

Pushes are content-free: `{"type":"message","fromUserId":"<uuid>"}` (ADR
0001, 0003). To show a message preview, a non-main process (iOS Notification
Service Extension, Android background FCM handler) must decrypt on-device.
That needs (a) the ciphertext and (b) the Double Ratchet session state
(ADR 0005/0006), which today lives in `expo-secure-store` visible only to the
main app process.

## Decision

Option 1 (owner decision, issue #173): decrypt in the extension using shared
session state and a single-envelope authenticated fetch.
**Option 2 (best-effort decrypt with generic-body fallback) is rejected**: it
would still need the ciphertext and state to be reachable and would leave the
"when does it work" behavior unspecified.

1. **Ciphertext source.** The extension performs an authenticated fetch of
   the one queued envelope for `fromUserId`, using credentials kept in shared
   storage (endpoint: #249). The push payload is unchanged and never carries
   plaintext, ciphertext or envelope bytes.
2. **Session-state sharing.** Ratchet state (and the contact Dilithium public
   keys and credentials needed to verify/fetch) live in the iOS App Group
   container / Android shared storage. Both processes use the single
   `SessionStore` interface in `apps/mobile/src/crypto/notificationDecrypt.ts`
   (implementation: #250).
3. **Concurrency.** Every read-modify-write runs under a per-contact
   cross-process `Lock` and uses a per-contact monotonic `generation`
   integer: read `{state, generation}` under the lock, decode, then
   `write(state', expectedGeneration)` as an atomic compare-and-set that
   bumps generation by one. A stale write is rejected (`state_conflict`) and
   never overwrites newer state. Together, lock plus CAS mean neither process
   can advance the same ratchet step twice or leave divergent chain keys
   (belt and braces: the lock prevents the race, the CAS detects a lock that
   expired under a stalled holder). The generation counter was chosen over a
   state hash because it is cheap and trivially orderable. Lock timeout
   defaults to 5 s: short enough for the NSE's ~30 s budget (with fetch and
   decrypt still to run) and long enough for the main app's brief critical
   sections. Lock implementations must expire stale holders.
4. **Envelope handling.** On a successful extension decrypt, the advanced
   ratchet state and the plaintext keyed by message id are written in one
   atomic operation. The main app's later receive of that message id looks up
   the stored plaintext (`getDecrypted`) and treats it as delivered rather
   than decoding again (which would be rejected as out-of-order, since the
   ratchet has already moved). Chosen over "leave the state unadvanced and
   re-decrypt in-app" because the ratchet keys are single-use (no skipped-key
   store, ADR 0005): the extension cannot both show a preview and leave the
   state untouched. The stored plaintext is subject to ADR 0007 (local
   history is plaintext); the main app moves it into the message database
   and deletes the shared-store record after ingest.
5. **iOS NSE limits.** The NSE has a ~24 MB memory ceiling and ~30 s. The
   Kyber/Dilithium path here is one ML-DSA-65 signature verification, an
   X25519/HKDF chain step and XChaCha20-Poly1305 decrypt (ratchet envelopes,
   0x03, use no Kyber decapsulation). **Unmeasured: verify on device in the
   iOS sibling issue**; this PR is pure TypeScript and has no device
   measurement. First-message handshake envelopes (0x02) are reported as
   `unsupported_envelope` and left for the main app since they need static
   keys not shared with the extension.
6. **Failure behavior.** Any failure (`no_session`, `fetch_failed`,
   `lock_timeout`, `corrupt_envelope`, `unsupported_envelope`,
   `decrypt_failure`, `state_conflict`, `storage_error`) yields a generic
   notification body. Nothing is persisted on failure, so the queued
   envelope is untouched and the main app receives it normally. The function
   never throws for normal failures.

## Consequences

- Session state and contact keys must move out of `expo-secure-store`
  (main-app-only) into shared storage; main-app session load/save must go
  through the same store, lock and generation (follow-up wiring, #250).
- Shared storage widens the exposure of ratchet secrets to the extension
  process; it must remain inside the app's own sandbox group.
- Crypto-reviewer sign-off is required (touches `apps/mobile/src/crypto/**`).
