# `dev-setup`

A contributor/agent-facing CLI that checks a macOS/Linux dev machine against
what the root [`README.md`](../../README.md)'s "Running the stack locally"
section requires, and can optionally do the mechanical parts of that section
for you.

**Windows is unsupported.** The CLI exits with a clear error on any OS other
than macOS or Linux (issue #203) — Windows contributors should follow the
root README's manual steps directly.

## What it checks

On every run, `dev-setup`:

1. Copies `.env.example` to `.env` at the repo root if `.env` doesn't already
   exist (leaves an existing `.env` untouched).
2. Reports Present/Absent (with version, where available) for the tools the
   root README's "Running the stack locally" section requires: `rustup`,
   `cargo`/`rustc`, `node`, `moon`, `docker`, and `sccache`. Docker is checked
   via `docker info`, not just `docker --version`, so a present-but-not-running
   daemon is correctly reported Absent, not Present.
3. Exits non-zero if any *required* tool (everything except `sccache`, which
   is detect-only here) is Absent, so the exit code alone is a reliable
   "is this machine ready" signal for scripting.

None of the above ever installs anything or mutates your system beyond the
one safe `.env` copy above.

## Flags

`dev-setup` is detect-only by default. Every mutating action requires its own
explicit flag — no flag ever implies another:

- **`--install`** — OS-specific auto-install of missing required tools (see
  the macOS/Linux install-flow issues). Independent of `--start` below.
- **`--start`** — brings up the local dev stack:
  1. Runs `docker compose up -d` (targeting the repo root's
     `docker-compose.yml`, regardless of what directory you invoke
     `dev-setup` from).
  2. Waits for Postgres, NATS, and SeaweedFS to each report healthy (polling
     Docker's own computed health status per service — the same
     `pg_isready`/`wget .../healthz`/`curl .../cluster/status` checks
     `docker-compose.yml` already declares and
     [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) also runs),
     up to 30 seconds per service. A service that never reports healthy
     within that bound prints a clear, service-named failure message
     (e.g. `postgres did not become healthy within 30s -- check \`docker
     compose logs postgres\`.`) and stops there — later steps never run
     against a stack that isn't actually up.
  3. Runs `moon run api:migrate`.

  If Docker or moon was reported Absent by the checks above, `--start` is a
  no-op: it prints a clear explanatory message and does not attempt to shell
  out to either missing binary (or partially mutate anything — e.g. an absent
  `moon` means `docker compose up -d` is never run either). Without
  `--start`, `dev-setup` never runs `docker compose` or any migration
  command, under any circumstances.

## Running it

```bash
cd packages/dev-setup
cargo run                # detect-only
cargo run -- --start     # also brings up the stack + runs migrations
```

or, from the repo root, via moon:

```bash
moon run dev-setup:run              # detect-only
moon run dev-setup:run -- --start   # also brings up the stack + runs migrations
```

## What this doesn't do

- Start `moon run api:dev` or `moon run mobile:start` — those are long-running
  dev servers, not one-shot setup actions, and are intentionally out of scope
  for this tool.
- Anything on Windows.
- Change `docker-compose.yml` or the migration SQL themselves.

See the root [`README.md`](../../README.md)'s "Running the stack locally"
section for the full manual walkthrough (still the source of truth this tool
automates, and what Windows contributors should follow).
