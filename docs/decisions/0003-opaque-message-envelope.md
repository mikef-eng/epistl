# 0003: Message envelope is an opaque bytes blob, not typed plaintext

## Context

The MVP walking skeleton relays plaintext messages before real E2EE
(Kyber/Dilithium key exchange) exists. If the wire/storage format for a
message body is a typed plaintext string field, swapping plaintext for
real ciphertext later is a breaking wire-format and schema change across
the API contract, the relay, and the mobile client.

## Decision

Wherever a message body appears on the wire or in any future storage
(the WebSocket relay payload today; the opt-in Scylla backup schema and
any future durable-delivery queue payload later), it is carried as an
opaque bytes/base64 blob, never a typed plaintext string field — even
while the payload literally contains UTF-8 plaintext bytes during the
skeleton phase.

## Consequences

- Swapping plaintext bytes for real ciphertext bytes later requires no
  wire-format or schema change.
- Coders must not add a `body: String` (or similarly typed plaintext)
  field to any message-carrying struct, endpoint, or table — use bytes.
