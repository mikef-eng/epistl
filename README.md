# Epistl

Epistl is a cutting-edge chat platform. The long-term vision is a social hybrid between LinkedIn, Facebook, and Slack. The near-term goal is a solid end-to-end encrypted chat MVP.

## MVP goal

Ship post-quantum E2EE chat using CRYSTALS-Kyber and CRYSTALS-Dilithium (standardized by NIST as ML-KEM and ML-DSA), with a basic chat interface that includes a contacts list and the ability to add and manage contacts.

## Stack

| Layer | Choice |
| --- | --- |
| Monorepo | [moonrepo](https://moonrepo.dev) |
| Frontend | Expo + React Native (TypeScript) + expo-sqlite + NativeWind (Tailwind) + [`@noble/post-quantum`](https://www.npmjs.com/package/@noble/post-quantum) (pinned Kyber/ML-KEM and Dilithium/ML-DSA implementation) + [`@noble/curves`](https://www.npmjs.com/package/@noble/curves) (pinned X25519 implementation, same `paulmillr`-maintained suite) + [`@noble/ciphers`](https://www.npmjs.com/package/@noble/ciphers) (pinned XChaCha20-Poly1305 AEAD, same `paulmillr`-maintained suite, used by `apps/mobile/src/crypto/envelope.ts`'s message encryption) + [`@tanstack/react-store`](https://tanstack.com/store) (`apps/mobile/src/transport/store.ts` owns the chat relay's connection lifecycle — `status`/`activeTransport`/`lastFrame` state plus `connect`/`send`/`close` actions — per [`docs/decisions/0009-tanstack-store-and-query-for-network-layer.md`](docs/decisions/0009-tanstack-store-and-query-for-network-layer.md); WS-only for now, `@tanstack/react-query` is deferred to a later issue in that same batch) |
| Backend | Rust (Axum, tokio) + [`better-auth`](https://crates.io/crates/better-auth) (crate name is `better-auth`, **not** `better-auth-rs` — see `apps/api/Cargo.toml` for why) |
| Message broker | NATS JetStream, via [`async-nats`](https://crates.io/crates/async-nats) (the official `nats-io`-maintained Rust client, pinned in `apps/api/Cargo.toml`) — local dev requires the `nats` docker-compose service. On startup the API configures (or fetches, if already present) the `EPISTL_OFFLINE_MESSAGES` stream, a transient, short-TTL offline-delivery queue — see [`docs/decisions/0008-jetstream-transient-offline-queue.md`](docs/decisions/0008-jetstream-transient-offline-queue.md). A `/ws` `send` to a recipient who isn't currently connected is published to this stream (one subject per recipient, `epistl.offline.<user_id>`) instead of failing; on reconnect (or initial connect), `/ws` fetches and delivers everything queued for that user, in order, over the same live-relay frame shape, acking each only after it's actually been forwarded — so it's removed from the queue once delivered, not on any fixed timer |
| Primary DB | Postgres (auth and core app data only — see [`docs/decisions/0001-message-content-never-in-postgres.md`](docs/decisions/0001-message-content-never-in-postgres.md)) |
| Cold storage | ScyllaDB (chat history backup; opt-in, not yet built — see [`docs/decisions/0002-scylla-backup-is-opt-in.md`](docs/decisions/0002-scylla-backup-is-opt-in.md)) |
| Native module tooling | [`packages/quic-relay-client`](packages/quic-relay-client) (Rust crate wrapping [Quinn](https://crates.io/crates/quinn)) + [`uniffi-bindgen-react-native`](https://github.com/jhugman/uniffi-bindgen-react-native) (generates the RN TurboModule glue at `apps/mobile/modules/quic-relay-client`, a local, unpublished `file:` dependency of `apps/mobile`). Exposes two things: `quic_ping`, a one-shot async function (issue #67's spike, proving Quinn can be exposed to React Native as a real TurboModule at all) kept in place as a standalone dev-only smoke-test tool (`QuicSpikeScreen.tsx`); and `QuicConnection` (issue #75), a persistent-connection UniFFI object (`connect`/`send`/`close` plus a `QuicConnectionListener` callback interface for inbound frames/close notifications) that speaks `apps/api/src/quic.rs`'s real wire protocol for the lifetime of a chat session. Neither is adopted as product transport yet — no mobile code calls `QuicConnection` until its driver (a later issue in this batch) lands; see the Transport row below. |
| Transport | HTTP/WebSocket (`/ws`) is the API's default, always-on live-relay transport — this never changes regardless of the row below. A real (non-throwaway) Quinn-based QUIC listener also exists at `apps/api/src/quic.rs`, opt-in via the `QUIC_LISTEN_ADDR` env var (unset by default — see `.env.example`); when enabled it authenticates connections and relays messages through the same `ConnectionRegistry`/shared relay logic `/ws` uses, so cross-transport delivery works regardless of which transport the sender or recipient is connected over. QUIC is never required and is not the default in any environment. Its TLS trust story (self-signed dev cert generated fresh in memory per process start, no production cert-issuance pipeline) is a deliberately interim decision — see [`docs/decisions/0011-quic-dev-cert-trust-remains-dev-only.md`](docs/decisions/0011-quic-dev-cert-trust-remains-dev-only.md). The mobile client does not yet dial this listener (later issues in this batch); see also [`packages/quic-relay-client`](packages/quic-relay-client) (the Rust client side of that same protocol, not yet wired into any mobile screen). |

Postgres and NATS are stood up and required for local development (see "Running the stack locally" below). ScyllaDB is documented here for orientation only — it is not yet stood up.

## Repository layout

```
apps/
  mobile/   Expo + React Native client
  api/      Rust Axum API
packages/   Shared libraries
  quic-relay-client/   Rust/Quinn QUIC client crate (quic_ping spike + QuicConnection persistent-connection API; see Stack table)
```

## Development harness

Work is tracked through GitHub Issues and role handoffs (Planner → Coder → Tester → Reviewer). See [AGENTS.md](AGENTS.md) for conventions and role playbooks, and [`docs/decisions/`](docs/decisions/) for durable architecture decisions.

## Claude Code

Root [CLAUDE.md](CLAUDE.md) imports [AGENTS.md](AGENTS.md). Agent tooling lives under `.claude/`:

- **Agents** — `planner`, `coder`, `tester`, `reviewer`, `crypto-reviewer`
- **Commands** — `/plan-issue`, `/work-issue`, `/test-pr`, `/review-pr`, `/ship`
- **Skills** — `open-task-issue`, `pqc-crypto-change`
- **Plugins** — root enables `superpowers@claude-plugins-official`; `apps/mobile` enables `expo@claude-plugins-official`

Postgres MCP is configured in [`.mcp.json`](.mcp.json) (project-scoped, via [`crystaldba/postgres-mcp`](https://github.com/crystaldba/postgres-mcp) over Docker — connects to the local `docker compose` Postgres by default). A NATS channel plugin remains deferred — no such plugin was found in the official Claude Code marketplace as of this writing; revisit if one becomes available.

## Running the stack locally

1. **Set up your env file** (from repo root, one-time):

   ```bash
   cp .env.example .env
   ```

   `.env` is gitignored — see `.env.example` for what each var is for and which process consumes it. The defaults work as-is against the local docker-compose Postgres below; you only need to edit it if you want different values. Nothing else to do here: `docker compose` reads `.env` from this directory natively, and the API loads it itself via [`dotenvy`](https://docs.rs/dotenvy) on startup (walking up from wherever it's run from, so this works whether you invoke it from the repo root or from `apps/api`) — no manual `export`/`source` step needed.

2. **Start Postgres and NATS** (from repo root):

   ```bash
   docker compose up -d
   ```

   This runs `postgres:16` on `localhost:5432` (configured from your `.env`; defaults: user/password/db all `epistl`) and `nats:2-alpine` on `localhost:4222` (JetStream-enabled, monitoring on `8222`), each with a named volume so data survives restarts. (The `nats` service uses the `-alpine` tag rather than the bare `nats:2` tag purely so its healthcheck has a shell + `wget` to run against `8222`'s `/healthz` — it's still the same official `nats-io` image otherwise.)

3. **Run migrations** (via [moon](https://moonrepo.dev) — install with `curl -fsSL https://moonrepo.dev/install/moon.sh | bash`, or see the [moon install docs](https://moonrepo.dev/docs/install) for other platforms):

   ```bash
   moon run api:migrate
   ```

4. **Run the API server** (listens on `0.0.0.0:3000`; refuses to start unless `DATABASE_URL`, `AUTH_SECRET`, and `NATS_URL` — all in your `.env` — resolve to a value; also configures the `EPISTL_OFFLINE_MESSAGES` JetStream stream at startup, using `OFFLINE_QUEUE_MAX_AGE_SECS` from your `.env` if set, otherwise defaulting to 24 hours; optionally also starts a real QUIC listener alongside `/ws` if `QUIC_LISTEN_ADDR` is set in your `.env` — see the Transport row in the Stack table above):

   ```bash
   moon run api:dev
   ```

5. **Run the mobile app:**

   ```bash
   cd apps/mobile && npm install && cd ../..
   moon run mobile:start   # equivalent to: npm start (from apps/mobile)
   ```

   The client reads its API base URL from `EXPO_PUBLIC_API_URL`, defaulting to `http://localhost:3000` — fine for the iOS simulator or web on the same machine, but an Android emulator or physical device needs your machine's LAN IP instead. Expo's CLI auto-loads `apps/mobile/.env` (see `apps/mobile/.env.example`) the same way `docker compose` and the API auto-load the root `.env` — copy it and set `EXPO_PUBLIC_API_URL` there rather than exporting it inline each time.

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

# packages/quic-relay-client (Rust/Quinn QUIC client crate -- see the Stack table)
moon run quic-relay-client:check
moon run quic-relay-client:lint
moon run quic-relay-client:test
```

CI (`.github/workflows/ci.yml`) runs these same `moon run` tasks, so a green local run is a reliable predictor of a green CI run.
