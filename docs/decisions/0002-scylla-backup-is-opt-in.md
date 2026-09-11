# 0002: ScyllaDB backup is opt-in only

## Context

The stack table lists ScyllaDB as "cold storage" for chat history. Read
literally, that implies the server automatically backs up every user's
messages by default — which contradicts
[0001](0001-message-content-never-in-postgres.md)'s intent of not being a
durable message store unless the user explicitly asks for it.

## Decision

`expo-sqlite` on-device storage is the default and only place message
history durably lives. ScyllaDB backup is a separate, explicitly **opt-in**
feature a user turns on (e.g. "back up my chat history"). It is not part of
the core messaging path and is not built as part of the walking-skeleton
MVP.

## Consequences

- No Scylla writes happen from the default send/receive path.
- The opt-in backup feature is its own future issue/batch: it needs its own
  design (what's stored, encrypted how, retention, opt-out/delete).
- `README.md`'s stack table should describe Scylla as opt-in backup, not
  default cold storage, once that feature exists.
