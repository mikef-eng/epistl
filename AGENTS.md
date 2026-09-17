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
2. Break the goal into small, independent-ish tasks (aim for under a day of work each). **Bundling**: related, low-risk changes to the same screen/user-facing surface may be combined into one issue — multiple separable, testable acceptance-criteria bullets, still one PR — rather than one issue per change (e.g. a settings screen's dark-mode toggle, nav scaffold, visual pass, log-out flow, and delete-account flow can be one issue if each piece is independently low-risk). **Hard exclusions — always stay atomic regardless of size or how related they look**: anything touching `apps/api/src/crypto/**`, `apps/api/src/auth/**`, `apps/mobile/src/crypto/**`; any database migration or data-model change; any new dependency; anything that would warrant a `docs/decisions/` entry per this file's "Architecture decisions" section. There's no fixed time-budget cap layered on top of the same-screen/low-risk gate — if a bundle grows large enough that it no longer reads as one coherent day-or-so of work, split along a natural sub-boundary rather than reverting to one-issue-per-tiny-change.
3. For each task, open a GitHub issue using the Task template via the `open-task-issue` skill. Required sections: Goal, Acceptance criteria, Out of scope, Notes.
4. Label each new issue `planning`.
5. Self-review every acceptance criterion: it must be concrete and testable. "Add login" is bad. "User can log in with email/password; invalid credentials show an error; session persists on refresh" is good.
6. Flip an issue to `ready` only when a Coder could implement it without asking a clarifying question.
7. Re-run this playbook after every merged milestone or when new work is discovered. Never invent mid-sprint scope for the Coder.

## Coder playbook

1. Read **only** the assigned issue — do not load the whole backlog into context.
2. Confirm the issue is labeled `ready` (or switch it to `in-progress` if you are starting work).
3. Create a branch named `issue-<number>-<short-slug>` (e.g. `issue-42-login-form`).
4. Implement **only** that issue's scope. Prefer TDD (red → green → refactor) when tests are part of the acceptance criteria. Run local checks via moon (`moon run api:check`/`api:lint`/`api:test`, `moon run mobile:lint`/`mobile:typecheck`/`mobile:test`), not raw `cargo`/`npm` — see the Tester playbook below for why.
5. If you notice extra work, open a new issue via the `open-task-issue` skill — do not expand this branch.
6. If the change alters the stack, how to run something, an env var, or an architectural constraint, update the relevant section of `README.md` in the same PR — see "Docs freshness" below.
7. Open a PR that references the issue with `Closes #<number>`.
8. Keep the issue labeled `in-progress` until Tester finishes.

## Tester playbook

1. Confirm CI is green (lint, build, test) for the PR — this is the authoritative "does it pass" signal. `moon`/CI parity is guaranteed by convention (see README's "Local commands" section), so do **not** re-run the full local suite just to reconfirm what a green CI already tells you. If CI hasn't finished, wait for it (or check/re-trigger via `gh run watch`) rather than substituting a local run.
2. Verify **each** acceptance criterion on the linked issue line by line — not just "does it run." Audit coverage: confirm a real test exists for each criterion and actually exercises the claimed behavior — read the test, don't just trust the PR description's claims.
3. Add or fix tests for acceptance criteria when coverage is missing or wrong, and reasonably testable in this PR. Run anything you add or change yourself, via moon (matching CI exactly — see README's "Local commands" section): `moon run mobile:lint`, `moon run mobile:typecheck`, `moon run mobile:test` for `apps/mobile`; `moon run api:check`, `moon run api:lint`, `moon run api:test` for `apps/api`. Do not substitute raw `cargo`/`npm` invocations — moon's task definitions are the actual source of truth CI runs against (a raw command can silently diverge from it), and moon already loads `.env` for every task, so manually running `source .env`/`set -o allexport` beforehand is redundant and should also be avoided. This is new verification you're adding, not a re-check of what CI already confirmed.
4. **Exception — repeated/probabilistic verification criteria** (e.g. a flake-reproduction loop the PR claims to have closed): CI's single pass structurally can't confirm this. Always fully independently re-run the stated N yourself, using moon's `--` passthrough (e.g. `for i in $(seq 1 40); do moon run api:test -- --lib || echo "FAILED on iteration $i"; done`) — never just audit the Coder's reported numbers or methodology. This is the one case where full duplication of the Coder's own check is intentional and required.
5. On failure: comment on the PR with specifics and set the issue label to `blocked`.
6. On pass: set the issue label to `needs-review`.

## Reviewer playbook

1. Confirm CI is green and the Tester has set `needs-review`. Trust CI-green plus the Tester's `needs-review` label entirely for correctness — never re-run test suites yourself; spend your review effort on the diff, not on re-verifying "does it pass."
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

## CI job scoping

`.github/workflows/ci.yml`'s `api`, `mobile`, and `quic-relay-client` jobs only run on `pull_request` when their own paths (or the shared Cargo workspace files `Cargo.toml`/`Cargo.lock`, since `apps/api` and `packages/quic-relay-client` share one workspace) are touched — a `changes` job at the top of the workflow computes this via `git diff --name-only`, the same technique `crypto-review-notice` already uses. A change to `.github/workflows/ci.yml` itself or `.moon/**` always triggers all three jobs, since either can affect any project's build. If the `changes` job itself fails, all three jobs run anyway (fail open) rather than silently skip, since a skipped required check reads as satisfied by branch protection. A job showing as **skipped** on your PR is expected, not a problem — it means that project's paths weren't touched, not that verification was bypassed. `push` to `main` always runs all three jobs unconditionally, as a full post-merge safety net.

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
- [`docs/decisions/0012-mobile-local-storage-uses-drizzle-going-forward.md`](docs/decisions/0012-mobile-local-storage-uses-drizzle-going-forward.md)
- [`docs/decisions/0013-quic-relay-client-android-native-build-bootstrap.md`](docs/decisions/0013-quic-relay-client-android-native-build-bootstrap.md)

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
| `.claude/agents/` | Subagents: `planner`, `coder`, `tester`, `reviewer`, `crypto-reviewer`, `ui` |
| `.claude/commands/` | Slash commands: `/plan-issue`, `/work-issue`, `/test-pr`, `/review-pr`, `/ship`, `/ui` |
| `.claude/skills/` | Skills: `open-task-issue`, `pqc-crypto-change` |
| `.claude/rules/` | Path-scoped rules (e.g. crypto/auth) |
| `.claude/settings.json` | Enables `superpowers@claude-plugins-official`; sets the permissions policy (see below) |

### Permissions policy

`.claude/settings.json` allows read-only `git`/`gh` and the mutating actions that drive the Coder/Tester/Reviewer flow (`gh pr merge`, `gh pr create`, `gh issue create`/`close`/`edit`, `git push`, `git commit`) without prompting, and denies destructive ones outright (`git push --force`, `gh repo delete`, `gh pr merge --admin`). These roles run as unattended background subagents that cannot answer an interactive confirmation prompt, so an `ask` rule on a routine SDLC action just gets silently bypassed anyway (and flagged after the fact) rather than actually getting reviewed — the real gate for these actions is branch protection (PR + green CI required on `main`) plus the Tester/Reviewer playbooks above, not a confirmation prompt. Only the genuinely irreversible operations are denied outright. Update permissions in `.claude/settings.json`, not by improvising broader access mid-session; note that Claude Code itself refuses to let an agent edit its own `.claude/settings*.json` (a "Self-Modification" guardrail), so this file can only be changed by a human directly.

`apps/mobile/.claude/settings.json` enables `expo@claude-plugins-official` for Expo-specific skills.

### `/ui`: an intentional exception to the SDLC above

`/ui` (`.claude/agents/ui.md`) is a deliberate carve-out from the
Planner → Coder → Tester → Reviewer flow this whole file otherwise
describes: it's for fast, no-ceremony visual iteration on mobile
presentation-layer files while a dev server hot-reloads — no tests, no
issue/label changes, no CI. It always works on a dedicated branch (it
creates one itself if it finds `main` checked out, and reuses whatever
non-`main` branch is already checked out otherwise) rather than editing
`main` directly, and it tracks its own progress across invocations inside
`docs/superpowers/specs/2026-09-15-mobile-frontend-polish.md` (the one
doc, not GitHub issues and not other specs) — but it still never commits,
pushes, or opens a PR on its own. Treat its output as
uncommitted scratch work on that branch until someone turns it into
commits and a PR (bundled with its progress doc), or until it's picked up
by a normal `ready` issue and goes through the Coder/Tester/Reviewer flow
like everything else — don't let `/ui` edits merge to `main` on their own
say-so.

Postgres MCP is configured project-scoped in `.mcp.json` (`crystaldba/postgres-mcp` over Docker, `--network=host`, connects to the local `docker compose` Postgres by default — override via `DATABASE_URL`). **Deferred:** a NATS channel plugin — no such plugin exists in the official Claude Code marketplace as of this writing; revisit if one becomes available, rather than assuming the original "add in the same PR that stands up that service" guidance still applies to something that may not exist.
