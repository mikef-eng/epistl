---
name: native-conventions
description: Conventions for quic-relay-client, dev-setup, and the RN TurboModule glue. Preloaded into native-dev.
---

# Native lane conventions

## Scope

- `packages/quic-relay-client/**` — Rust/Quinn QUIC client crate
- `packages/dev-setup/**` — local onboarding CLI
- `apps/mobile/modules/quic-relay-client/**` — UniFFI-generated RN TurboModule glue

## Moon commands

```bash
moon run quic-relay-client:check
moon run quic-relay-client:lint
moon run quic-relay-client:test
moon run dev-setup:check
moon run dev-setup:lint
moon run dev-setup:test
```

`sccache` required on `PATH`. Shared Cargo workspace with `apps/api` — a lockfile bump may affect both.

## Gotchas

- Android/iOS native build bootstrap: see ADRs 0013 / 0014 and `docs/architecture/overview.md`.
- Prefer `Read`/`Grep`/`Glob`; absolute paths in Bash.
- Docs freshness for stack/env/run or bootstrap changes.
