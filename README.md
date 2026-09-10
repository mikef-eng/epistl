# Epistl

Epistl is a cutting-edge chat platform. The long-term vision is a social hybrid between LinkedIn, Facebook, and Slack. The near-term goal is a solid end-to-end encrypted chat MVP.

## MVP goal

Ship quantum-resistant E2EE chat using CRYSTALS-Kyber and CRYSTALS-Dilithium, with a basic chat interface that includes a contacts list and the ability to add and manage contacts.

## Stack

| Layer | Choice |
| --- | --- |
| Monorepo | [moonrepo](https://moonrepo.dev) |
| Frontend | Expo + React Native (TypeScript) + expo-sqlite |
| Backend | Rust (Axum, tokio, Quinn) + Better Auth RS |
| Message broker | NATS JetStream |
| Primary DB | Postgres (auth and core app data) |
| Cold storage | ScyllaDB (chat history) |

Infra services (NATS, Postgres, Scylla) are documented here for orientation; they are not stood up in the harness phase.

## Repository layout

```
apps/
  mobile/   Expo + React Native client
  api/      Rust Axum API
packages/   Shared libraries (reserved)
```

## Development harness

Work is tracked through GitHub Issues and role handoffs (Planner → Coder → Tester → Reviewer). See [AGENTS.md](AGENTS.md) for conventions.

## Local commands

```bash
# Mobile (from apps/mobile)
npm run lint
npm run typecheck
npm test

# API (from repo root)
cargo test --manifest-path apps/api/Cargo.toml
cargo clippy --manifest-path apps/api/Cargo.toml -- -D warnings
cargo fmt --manifest-path apps/api/Cargo.toml -- --check
```
