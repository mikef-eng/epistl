# Security Policy

Epistl is a post-quantum end-to-end encrypted messenger. Please treat security reports carefully.

## Reporting a vulnerability

**Do not file crypto or security vulnerabilities as public GitHub issues.**

Use [GitHub private vulnerability reporting](https://github.com/mikef-eng/epistl/security/advisories/new) so the report stays private until a fix is ready.

If private reporting is unavailable for any reason, contact the repository owner directly through GitHub and ask for a secure channel before sharing details.

## Scope

In scope (non-exhaustive):

- `apps/api/src/crypto/**` — Kyber / Dilithium / session crypto
- `apps/api/src/auth/**` — Better Auth session handling
- `apps/mobile/src/crypto/**` — client-side crypto
- QUIC / Quinn transport and the relay (`packages/quic-relay-client/**`, `apps/api` relay paths)
- Auth, session, and key-handling paths that could weaken E2EE assumptions

Out of scope for private reporting (use ordinary issues instead):

- Feature requests and UX bugs with no security impact
- Dependency version nags without a demonstrated exploit path

## Status

This project is **pre-release / early development**. There is **no bug bounty**. We still appreciate responsible disclosure and will credit reporters who want it once a fix ships.

## Maintainer process

Internal changes to crypto/auth paths go through the `pqc-crypto-change` skill and `crypto-reviewer` sign-off before merge (see [AGENTS.md](AGENTS.md)).
