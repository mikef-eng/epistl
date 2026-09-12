# Epistl

Epistl is a cutting-edge chat platform. The long-term vision is a social hybrid between LinkedIn, Facebook, and Slack. The near-term goal is a solid end-to-end encrypted chat MVP.

## MVP goal

Ship quantum-resistant E2EE chat using CRYSTALS-Kyber and CRYSTALS-Dilithium, with a basic chat interface that includes a contacts list and the ability to add and manage contacts.

## Stack

| Layer | Choice |
| --- | --- |
| Monorepo | [moonrepo](https://moonrepo.dev) |
| Frontend | Expo + React Native (TypeScript) + expo-sqlite + NativeWind (Tailwind) |
| Backend | Rust (Axum, tokio) + [`better-auth`](https://crates.io/crates/better-auth) (crate name is `better-auth`, **not** `better-auth-rs` — see `apps/api/Cargo.toml` for why) |
| Message broker | NATS JetStream (planned; not yet added — see [issue tracker](https://github.com/mikef-eng/epistl/issues) for the Quinn/QUIC and NATS stub issues) |
| Primary DB | Postgres (auth and core app data only — see [`docs/decisions/0001-message-content-never-in-postgres.md`](docs/decisions/0001-message-content-never-in-postgres.md)) |
| Cold storage | ScyllaDB (chat history backup; opt-in, not yet built — see [`docs/decisions/0002-scylla-backup-is-opt-in.md`](docs/decisions/0002-scylla-backup-is-opt-in.md)) |
| Transport | Quinn/QUIC (planned; API currently serves plain HTTP/WebSocket) |

Postgres is stood up and required for local development (see "Running the stack locally" below). NATS and ScyllaDB are documented here for orientation only — they are not yet stood up.

## Repository layout

```
apps/
  mobile/   Expo + React Native client
  api/      Rust Axum API
packages/   Shared libraries (reserved)
```

## Development harness

Work is tracked through GitHub Issues and role handoffs (Planner → Coder → Tester → Reviewer). See [AGENTS.md](AGENTS.md) for conventions and role playbooks, and [`docs/decisions/`](docs/decisions/) for durable architecture decisions.

## Claude Code

Root [CLAUDE.md](CLAUDE.md) imports [AGENTS.md](AGENTS.md). Agent tooling lives under `.claude/`:

- **Agents** — `planner`, `coder`, `tester`, `reviewer`, `crypto-reviewer`
- **Commands** — `/plan-issue`, `/work-issue`, `/test-pr`, `/review-pr`, `/ship`
- **Skills** — `open-task-issue`, `pqc-crypto-change`
- **Plugins** — root enables `superpowers@claude-plugins-official`; `apps/mobile` enables `expo@claude-plugins-official`

Postgres MCP and NATS channel plugins are deferred until those services are stood up.

## Running the stack locally

1. **Start Postgres** (from repo root):

   ```bash
   docker compose up -d
   ```

   This runs `postgres:16` on `localhost:5432` (user/password/db all `epistl`), with a named volume so data survives restarts.

2. **Set the API's required env vars.** The API refuses to start without both:

   | Var | Purpose | Example (local dev only) |
   | --- | --- | --- |
   | `DATABASE_URL` | Postgres connection string | `postgres://epistl:epistl@localhost:5432/epistl` |
   | `AUTH_SECRET` | `better-auth` session-signing key, must be ≥ 32 bytes | `dev-only-secret-do-not-use-in-prod-3234` |

3. **Run migrations** (from repo root, via [moon](https://moonrepo.dev) — install with `curl -fsSL https://moonrepo.dev/install/moon.sh | bash`, or see the [moon install docs](https://moonrepo.dev/docs/install) for other platforms):

   ```bash
   DATABASE_URL=postgres://epistl:epistl@localhost:5432/epistl \
     moon run api:migrate
   ```

4. **Run the API server** (listens on `0.0.0.0:3000`):

   ```bash
   DATABASE_URL=postgres://epistl:epistl@localhost:5432/epistl \
   AUTH_SECRET=dev-only-secret-do-not-use-in-prod-3234 \
     moon run api:dev
   ```

5. **Run the mobile app:**

   ```bash
   cd apps/mobile && npm install && cd ../..
   moon run mobile:start   # equivalent to: npm start (from apps/mobile)
   ```

   The client reads its API base URL from `EXPO_PUBLIC_API_URL`, defaulting to `http://localhost:3000` — fine for the iOS simulator or web on the same machine, but an Android emulator or physical device needs your machine's LAN IP instead, e.g. `EXPO_PUBLIC_API_URL=http://192.168.1.23:3000 moon run mobile:start`.

`api:dev` and `mobile:start` are long-running dev servers (moon's `persistent` task option) — each occupies its terminal until you stop it, same as running `cargo run`/`npm start` directly. `moon run` is otherwise a thin wrapper: `moon.yml` in each app just declares the same commands moon runs, so you can always fall back to invoking `cargo`/`npm` directly from that app's directory if you'd rather not use moon.

## Local commands

All check/lint/test tasks are defined once in each app's `moon.yml` (`apps/api/moon.yml`, `apps/mobile/moon.yml`) and run through [moon](https://moonrepo.dev) — from repo root, no need to `cd` into an app first:

```bash
# Mobile
moon run mobile:lint
moon run mobile:typecheck
moon run mobile:test

# API (requires Postgres running, see above — api:test depends on
# api:migrate, so migrations run automatically first)
moon run api:check    # cargo fmt --check
moon run api:lint     # cargo clippy -D warnings
moon run api:test
```

CI (`.github/workflows/ci.yml`) runs these same `moon run` tasks, so a green local run is a reliable predictor of a green CI run.
