# Agent / contributor conventions

Epistl uses a controlled SDLC harness so humans and AI agents work through small, trackable issues instead of vibe-coding straight into the repo. See [`docs/decisions/0019-harness-area-lanes.md`](docs/decisions/0019-harness-area-lanes.md) for why this shape exists.

## Single source of truth

- Every unit of work is a **GitHub Issue**.
- Nothing gets built without an issue (exception: `/ui` presentation-only hot-reload — see that agent).
- Acceptance criteria are written **before** implementation starts, never after.
- Linear mirrors GitHub Issues for internal reporting only ([`docs/decisions/0015-...`](docs/decisions/0015-linear-primary-planning-github-synced-mirror.md)) — nobody authors workflow state in Linear.

## Area lanes

| Lane | Paths | Agent |
| --- | --- | --- |
| API | `apps/api/**` | `api-dev` |
| Mobile | `apps/mobile/**` (excl. `modules/quic-relay-client`) | `mobile-dev` |
| Native | `packages/quic-relay-client/**`, `packages/dev-setup/**`, `apps/mobile/modules/quic-relay-client/**` | `native-dev` |
| UI | Presentation layer only (screens/nav chrome/NativeWind) | `ui` |
| Gate | Diff vs coverage table, scope, docs, merge | `merge-gate` (+ `ci-watch`, `crypto-reviewer` when needed) |
| Plan | Issue authoring | `planner` |

Flow: Planner opens issues (`planning` → `ready`) → `/ship` dispatches the matching lane → lane opens PR with `Closes #N` and a `## Coverage` table → `ci-watch` → `merge-gate` merges. At most **one** `api-dev` lane runs at a time (shared local Postgres); mobile/native/ui may run in parallel.

## Labels

| Label | Meaning |
| --- | --- |
| `planning` | Being refined; not ready |
| `ready` | Clear enough for a lane agent |
| `blocked` | Waiting on a fix or decision |
| `bug` | Defect against expected behavior |
| `backlog` | Idea not ready for Planner yet |

An open PR with `Closes #N` means in-progress; PR review/CI state replaces the old `needs-review` label.

## Shared invariants (all roles)

1. Branch: `issue-<number>-<short-slug>` (e.g. `issue-42-login-form`).
2. Local checks via **moon only** (`moon run api:check` / `api:lint` / `api:test`, `moon run mobile:lint` / `mobile:typecheck` / `mobile:test`, etc.) — never raw `cargo`/`npm` as a substitute. Moon loads `.env`; do not `source .env` first.
3. Scope creep → new issue via `open-task-issue`; do not expand the current PR.
4. **Docs freshness**: if a change alters the stack, how to run something, an env var, or an architectural constraint, update `README.md` (one-line) and put detail in [`docs/architecture/overview.md`](docs/architecture/overview.md) in the same PR. Durable decisions go in `docs/decisions/`.
5. **Crypto gate**: anything touching `apps/api/src/crypto/**`, `apps/api/src/auth/**`, or `apps/mobile/src/crypto/**` requires the `pqc-crypto-change` skill and `crypto-reviewer` sign-off before merge.
6. Never poll CI with `sleep` / repeated `gh pr checks`. Lane agents push and stop; `ci-watch` runs one blocking `gh run watch`.
7. Ceremony proportional to diff: harness/docs/config edits are direct edits (no brainstorm/plan). Spec/plan only for product features touching ≥3 files of new logic.
8. Prefer `Read` / `Grep` / `Glob` over shell `cat` / `grep` / `find` / `sed`. Do not prefix every Bash call with `cd` — use absolute paths or the worktree cwd.

## Architecture decisions

`docs/decisions/` holds durable choices that must not be silently contradicted. Check it before conflicting. Notable:

- [`0019-harness-area-lanes.md`](docs/decisions/0019-harness-area-lanes.md) — this harness
- [`0016-concurrent-subagents-require-isolated-worktrees.md`](docs/decisions/0016-concurrent-subagents-require-isolated-worktrees.md) — worktrees + shared Postgres constraint
- [`0015-linear-primary-planning-github-synced-mirror.md`](docs/decisions/0015-linear-primary-planning-github-synced-mirror.md) — GitHub primary, Linear mirror

Full list under [`docs/decisions/`](docs/decisions/).

## Issue template

Use the Task template via `open-task-issue`. Required: Goal, Acceptance criteria, Out of scope, Notes.

## Claude Code layout

| Path | Purpose |
| --- | --- |
| `.claude/agents/` | `planner`, `api-dev`, `mobile-dev`, `native-dev`, `ui`, `ci-watch`, `merge-gate`, `crypto-reviewer` |
| `.claude/commands/` | `/plan-issue`, `/ship`, `/gate`, `/ui` |
| `.claude/skills/` | Lane conventions, `open-task-issue`, `pqc-crypto-change`, TDD, debugging, PR coverage table |
| `.claude/rules/` | Path-scoped rules (crypto/auth) |

Playbooks live in the agent files. Lane-specific moon commands and conventions live in the matching `*-conventions` skill, preloaded only into that lane.
