# 0005: E2EE protocol is a PQXDH-style handshake over a classical Double Ratchet

## Context

Issue #38 (part of the batch superseding stub issue #14) needs an actual
session/envelope protocol for encrypting chat messages, not just raw
per-message Kyber encapsulation. Two designs were considered:

1. **PQXDH-style hybrid handshake + classical Double Ratchet** — the same
   shape Signal shipped in production in 2023: a hybrid (classical +
   post-quantum) key agreement establishes the initial session secret,
   then the well-studied classical Double Ratchet (X25519 DH ratchet +
   symmetric-key KDF chains) derives per-message keys going forward.
2. **Fully post-quantum ratchet** — replace the DH ratchet step itself
   with fresh KEM encapsulation every message, so every message's forward
   secrecy (not just the initial handshake) resists a future quantum
   adversary who recorded today's traffic.

Option 2 is more research area than production practice: continuous
KEM-based ratcheting doesn't have the same algebraic self-ratcheting
property that Diffie-Hellman gives the classical Double Ratchet, no
mature/independently-audited library implementing it was found at the
quality bar of the libraries already pinned in issue #36, and it would
mean maintaining materially novel protocol code in-house with no
production track record to lean on. It also costs meaningfully more
per-message overhead (a full KEM ciphertext, ~1088 bytes for ML-KEM-768,
versus a 32-byte X25519 DH share, each direction, every message).

## Decision

Use **option 1**: a PQXDH-style hybrid handshake for initial session
establishment, then the classical Double Ratchet for ongoing messages.

- **Handshake (once per new session between two contacts):** combine an
  X25519 ECDH exchange with an ML-KEM-768 (Kyber) encapsulation to derive
  the initial root key, the same hybrid shape as Signal's PQXDH. Identity
  and prekeys are signed with ML-DSA-65 (Dilithium) — already pinned in
  issue #36 — so a party fetching a contact's prekeys from the server
  (issue #35's `user_keys` table) can verify they weren't tampered with
  in transit or by a compromised server.
- **Ongoing messages:** the standard classical Double Ratchet (X25519 DH
  ratchet steps + symmetric-key KDF chains) derives a fresh key per
  message, giving forward secrecy and post-compromise security using the
  same proven construction Signal runs in production today.
- **Libraries:** `@noble/post-quantum` (ML-KEM/ML-DSA, already pinned in
  issue #36) for the post-quantum half; `@noble/curves` (confirmed to
  export `x25519`, same `paulmillr`-maintained audited suite, matching
  version generation as of this writing) for the classical half. No new,
  differently-maintained crypto library family is introduced.

This is an explicit, informed tradeoff: the initial session-establishment
secret is post-quantum-safe, but individual ratcheted per-message keys
are derived through classical X25519 DH steps and are not individually
quantum-safe against a future adversary who recorded the ratchet's public
DH shares over the wire. This matches what Signal — the most scrutinized
production E2EE protocol in general use — actually ships today; a fully
quantum-safe ratchet remains an open research problem, and building one
from scratch for Epistl without independent audit was judged a worse risk
than adopting this well-studied hybrid design.

## Consequences

- Issue #38 implements this specific shape, not raw per-message KEM
  encapsulation with no ratchet, and not a from-scratch fully-PQ ratchet.
- `apps/mobile/package.json` gains `@noble/curves` alongside the
  `@noble/post-quantum`/`@noble/ciphers`/`@noble/hashes` family from
  issue #36, pinned to a specific version, documented the same way issue
  #17 documented its `better-auth` crate choice.
- If a mature, independently-audited fully-post-quantum ratchet
  construction becomes available later and the project wants to close
  the classical-ratchet gap, that is a new decision superseding this one
  (a new numbered ADR), not a silent change mid-implementation.
- A Coder or Reviewer on #38 should treat "the ratchet steps are
  classical, not individually quantum-safe" as a known, accepted
  limitation of this design — not a bug to silently "fix" by inventing a
  different ratchet construction, and not something to omit from the
  PR description.
