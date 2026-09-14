# 0012: Mobile local SQLite storage uses Drizzle (expo-sqlite driver) going forward

## Context

`apps/mobile/src/storage/messages.ts` (issue #29, extended by #93) accesses
its on-device SQLite database via hand-written SQL strings against
`expo-sqlite` directly, with schema evolution handled by an ad hoc
`PRAGMA table_info`-based idempotency guard rather than a real migration
system.

This is a real gap relative to the backend: `apps/api` uses `sqlx`, whose
`query!`/`query_as!` macros validate every query against the live Postgres
schema at Rust compile time and which has a proper migration system
(`apps/api/migrations/`). The mobile TypeScript side gets none of that —
raw SQL strings have zero compile-time validation against the schema, and
there is no formal migration tooling to reach for, hence the hand-rolled
guard.

`drizzle-orm` ships an official `expo-sqlite` driver plus `drizzle-kit` for
schema migrations, directly closing both gaps (type-safe query building
validated against a schema definition, and a real migration system) without
the tradeoffs a full ORM would carry on the *backend* side (see the
discussion that prompted this ADR: the backend's `sqlx` already provides
compile-time-checked queries and an existing migration system, so an ORM
there would be a lateral, costly move — this ADR is scoped to mobile local
storage only and does not propose changing `apps/api`).

## Decision

New mobile local-storage code is written against `drizzle-orm`'s
`expo-sqlite` driver, with schema changes made via `drizzle-kit` migrations,
not hand-written `ALTER TABLE`/`PRAGMA` guards.

Existing raw-SQL code in `apps/mobile/src/storage/messages.ts` is not
rewritten by this ADR — that is deferred to a follow-up planned issue. This
ADR only fixes the direction for what's written next; the follow-up issue
reworks what already exists to match it.

## Consequences

- A new dependency, `drizzle-orm` (plus `drizzle-kit` as a dev dependency),
  is added to `apps/mobile` — to be wired up in the follow-up
  implementation issue, along with the corresponding README Stack table
  update.
- `apps/mobile/src/storage/messages.ts`'s existing schema, queries, and its
  `ensureReadAtColumn` migration guard remain raw-SQL/`expo-sqlite` until
  the follow-up issue migrates them to Drizzle — this ADR does not itself
  change any code, only the direction for what comes next.
- Any new mobile local-storage module (or new tables/columns added to the
  existing one) after this ADR lands should be written with Drizzle from
  the start rather than adding to the raw-SQL pattern.
- This ADR does not apply to the backend (`apps/api`), which keeps `sqlx`
  for its own Postgres queries — see the Context section for why an ORM
  swap there is a separate, not-recommended, question.
