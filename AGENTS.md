# Agent / contributor conventions

Epistl uses a controlled SDLC harness so humans and AI agents work through small, trackable issues instead of vibe-coding straight into the repo. See [`docs/decisions/0019-harness-area-lanes.md`](docs/decisions/0019-harness-area-lanes.md) for why this shape exists.

## Single source of truth

- Every unit of work is a **GitHub Issue** (exception: `chore` and `/ui` — see below).
- Nothing gets built without an issue (exceptions: `chore` harness/docs/CI PRs; `/ui` presentation-only hot-reload).
- Acceptance criteria are written **before** implementation starts, never after.
- Linear mirrors GitHub Issues for internal reporting only ([`docs/decisions/0015-...`](docs/decisions/0015-linear-primary-planning-github-synced-mirror.md)) — nobody authors workflow state in Linear.

## Area lanes

| Lane | Paths | Agent |
| --- | --- | --- |
| API | `apps/api/**` | `api-dev` |
| Mobile | `apps/mobile/**` (excl. `modules/quic-relay-client`) | `mobile-dev` |
| Native | `packages/quic-relay-client/**`, `packages/dev-setup/**`, `apps/mobile/modules/quic-relay-client/**` | `native-dev` |
| UI | Presentation layer only (screens/nav chrome/NativeWind) | `ui` |
| Chore | `.claude/**`, `.github/**`, `docs/**`, `*.md`, `.moon/**`, root config | orchestrator (direct PR) |
| Gate | Diff vs coverage table, scope, docs, merge | `merge-gate` (+ `ci-watch`, `crypto-reviewer` when needed) |
| Plan | Issue authoring | `planner` |

Flow: Planner opens issues (`planning` → `ready`) → `/ship` dispatches the matching lane → lane opens PR with `Closes #N` and a `## Coverage` table → `ci-watch` → `merge-gate` merges. Mobile, native, ui, and api lanes may run in parallel (per-worktree Postgres + NATS isolation; see issue #219).

**Chore route:** harness / docs / CI / root-config work skips `/plan-issue` and `/ship`. Open a branch, PR with `## Lane: chore` and `## Testing recommendation: non-logic`, then `/gate <pr#>`. No issue, no `Closes #N`, no Coverage table. Still gets a PR and CI so there is a revert point and a green gate.

## Labels

Two axes — apply **exactly one state** label, and zero or more **type** labels.

**State** (pipeline position):

| Label | Meaning |
| --- | --- |
| `backlog` | Untriaged or deferred; not currently being refined |
| `planning` | Being refined; not ready |
| `ready` | Clear enough for a lane agent |
| `blocked` | Waiting on a fix or decision (orthogonal flag) |

**Type** (what the issue is):

| Label | Meaning |
| --- | --- |
| `bug` | Defect against expected behavior |
| `feature-request` | Unvetted ask — somebody asked; not yet accepted |
| `enhancement` | Accepted feature work — we agreed to build it |

External bug reports arrive as `bug` + `backlog`; feature requests as `feature-request` + `backlog`. On triage the planner either promotes (`feature-request` → `enhancement`, state → `planning`; or a confirmed `bug` → `planning`) or closes. Do not treat `feature-request` and `enhancement` as synonyms.

An open PR with `Closes #N` means in-progress; PR review/CI state replaces the old `needs-review` label.

## Shared invariants (all roles)

1. Branch: `issue-<number>-<short-slug>` (e.g. `issue-42-login-form`). Chore branches use `chore-<short-slug>`.
2. Local checks via **moon only** (`moon run api:check` / `api:lint` / `api:test`, `moon run mobile:lint` / `mobile:typecheck` / `mobile:test`, etc.) — never raw `cargo`/`npm` as a substitute. Moon loads `.env`; do not `source .env` first.
3. Scope creep → new issue via `open-task-issue`; do not expand the current PR. Prefer state `backlog` when the spill is later-work.
4. **Docs freshness**: if a change alters the stack, how to run something, an env var, or an architectural constraint, update `README.md` (one-line) and put detail in [`docs/architecture/overview.md`](docs/architecture/overview.md) in the same PR. Durable decisions go in `docs/decisions/`.
5. **Crypto gate**: anything touching `apps/api/src/crypto/**`, `apps/api/src/auth/**`, or `apps/mobile/src/crypto/**` requires the `pqc-crypto-change` skill and `crypto-reviewer` sign-off before merge.
6. Never poll CI with `sleep` / repeated `gh pr checks`. Lane agents push and stop; `ci-watch` runs one blocking `gh run watch`.
7. **Ceremony proportional to diff.** Product work uses issues + Coverage. Harness / docs / CI / root-config (`.claude/**`, `.github/**`, `docs/**`, `*.md`, `.moon/**`, `.gitignore`, `docker-compose.yml`, `.env.example`) is the **chore** lane: direct PR by the orchestrator, no issue, no `Closes #N`, no Coverage table (`## Testing recommendation: non-logic` instead). Spec/plan only for product features touching ≥3 files of new logic.
8. Prefer `Read` / `Grep` / `Glob` over shell `cat` / `grep` / `find` / `sed`. Do not prefix every Bash call with `cd` — use absolute paths or the worktree cwd.
9. **TDD (iron law):** no production code without a failing test first for features, bug fixes, and behavior changes. Mechanics live in the `test-driven-development` skill. Bugs also run `systematic-debugging` (root cause) before the fix.

## Worktree recovery

Claude Code `isolation: worktree` creates trees under `.claude/worktrees/` (gitignored). A crashed/rate-limited lane can leave a **locked** tree that `git worktree prune` will not remove. Reap with:

```bash
git worktree unlock .claude/worktrees/<name>
git worktree remove --force .claude/worktrees/<name>
git worktree prune
# then delete ancestor-of-main debris branches if any:
git branch -D issue-<n>-<slug>   # only when it has zero unique commits vs main
```

`/ship` preflight must detect an existing `issue-<n>-*` branch or matching worktree and offer resume-or-reset before dispatching.

`/ship` also ends with a post-merge sync: `git pull --ff-only` on a clean `main`, then delete the merged issue's leftover local `issue-<n>-*` / `worktree-agent-*` branches (only when the PR is confirmed `MERGED`). `merge-gate` merges on GitHub only and never touches the local checkout.

## Architecture decisions

`docs/decisions/` holds durable choices that must not be silently contradicted. Check it before conflicting. Notable:

- [`0019-harness-area-lanes.md`](docs/decisions/0019-harness-area-lanes.md) — this harness
- [`0016-concurrent-subagents-require-isolated-worktrees.md`](docs/decisions/0016-concurrent-subagents-require-isolated-worktrees.md) — worktrees + shared Postgres constraint
- [`0021-ci-cost-trip-wire.md`](docs/decisions/0021-ci-cost-trip-wire.md) — if the CI cache fix doesn't drastically cut PR CI time, drop GitHub CI checks until outside PRs
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
| `.claude/hooks/` | SubagentStop Coverage gate (`require-coverage.sh`) for lane agents |
| `.claude/rules/` | Path-scoped rules (crypto/auth) |

Playbooks live in the agent files. Lane-specific moon commands and conventions live in the matching `*-conventions` skill, preloaded only into that lane.
