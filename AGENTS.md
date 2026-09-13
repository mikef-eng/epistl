# Agent / contributor conventions

Epistl uses a controlled SDLC harness so humans and AI agents work through small, trackable issues instead of vibe-coding straight into the repo.

## Single source of truth

- Every unit of work is a **GitHub Issue**.
- Nothing gets built without an issue.
- Acceptance criteria are written **before** implementation starts, never after.

## Roles and handoffs

| Role | Responsibility |
| --- | --- |
| **Planner** | Breaks the goal into small tasks; opens issues with clear goal, acceptance criteria, and out of scope. Labels `planning`, then `ready` when unambiguous. |
| **Coder** | Implements **one** `ready` issue at a time. Creates a branch, opens a PR that closes the issue. Extra discoveries become new issues — not scope on the current branch. |
| **Tester** | Runs CI, adds tests for acceptance criteria when missing, checks the PR against criteria line by line. Failures → PR comment + `blocked`. Pass → `needs-review`. |
| **Reviewer** | Final pass on quality, security, conventions, and scope. Merge only when CI is green and criteria are met. |

## Labels

| Label | Meaning |
| --- | --- |
| `planning` | Issue is being refined; not ready for implementation |
| `ready` | Clear enough for the Coder |
| `in-progress` | Actively being implemented |
| `blocked` | Waiting on a fix or decision |
| `needs-review` | Tester passed; awaiting Reviewer |
| `bug` | Defect against expected behavior |
| `backlog` | Idea not ready for Planner/Coder yet |

Flow: `planning` → `ready` → `in-progress` → (`blocked` \| `needs-review`) → merge/close.

## Planner playbook

1. Intake the goal (MVP slice, bug cluster, or newly discovered work). Do not implement anything.
2. Break the goal into small, independent-ish tasks (aim for under a day of work each).
3. For each task, open a GitHub issue using the Task template via the `open-task-issue` skill. Required sections: Goal, Acceptance criteria, Out of scope, Notes.
4. Label each new issue `planning`.
5. Self-review every acceptance criterion: it must be concrete and testable. "Add login" is bad. "User can log in with email/password; invalid credentials show an error; session persists on refresh" is good.
6. Flip an issue to `ready` only when a Coder could implement it without asking a clarifying question.
7. Re-run this playbook after every merged milestone or when new work is discovered. Never invent mid-sprint scope for the Coder.

## Coder playbook

1. Read **only** the assigned issue — do not load the whole backlog into context.
2. Confirm the issue is labeled `ready` (or switch it to `in-progress` if you are starting work).
3. Create a branch named `issue-<number>-<short-slug>` (e.g. `issue-42-login-form`).
4. Implement **only** that issue's scope. Prefer TDD (red → green → refactor) when tests are part of the acceptance criteria.
5. If you notice extra work, open a new issue via the `open-task-issue` skill — do not expand this branch.
6. If the change alters the stack, how to run something, an env var, or an architectural constraint, update the relevant section of `README.md` in the same PR — see "Docs freshness" below.
7. Open a PR that references the issue with `Closes #<number>`.
8. Keep the issue labeled `in-progress` until Tester finishes.

## Tester playbook

1. Confirm CI is green (lint, build, test) for the PR.
2. Run the local suite if needed: mobile `npm run lint && npm run typecheck && npm test` from `apps/mobile`; API `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test` for `apps/api`.
3. Verify **each** acceptance criterion on the linked issue line by line — not just "does it run."
4. Add tests for acceptance criteria when none exist and they are reasonably testable in this PR.
5. On failure: comment on the PR with specifics and set the issue label to `blocked`.
6. On pass: set the issue label to `needs-review`.

## Reviewer playbook

1. Confirm CI is green and the Tester has set `needs-review`.
2. Re-read the issue acceptance criteria against the PR diff.
3. Check scope: nothing beyond the issue landed; discoveries should already be separate issues.
4. Check conventions against this file and the repo's existing patterns.
5. Check docs freshness: if the diff changes the stack, how to run something, an env var, or an architectural constraint, `README.md` must be updated in the same PR. Block merge if it isn't — see "Docs freshness" below.
6. If the diff touches `apps/api/src/crypto/**` or `apps/api/src/auth/**`, run the `crypto-reviewer` subagent (or the `pqc-crypto-change` skill) and do **not** approve without its sign-off.
7. Merge only when CI is green and criteria are met. Prefer squash merge; delete the branch after merge.

## Docs freshness

`README.md` must stay accurate as the system grows — it's the first thing a human or agent reads. A PR is **not** done if it changes any of the following without updating the matching README section:

- The stack (new dependency, service, or library) → update the Stack table.
- How to run or configure something (new env var, new local command, new setup step) → update Local commands / setup instructions.
- An architectural constraint (data flow, storage boundaries, protocol choices) → update the relevant section and, if it's a durable decision, add or update a file in `docs/decisions/`.

Coder updates the docs in the same PR; Reviewer blocks merge if they're stale relative to the diff.

## Architecture decisions

`docs/decisions/` holds short, durable architecture decisions that must not be re-derived or silently contradicted by a future Coder or Planner. Check it before making a conflicting choice. Current decisions:

- [`docs/decisions/0001-message-content-never-in-postgres.md`](docs/decisions/0001-message-content-never-in-postgres.md)
- [`docs/decisions/0002-scylla-backup-is-opt-in.md`](docs/decisions/0002-scylla-backup-is-opt-in.md)
- [`docs/decisions/0003-opaque-message-envelope.md`](docs/decisions/0003-opaque-message-envelope.md)
- [`docs/decisions/0004-public-keys-allowed-in-postgres.md`](docs/decisions/0004-public-keys-allowed-in-postgres.md)
- [`docs/decisions/0005-pqxdh-handshake-classical-ratchet.md`](docs/decisions/0005-pqxdh-handshake-classical-ratchet.md)
- [`docs/decisions/0006-pqxdh-session-key-derivation.md`](docs/decisions/0006-pqxdh-session-key-derivation.md)
- [`docs/decisions/0007-local-history-stores-plaintext.md`](docs/decisions/0007-local-history-stores-plaintext.md)
- [`docs/decisions/0008-jetstream-transient-offline-queue.md`](docs/decisions/0008-jetstream-transient-offline-queue.md)
- [`docs/decisions/0009-tanstack-store-and-query-for-network-layer.md`](docs/decisions/0009-tanstack-store-and-query-for-network-layer.md)
- [`docs/decisions/0010-no-device-testing-gate.md`](docs/decisions/0010-no-device-testing-gate.md)
- [`docs/decisions/0011-quic-dev-cert-trust-remains-dev-only.md`](docs/decisions/0011-quic-dev-cert-trust-remains-dev-only.md)

Add a new numbered file here for any future decision with real cost-of-change (data model, protocol, storage boundaries) — not for routine implementation choices.

## Issue template

Use the Task template. Required sections:

- **Goal** — what success looks like
- **Acceptance criteria** — testable, concrete bullets (not "add login")
- **Out of scope** — what must not land in this PR
- **Notes** — context, links, constraints

## For AI coding agents

Feed **one issue at a time**. Pasting the full backlog dilutes focus and causes scope creep.

## Claude Code integration

Claude Code does not auto-read this file. Root [`CLAUDE.md`](CLAUDE.md) imports it via `@AGENTS.md`. Role workflows live under `.claude/`:

| Path | Purpose |
| --- | --- |
| `.claude/agents/` | Subagents: `planner`, `coder`, `tester`, `reviewer`, `crypto-reviewer` |
| `.claude/commands/` | Slash commands: `/plan-issue`, `/work-issue`, `/test-pr`, `/review-pr`, `/ship` |
| `.claude/skills/` | Skills: `open-task-issue`, `pqc-crypto-change` |
| `.claude/rules/` | Path-scoped rules (e.g. crypto/auth) |
| `.claude/settings.json` | Enables `superpowers@claude-plugins-official`; sets the permissions policy (see below) |

### Permissions policy

`.claude/settings.json` allows read-only `git`/`gh` and the mutating actions that drive the Coder/Tester/Reviewer flow (`gh pr merge`, `gh pr create`, `gh issue create`/`close`/`edit`, `git push`, `git commit`) without prompting, and denies destructive ones outright (`git push --force`, `gh repo delete`, `gh pr merge --admin`). These roles run as unattended background subagents that cannot answer an interactive confirmation prompt, so an `ask` rule on a routine SDLC action just gets silently bypassed anyway (and flagged after the fact) rather than actually getting reviewed — the real gate for these actions is branch protection (PR + green CI required on `main`) plus the Tester/Reviewer playbooks above, not a confirmation prompt. Only the genuinely irreversible operations are denied outright. Update permissions in `.claude/settings.json`, not by improvising broader access mid-session; note that Claude Code itself refuses to let an agent edit its own `.claude/settings*.json` (a "Self-Modification" guardrail), so this file can only be changed by a human directly.

`apps/mobile/.claude/settings.json` enables `expo@claude-plugins-official` for Expo-specific skills.

Postgres MCP is configured project-scoped in `.mcp.json` (`crystaldba/postgres-mcp` over Docker, `--network=host`, connects to the local `docker compose` Postgres by default — override via `DATABASE_URL`). **Deferred:** a NATS channel plugin — no such plugin exists in the official Claude Code marketplace as of this writing; revisit if one becomes available, rather than assuming the original "add in the same PR that stands up that service" guidance still applies to something that may not exist.
