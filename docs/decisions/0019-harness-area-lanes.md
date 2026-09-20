# 0019: Area-lane harness replaces Coder → Tester → Reviewer

> **Amended by [0023](0023-staged-features-and-auto-merge.md):** `ci-watch` is removed; `merge-gate` arms auto-merge instead of waiting on CI, and multi-issue features stage on `feat/<slug>` before one gated PR into `main`.

## Context

The Planner → Coder → Tester → Reviewer pipeline worked, but transcript
analysis of real Claude Code sessions showed it was expensive and
redundant:

- Lead/orchestrator sessions consumed ~59% of cache-read tokens (longest
  session: 1,652 turns at ~360k tokens/turn).
- Each issue paid three full dispatches (~180 turns) that each re-fetched
  the issue body, diff, and CI status.
- `AGENTS.md` (~20 KB, four playbooks) was loaded into every agent on
  every turn; agent files and slash commands restated the same rules.
- Coders spent hundreds of turns polling CI (`gh run watch` / `sleep`)
  and re-running `gh issue view`.
- Native Claude Code features (`isolation: worktree`, `model`, `effort`,
  `maxTurns`, `skills` preload) were unused; ADR 0016 hand-rolled
  worktrees in the orchestrator instead.
- The `superpowers` plugin's session hook forced brainstorming /
  writing-plans ceremony onto harness/docs edits that should have been
  direct edits.

## Decision

Replace the four-role sequential pipeline with **area lanes**:

| Lane | Owns | Agent |
| --- | --- | --- |
| `api-dev` | `apps/api/**` | Implements + self-verifies one issue, opens PR |
| `mobile-dev` | `apps/mobile/**` (excl. native module glue) | Same |
| `native-dev` | `packages/quic-relay-client/**`, `packages/dev-setup/**`, `apps/mobile/modules/quic-relay-client/**` | Same |
| `ui` | Presentation-layer styling only | Hot-reload edits; no PR/CI |
| `ci-watch` | One blocking `gh run watch` | Never polls with `sleep` |
| `merge-gate` | Diff vs AC coverage table, scope, docs, crypto gate | Squash-merges when green |
| `planner` | Issue authoring | Unchanged role, tiered model |
| `crypto-reviewer` | Crypto/auth path review | Opus only; dispatched by merge-gate |

**Tester is folded**, not deleted: each lane agent owns TDD + a mandatory
`## Coverage` table in the PR body (one row per acceptance criterion →
test file::name). `merge-gate` verifies that table against the diff; it
does not re-derive coverage from scratch.

**Lead is a dispatcher.** `/ship` fetches each issue body once, routes by
title/path, dispatches lanes in background, then runs `ci-watch` →
`merge-gate` per PR. The lead never runs `adb`, `moon`, or reads source.
Sessions end with a `/clear` reminder so the orchestrator does not
accumulate 1,600-turn contexts.

**Context is scoped per lane.** `AGENTS.md` holds shared invariants only
(~50 lines). Lane knowledge lives in `.claude/skills/<lane>-conventions/`
and is preloaded only into that lane's agent.

**Labels shrink to what is read:** `planning`, `ready`, `blocked`, `bug`,
`backlog`. Dropped: `in-progress` (an open PR with `Closes #N` is
in-progress) and `needs-review` (PR review state covers it).

**Model tiering:** lane implementers and planner use sonnet; `ci-watch`
uses haiku; `crypto-reviewer` uses opus; `merge-gate` uses sonnet at low
effort.

**Parallelism:** mobile, native, and ui lanes may run concurrently.
`api-dev` lanes may also run concurrently now that per-worktree Postgres /
NATS isolation has landed (issue #219) — each worktree derives its own
database name and NATS stream from the worktree slug, so concurrent
`api:test` runs never collide.

**Ceremony:** harness/docs/config edits are made directly by the lead —
no brainstorm/plan. Spec/plan skills are reserved for product features
touching ≥3 files of new logic. The `superpowers` plugin is removed;
local copies of `test-driven-development` and `systematic-debugging`
are preloaded into lane agents instead.

**Worktree isolation:** lane agents set `isolation: worktree` in
frontmatter. ADR 0016's mechanical hand-rolling of worktrees by the
orchestrator is superseded. The shared-Postgres / NATS constraint from
ADR 0016 is resolved by issue #219 (per-worktree DB + stream names);
`/ship` may dispatch multiple `api-dev` lanes concurrently.

## Consequences

- Per-issue dispatches drop from 3 → 2 (lane + gate) plus a short haiku
  watcher.
- Shared context per turn shrinks; lane detail loads only where used.
- Orchestrator share of spend should fall substantially if sessions are
  cleared between batches.
- Mobile, native, ui, and (since issue #219) api lanes all parallelize.
- Anyone reading old docs that mention Coder/Tester/Reviewer should
  treat those names as historical; the live flow is in `AGENTS.md` and
  this decision.

## Addendum: chore lane

Harness / docs / CI / root-config work (`.claude/**`, `.github/**`,
`docs/**`, `*.md`, `.moon/**`, and root config such as `.gitignore`,
`docker-compose.yml`, `.env.example`) has no owning product lane. Before
this addendum, invariant 7 said those edits were "direct," but every
lane agent still required `Closes #N` and a Coverage table — so
orchestrator-owned work either invented a fake issue or contradicted
the agents. Issue #220's Notes hit this exactly: labeled `ready`, yet
required to be implemented "by the orchestrator/human directly, NOT by
a lane agent," with a `Harness:` title prefix that `/ship` cannot route.

**Decision:** formalize a `chore` lane owned by the orchestrator.
Chore PRs need no issue, no `Closes #N`, and no Coverage table; they
use `## Lane: chore` and `## Testing recommendation: non-logic`, then
`/gate`. They still go through a PR and CI so there is a revert point
and a green gate. Chore work never enters `/ship`.

## Enforcement

Lane agents (`api-dev` / `mobile-dev` / `native-dev`) cannot stop while
their PR is missing `## Coverage` (with ≥1 data row), `## Lane`, or
`## Testing recommendation`. A `SubagentStop` hook in
`.claude/settings.json` runs `.claude/hooks/require-coverage.sh` (matcher
`api-dev|mobile-dev|native-dev`). Exit code 2 blocks the stop and feeds
stderr back to the agent. Chore / ui / gate agents never match.
`merge-gate` still verifies that named Coverage tests actually exercise
the claimed acceptance criteria — the hook only enforces section
presence.
