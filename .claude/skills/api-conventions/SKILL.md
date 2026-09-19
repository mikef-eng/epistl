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

- `DATABASE_URL` and `NATS_URL` required for integration tests. Per-worktree Postgres + NATS isolation (#219) allows multiple concurrent `api-dev` lanes — each worktree derives its own DB (`<base_db>_wt_<slug>`) and NATS stream automatically. The Postgres role must have `CREATEDB`.
- `sccache` must be on `PATH` (required project-wide).

## Per-worktree isolation

`moon run api:migrate` creates the worktree-specific database on demand (no manual setup). After a PR merges, run `moon run api:db-drop` to drop the current worktree's DB + NATS stream, or `moon run api:db-prune` to sweep all orphaned worktree databases at once. See `docs/architecture/overview.md` (Per-worktree isolation) for the derivation and `EPISTL_WORKTREE_SLUG` env var details.

## See also

`docs/architecture/overview.md` (Backend, NATS, Object storage, Local development). Shared invariants (docs freshness, tools) live in `AGENTS.md`.
