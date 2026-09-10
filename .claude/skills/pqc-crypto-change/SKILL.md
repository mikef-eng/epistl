---
name: pqc-crypto-change
description: Checklist for Kyber/Dilithium/Quinn/Better Auth changes. Use when editing apps/api crypto or auth code, or when reviewing those paths.
---

# PQC / crypto change checklist

Run this before opening or approving a PR that touches post-quantum crypto, transport security (Quinn), or auth (Better Auth RS).

## Checklist

- [ ] Crypto uses audited, version-pinned crates only — no hand-rolled Kyber/Dilithium or custom AEAD.
- [ ] Constant-time comparison for secrets, MACs, and signatures (no early-exit equality on secret data).
- [ ] No key material, session tokens, or plaintext in logs, traces, or error messages.
- [ ] Known-answer / test-vector coverage for new crypto paths.
- [ ] Auth changes do not weaken E2EE (server never needs message plaintext).
- [ ] Dependencies and versions recorded in `Cargo.toml` / lockfile intentionally.

## After the checklist

- Coder: fix gaps before opening the PR.
- `crypto-reviewer`: block merge until every item is satisfied or explicitly waived in the issue Notes with rationale.
