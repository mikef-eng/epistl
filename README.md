# Epistl

Epistl is a cutting-edge chat platform. The long-term vision is a social hybrid between LinkedIn, Facebook, and Slack. The near-term goal is a solid end-to-end encrypted chat MVP.

## MVP goal

Ship post-quantum E2EE chat using CRYSTALS-Kyber and CRYSTALS-Dilithium (standardized by NIST as ML-KEM and ML-DSA), with a basic chat interface that includes a contacts list and the ability to add and manage contacts.

## Stack

| Layer | Choice |
| --- | --- |
| Monorepo | [moonrepo](https://moonrepo.dev) |
| Build tooling | [`sccache`](https://github.com/mozilla/sccache) (required for every Rust build, local or CI) |
| Frontend | Expo + React Native (TypeScript), Drizzle (on-device SQLite), NativeWind, post-quantum crypto via [`@noble`](https://www.npmjs.com/package/@noble/post-quantum) |
| Backend | Rust (Axum, tokio), [`better-auth`](https://crates.io/crates/better-auth) |
| Message broker | NATS JetStream |
| Primary DB | Postgres (auth + core app data only — no message content) |
| Cold storage | ScyllaDB (chat history backup; opt-in, not yet built) |
| Object storage | SeaweedFS (S3-compatible) for avatar images |
| Native module tooling | [`packages/quic-relay-client`](packages/quic-relay-client) (Rust/Quinn) |
| Transport | QUIC (default), WebSocket fallback |

See [`docs/architecture/overview.md`](docs/architecture/overview.md) for the full rationale, wiring, and file-level pointers behind every row above, and [`docs/decisions/`](docs/decisions/) for the durable decisions behind each choice.

## Repository layout

```
apps/
  mobile/   Expo + React Native client
  api/      Rust Axum API
packages/   Shared libraries
  quic-relay-client/   Rust/Quinn QUIC client crate
  dev-setup/            Dev environment setup CLI (macOS/Linux) -- see below
```

## Development harness

Work is tracked through GitHub Issues and **area lanes** (planner → api/mobile/native/ui → ci-watch → merge-gate). See [AGENTS.md](AGENTS.md) for the lane table and shared invariants, and [`docs/decisions/0019-harness-area-lanes.md`](docs/decisions/0019-harness-area-lanes.md) for the decision. Other durable decisions live under [`docs/decisions/`](docs/decisions/).

Lane agents use Claude Code's `isolation: worktree` (shared Postgres still limits concurrent API lanes — see ADR 0016/0019).

## Claude Code

Root [CLAUDE.md](CLAUDE.md) imports [AGENTS.md](AGENTS.md). Tooling lives under `.claude/` (lane agents, `/ship` `/gate` `/plan-issue` `/ui`, skills — see AGENTS.md). Postgres MCP is in [`.mcp.json`](.mcp.json).

## Running the stack locally

**Recommended fast path (macOS/Linux):** from a fresh machine (or anytime), run the two-stage bootstrap:

```bash
bash packages/dev-setup/bootstrap.sh            # interactive install + offer to start stack
bash packages/dev-setup/bootstrap.sh --yes --start --skip-mobile   # non-interactive, API-focused
bash packages/dev-setup/bootstrap.sh --check    # detect-only report
```

Stage 1 (`bootstrap.sh`) installs base build packages, rustup, and sccache, then hands off to the Rust CLI (Stage 2) for Node/fnm, moon, Docker, `.env` files, optional Android/iOS toolchains, and `docker compose` + migrations. See [`packages/dev-setup/README.md`](packages/dev-setup/README.md) and [`docs/decisions/0020-dev-setup-two-stage-bootstrap.md`](docs/decisions/0020-dev-setup-two-stage-bootstrap.md).

Windows isn't supported by `dev-setup` — Windows contributors, and anyone who wants to understand each step, should follow the manual steps below instead.

1. **Install [`sccache`](https://github.com/mozilla/sccache)** (one-time, required before your first Rust build):
   ```bash
   cargo install sccache --locked
   ```
2. **Set up your env file** (one-time, from repo root):
   ```bash
   cp .env.example .env
   # If the API runs on the host (normal), set SEAWEEDFS_INTERNAL_ENDPOINT=http://localhost:8333
   ```
3. **Start Postgres, NATS, and SeaweedFS**:
   ```bash
   docker compose up -d
   ```
4. **Run migrations** (via [moon](https://moonrepo.dev) — install with `curl -fsSL https://moonrepo.dev/install/moon.sh | bash`):
   ```bash
   moon run api:migrate
   ```
5. **Run the API server**:
   ```bash
   moon run api:dev
   ```
6. **Run the mobile app**:
   ```bash
   cd apps/mobile && npm install && cd ../..
   moon run mobile:start
   ```

Steps 5-6 start long-running dev servers that occupy their terminal.

For the reasoning behind each step (why `sccache` is required, the SeaweedFS internal/external endpoint gotcha, env var details, and the full Android/iOS native-build bootstrap walkthrough), see [`docs/architecture/overview.md`](docs/architecture/overview.md#local-development-environment).

## Local commands

All check/lint/test tasks are defined once in each project's `moon.yml` and run through [moon](https://moonrepo.dev) — from repo root, no need to `cd` into a project first:

```bash
# Mobile
moon run mobile:lint
moon run mobile:typecheck
moon run mobile:test
moon run mobile:db-generate   # regenerate drizzle-kit migrations after changing apps/mobile/src/storage/schema.ts

# API (requires Postgres running — api:test depends on api:migrate)
moon run api:check    # cargo fmt --check
moon run api:lint     # cargo clippy -D warnings
moon run api:test

# packages/quic-relay-client and packages/dev-setup (Rust)
moon run quic-relay-client:check
moon run quic-relay-client:lint
moon run quic-relay-client:test
moon run dev-setup:check
moon run dev-setup:lint
moon run dev-setup:test
```

All Rust commands above require [`sccache`](https://github.com/mozilla/sccache) on `PATH` (see "Running the stack locally", step 1) — without it they fail immediately with an "executable `sccache` not found" error.

CI (`.github/workflows/ci.yml`) runs these same `moon run` tasks, so a green local run is a reliable predictor of a green CI run. See [`docs/architecture/overview.md`](docs/architecture/overview.md) for anything not covered here.

## Contributing

Epistl is in early development and is **not accepting pull requests** at this time. Bug reports and feature requests via GitHub Issues are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Please report security issues privately via [SECURITY.md](SECURITY.md).

## License

Epistl is licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (AGPL-3.0-only). Because the relay is network-facing, AGPL §13 applies: this public repository is the corresponding source for any publicly offered instance.
