---
paths:
  - apps/api/src/crypto/**
  - apps/api/src/auth/**
  - apps/mobile/src/crypto/**
---

# Crypto / auth path rules

- No custom crypto primitives. Use audited, pinned crates for Kyber, Dilithium, and related primitives.
- Never log secrets, keys, tokens, or message plaintext.
- Before opening a PR that changes these paths, run the `pqc-crypto-change` skill.
- Reviewer must obtain `crypto-reviewer` sign-off before merge.
