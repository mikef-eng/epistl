# 0011: QUIC dev-cert TLS trust remains dev-only, interim, and revisitable

## Context

QUIC mandates TLS 1.3 unconditionally — unlike today's `ws://`, there is no
plaintext option. Issue #67's spike
(`docs/superpowers/specs/2026-09-13-quic-quinn-transport-design.md`) already
settled a dev-only posture for this during brainstorming (decision 2 in that
spec) and built it: `apps/api/examples/quic_echo_server.rs` (a throwaway
example server, not product code) generates a self-signed cert in memory at
startup, and `packages/quic-relay-client`'s `quic_ping` function trusts any
server certificate via its `DangerousDevOnlyCertVerifier`, both heavily
commented as spike-only shortcuts.

This planning batch is now building a **real** (non-throwaway) QUIC
listener in `apps/api` (a later issue in this batch) and a real mobile QUIC
driver, both intended to be exercised outside a one-off spike test screen.
Neither of those issues should have to re-derive or silently reinvent the
TLS trust posture the spike already proved out — but the spike's own spec
explicitly deferred "how the dev cert relates to a real deployment cert"
rather than designing it, since no deployment target exists yet
(`docs/superpowers/specs/2026-09-13-quic-quinn-transport-design.md`'s "what
happens after the spike" section). This ADR closes that gap for the real
listener and mobile client, without inventing a production cert-issuance
design that has nothing real to attach to yet.

## Decision

**Carry the spike's dev-cert posture forward unchanged into the real
listener and mobile client, explicitly as an interim decision, not a
durable one.**

- The real QUIC listener (`apps/api/src/quic.rs`, a later issue in this
  batch) generates a fresh self-signed TLS certificate in memory on every
  process start, via `rcgen` — the exact same pattern already used by
  `apps/api/examples/quic_echo_server.rs`'s `build_server_config`. The
  certificate is never persisted to disk, never committed to the repo, and
  is not backed by any product cert-issuance pipeline. This matches this
  repo's existing convention for dev-only, clearly-labeled non-secrets
  (e.g. `AUTH_SECRET`'s dev default in `.env.example`), except regenerated
  per process start rather than a fixed value, since nothing needs the QUIC
  listener's cert to be stable across restarts.
- The mobile QUIC client continues to trust any server certificate without
  verification — the same posture as `packages/quic-relay-client`'s
  existing `DangerousDevOnlyCertVerifier` (no chain check, no hostname
  check, no expiry check). This trust-any behavior **must remain gated to
  dev/debug builds only** (e.g. an `__DEV__`-equivalent build-config check
  on the mobile side, and/or a Cargo feature or debug-only compile path on
  the native-module side) and must never ship in a release build
  configuration. The real-listener and mobile-driver issues that consume
  this ADR are responsible for adding that gate explicitly — it does not
  exist yet, since the spike's crate had no release-build concept to gate
  against.

## Consequences

- This is explicitly a **deferred, interim decision, not a durable one**.
  It must be revisited — real CA-issued or pinned certificate on the
  server, real certificate chain/hostname verification on the client —
  once an actual deployment target or domain is chosen. **Concrete trigger
  condition:** the moment this project provisions a real domain name or
  deployment environment for `apps/api` (staging or production), a new
  issue must be opened to replace this dev-cert posture before QUIC is
  exposed on that deployment; until then, this ADR's posture stands
  unchanged. A future Planner should treat "a deployment target now exists"
  as the trigger to open that issue, rather than rediscovering this gap
  from scratch.
- The real-listener issue and the mobile-driver issue in this batch should
  cite this ADR instead of re-deriving the TLS trust story — this settles
  the decision first, so those issues build against a fixed point, the same
  sequencing this batch already used for ADR 0009 (TanStack Store/Query)
  ahead of its own implementation issues.
- No application code changes land in this ADR. The dev-only build-config
  gate on the mobile trust-any verifier, and the real listener's cert
  generation, are implemented by their own issues, not here.
- `README.md`'s Stack table (Transport row) links to this ADR so a reader
  scanning the stack sees the interim nature of the TLS trust story without
  having to find this file by name.
