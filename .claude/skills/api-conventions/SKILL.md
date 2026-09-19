---
name: api-conventions
description: Conventions and moon commands for apps/api (Rust Axum). Preloaded into api-dev.
---

# API lane conventions

## Moon commands (from repo root; moon loads `.env`)

```bash
moon run api:check    # cargo fmt --check
moon run api:lint     # cargo clippy -D warnings
moon run api:test     # depends on api:migrate; needs Postgres
moon run api:migrate
moon run api:dev      # long-running
```

Never substitute raw `cargo`. Never `source .env` first.

## Layout

- `apps/api/src/` — modules (`auth`, `contacts`, `relay`, `quic`, `push`, `avatars`, …)
- `apps/api/src/crypto/**` and `apps/api/src/auth/**` — crypto gate; follow `pqc-crypto-change`
- Migrations via `moon run api:migrate` / `apps/api/src/bin/migrate.rs`
- Shared Cargo workspace with `packages/quic-relay-client` and `packages/dev-setup` (root `Cargo.toml` / `Cargo.lock`)

## Gotchas

- `DATABASE_URL` and `NATS_URL` required for integration tests. Shared local Postgres — only one `api-dev` lane at a time (until #219 lands).
- `sccache` must be on `PATH` (required project-wide).

## See also

`docs/architecture/overview.md` (Backend, NATS, Object storage, Local development). Shared invariants (docs freshness, tools) live in `AGENTS.md`.
