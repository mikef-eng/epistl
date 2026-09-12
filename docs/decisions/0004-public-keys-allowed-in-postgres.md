# 0004: Public keys (Kyber/Dilithium) are allowed in Postgres

## Context

[0001](0001-message-content-never-in-postgres.md) establishes that message
**content** — plaintext today, ciphertext once E2EE lands — must never be
durably stored server-side. E2EE planning (issue #35, superseding stub
issue #14) needs a `user_keys` table so a sender can look up a contact's
public Kyber/Dilithium keys before encrypting to them. Without an explicit
decision here, this boundary gets re-litigated every time a Coder or
Reviewer touches key-storage code, asking whether storing keys server-side
contradicts 0001.

## Decision

**Public** keys (Kyber/ML-KEM public keys, Dilithium/ML-DSA public keys,
and any future public key material used for E2EE) are explicitly allowed
in a durable Postgres table, alongside users/contacts/sessions.

This does not weaken 0001. A public key is not message content and is not
sensitive in the way a private key or a message body is: it is safe to
hand to anyone, including an attacker — its entire purpose is to be given
out so others can encrypt to (or verify signatures from) its owner. A
server holding a directory of public keys is standard practice for
asynchronous E2EE key exchange (Signal's server does the same for prekeys)
and does not give the server any ability to read message content.

**Private** keys are never sent to, or stored on, the server, full stop.
They live only on-device (see issue #36 — `expo-secure-store`).

## Consequences

- `apps/api` may have a `user_keys` (or similarly named) Postgres table
  and REST endpoints to publish/look up public keys, without that being
  treated as a conflicting architecture change or needing sign-off beyond
  the normal PR review + `crypto-reviewer` gate for anything touching
  `apps/api/src/auth/**` or `apps/api/src/crypto/**`.
- A Coder or Reviewer must still verify that only public key material
  lands in this table — a private key field (Kyber secret key, Dilithium
  secret key, or any other private key material) appearing in a request
  body destined for this table, or in the table's schema, is a 0001-style
  architecture violation and must be raised before implementing, not
  built.
- This does not authorize storing message content, private keys, or any
  other sensitive material in Postgres — 0001 still applies to those in
  full.
