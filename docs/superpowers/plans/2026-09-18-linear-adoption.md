# Linear Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Linear the primary Planner/Coder/Tester/Reviewer authoring surface for Epistl, with GitHub Issues staying as a publicly-visible mirror kept in sync by Linear's native two-way GitHub integration, and put in place the state/label/archive setup that keeps the Linear workspace under the Free tier's 250-active-issue cap.

**Architecture:** No custom sync code — Linear's built-in GitHub integration handles all mirroring and history backfill. The work here is entirely process/config: one new Linear workflow state, a 30-day auto-archive setting, and rewriting `AGENTS.md` plus the `.claude/agents/`, `.claude/commands/`, and `.claude/skills/open-task-issue/` files that currently hardcode a `gh`-issue-first, label-driven flow to instead target Linear issues/states first with GitHub as the synced mirror.

**Tech Stack:** Linear (workspace/team already exists: `Epistl`), Linear MCP server (`linear-server`, already added to `.mcp.json` and enabled via the `linear@claude-plugins-official` plugin — both currently uncommitted local changes), GitHub Issues/PRs (unchanged mechanics), `gh` CLI (still used for PR operations, no longer for issue creation).

**Spec:** `docs/superpowers/specs/2026-09-18-linear-adoption-design.md`

## Global Constraints

- GitHub Issues remains the public, authoritative record — do not remove or stop using it; it is now the synced mirror, not the primary authoring surface.
- Do not write custom sync scripts, webhooks, or GitHub Actions for mirroring — Linear's native GitHub integration does this natively per the spec's Context section.
- Do not edit `.claude/settings.json` — Claude Code's self-modification guardrail blocks agents from editing this file, and a human has already made the needed permissions change locally (see Task 6). Only `git add`/`git commit` it as-is.
- The four required issue-template sections (Goal, Acceptance criteria, Out of scope, Notes) stay exactly as they are today — only the platform they're authored in changes.
- Auto-archive period: 30 days after Done/Canceled/Duplicate (per spec section 6).
- Branch naming: `<linear-id>-<short-slug>`, e.g. `epi-42-login-form` (lowercased Linear issue identifier) — per spec section 5.
- Title convention: `<Area>: <description>` (e.g. `Mobile: FriendsScreen local search filter`) — per spec section 4.

---

## Task 1: Manual Linear workspace configuration (human-performed prerequisite)

This task cannot be done by an agent: none of the available Linear MCP tools (`list_issue_statuses`/`get_issue_status` are read-only; there is no `save_issue_status`/`create_issue_status`, no integration-connection tool, no team-settings/auto-archive tool) can create a workflow state, connect the GitHub integration, or change auto-archive settings. A human with Linear workspace-admin access must do this in the Linear web app before Task 8's end-to-end verification can pass. Tasks 2–7 (docs/config edits) do not depend on this being done first and can proceed in parallel if desired.

**Files:** None (Linear workspace configuration only).

- [ ] **Step 1: Connect the GitHub integration**

In the Linear web app: Settings → Integrations → GitHub → Connect, authorize the `epistl` GitHub org/repo, and link it to the `Epistl` Linear team with **two-way issue sync** enabled (not one-way). Confirm the existing 80 closed + 1 open GitHub issues begin appearing in Linear (this is Linear's automatic historical backfill — no manual import needed).

- [ ] **Step 2: Add the `Blocked` workflow state**

In the Linear web app: Settings → Team → `Epistl` → Workflow → add a new state named `Blocked` in the **Started** category, positioned after `In Progress`.

- [ ] **Step 3: Set the auto-archive period**

In the Linear web app: Settings → Team → `Epistl` → Workflow → set "Auto-archive" to **30 days**.

- [ ] **Step 4: Verify the `Blocked` state via MCP**

Run:

```
mcp__linear-server__list_issue_statuses(team: "Epistl")
```

Expected: the result includes an entry with `"name": "Blocked"` and `"type": "started"`, alongside the existing `Backlog`, `Todo`, `In Progress`, `In Review`, `Done`, `Canceled`, `Duplicate` states.

(Steps 1 and 3 have no MCP-exposed read to verify programmatically — confirm those visually in the Linear web app.)

---

## Task 2: Add architecture decision record

**Files:**
- Create: `docs/decisions/0015-linear-primary-planning-github-synced-mirror.md`
- Modify: `AGENTS.md` (Architecture decisions list)

- [ ] **Step 1: Write the decision file**

Create `docs/decisions/0015-linear-primary-planning-github-synced-mirror.md`:

```markdown
# 0015: Linear is the primary planning surface; GitHub Issues stays a synced public mirror

## Context

Epistl's SDLC (this file, `AGENTS.md`) previously ran entirely on GitHub
Issues: the Planner opened a GitHub issue, and a label
(`planning`/`ready`/`in-progress`/`blocked`/`needs-review`) tracked its
stage through the Coder/Tester/Reviewer flow.

`epistl` is a **public** GitHub repository, so GitHub Issues cannot be
retired outright — that would remove public visibility into the backlog
and roadmap for anyone outside a private Linear workspace. At the same
time, GitHub Issues has no built-in workflow-state machine (hence the
label-as-state-machine pattern) and no size cap or archiving, while
Linear has both a real state machine and a Free-tier cap of 250
non-archived issues per workspace that this project wants to stay under
without ever thinking about it.

Linear's native GitHub integration supports genuine two-way issue sync:
an issue created on either side is mirrored to the other automatically,
and comments/status/labels/assignee stay in sync. This is Linear's
documented pattern for open-source projects that want public GitHub
Issues alongside internal Linear planning.

## Decision

Linear (the `Epistl` team) is the primary surface where the
Planner/Coder/Tester/Reviewer flow authors and tracks issues. GitHub
Issues remains enabled on the repo and stays the public, authoritative
record for external visibility, kept current automatically by Linear's
two-way GitHub sync integration — nobody creates a GitHub issue by hand
for new internal work; the sync creates the mirror.

The SDLC lifecycle is modeled as Linear **workflow states**
(`Backlog`/`Todo`/`In Progress`/`Blocked`/`In Review`/`Done`/`Canceled`/`Duplicate`),
not Linear labels. Linear labels (`Bug`/`Feature`/`Improvement`) are
reserved for categorization only, mirroring how GitHub's own `bug` label
is used today.

Branches are named from the Linear issue identifier
(`<linear-id>-<short-slug>`, e.g. `epi-42-login-form`) rather than the
GitHub issue number, since Linear is now the primary reference. PRs still
include `Closes #<gh-number>` so GitHub's native close-on-merge keeps
working on the mirrored issue.

The `Epistl` Linear team's auto-archive period is set to 30 days after an
issue reaches `Done`/`Canceled`/`Duplicate`, so the active-issue count
stays low as a matter of habit well before the 250 cap could ever become
a problem. Archived issues remain searchable and restorable.

External contributors can still file GitHub issues directly via the
existing `.github/ISSUE_TEMPLATE/task.yml` template — two-way sync brings
those into Linear automatically for triage, same as any other GitHub
issue.

## Consequences

- `AGENTS.md`'s Planner/Coder/Tester/Reviewer playbooks, its labels
  table, and its branch-naming convention now describe a Linear-first
  flow instead of a GitHub-Issues-first one.
- `.claude/skills/open-task-issue/` creates issues via the Linear MCP
  server (`mcp__linear-server__save_issue`) instead of `gh issue create`.
- Nobody should re-introduce the old `planning`/`ready`/`in-progress`/
  `blocked`/`needs-review` GitHub *labels* as the source of truth for
  stage — that information now lives in the Linear issue's state, and
  the GitHub mirror's labels are cosmetic/synced, not authoritative.
- If the GitHub↔Linear sync integration is ever disconnected, this
  decision's premise (GitHub mirror always reflects Linear) no longer
  holds and the Planner/Coder/Tester/Reviewer flow would need to fall
  back to GitHub Issues directly until sync is restored or this ADR is
  revisited.
```

- [ ] **Step 2: Add it to AGENTS.md's Architecture decisions list**

In `AGENTS.md`, find this exact block inside the `## Architecture decisions` section:

```
- [`docs/decisions/0014-quic-relay-client-ios-native-build-bootstrap.md`](docs/decisions/0014-quic-relay-client-ios-native-build-bootstrap.md)

Add a new numbered file here
```

Replace with:

```
- [`docs/decisions/0014-quic-relay-client-ios-native-build-bootstrap.md`](docs/decisions/0014-quic-relay-client-ios-native-build-bootstrap.md)
- [`docs/decisions/0015-linear-primary-planning-github-synced-mirror.md`](docs/decisions/0015-linear-primary-planning-github-synced-mirror.md)

Add a new numbered file here
```

- [ ] **Step 3: Commit**

```bash
git add docs/decisions/0015-linear-primary-planning-github-synced-mirror.md AGENTS.md
git commit -m "$(cat <<'EOF'
Add ADR 0015: Linear as primary planning surface, GitHub as synced mirror

Records the decision to author/track issues in Linear going forward,
with GitHub Issues staying enabled as the public record kept current by
Linear's native two-way GitHub sync integration.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Rewrite `AGENTS.md`'s single-source-of-truth, roles, and labels sections

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Update "Single source of truth"**

Find:

```markdown
## Single source of truth

- Every unit of work is a **GitHub Issue**.
- Nothing gets built without an issue.
- Acceptance criteria are written **before** implementation starts, never after.
```

Replace with:

```markdown
## Single source of truth

- Every unit of work is a **Linear issue** on the `Epistl` team.
- Linear's two-way GitHub sync integration mirrors every issue to a GitHub issue in this repo automatically (see [`docs/decisions/0015-linear-primary-planning-github-synced-mirror.md`](docs/decisions/0015-linear-primary-planning-github-synced-mirror.md)). GitHub Issues stays the public, human-readable record; never create a GitHub issue by hand for new work — let the sync create the mirror.
- Nothing gets built without an issue.
- Acceptance criteria are written **before** implementation starts, never after.
```

- [ ] **Step 2: Update the Roles and handoffs table**

Find:

```markdown
| **Planner** | Breaks the goal into small tasks; opens issues with clear goal, acceptance criteria, and out of scope. Labels `planning`, then `ready` when unambiguous. |
| **Coder** | Implements **one** `ready` issue at a time. Creates a branch, opens a PR that closes the issue. Extra discoveries become new issues — not scope on the current branch. |
| **Tester** | Runs CI, adds tests for acceptance criteria when missing, checks the PR against criteria line by line. Failures → PR comment + `blocked`. Pass → `needs-review`. |
| **Reviewer** | Final pass on quality, security, conventions, and scope. Merge only when CI is green and criteria are met. |
```

Replace with:

```markdown
| **Planner** | Breaks the goal into small tasks; opens Linear issues with clear goal, acceptance criteria, and out of scope. Leaves each in `Backlog`, then moves it to `Todo` when unambiguous. |
| **Coder** | Implements **one** `Todo` issue at a time. Creates a branch, opens a PR that closes the GitHub mirror issue. Extra discoveries become new issues — not scope on the current branch. |
| **Tester** | Runs CI, adds tests for acceptance criteria when missing, checks the PR against criteria line by line. Failures → PR comment + moves the issue to `Blocked`. Pass → moves it to `In Review`. |
| **Reviewer** | Final pass on quality, security, conventions, and scope. Merge only when CI is green and criteria are met. |
```

- [ ] **Step 3: Replace the Labels section with a Workflow states section**

Find:

```markdown
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
```

Replace with:

```markdown
## Workflow states

Linear workflow states on the `Epistl` team drive the SDLC — not Linear labels. Linear labels (`Bug`, `Feature`, `Improvement`) are reserved for categorization, mirroring how GitHub's own `bug` label is used today.

| State | Category | Meaning |
| --- | --- | --- |
| `Backlog` | backlog | Idea/issue exists but may not be fully groomed yet |
| `Todo` | unstarted | Clear enough for the Coder |
| `In Progress` | started | Actively being implemented |
| `Blocked` | started | Waiting on a fix or decision |
| `In Review` | started | Tester passed; awaiting Reviewer |
| `Done` | completed | Merged/shipped |
| `Canceled` / `Duplicate` | canceled/duplicate | Dropped or superseded |

Flow: `Backlog` → `Todo` → `In Progress` → (`Blocked` \| `In Review`) → `Done`.
```

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md
git commit -m "$(cat <<'EOF'
AGENTS.md: describe Linear-first single source of truth and states

Replaces the GitHub-label-as-state-machine description with Linear
workflow states, per ADR 0015.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Rewrite the Planner/Coder/Tester/Reviewer playbooks in `AGENTS.md`

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Update the Planner playbook**

Find:

```markdown
3. For each task, open a GitHub issue using the Task template via the `open-task-issue` skill. Required sections: Goal, Acceptance criteria, Out of scope, Notes.
4. Label each new issue `planning`.
5. Self-review every acceptance criterion: it must be concrete and testable. "Add login" is bad. "User can log in with email/password; invalid credentials show an error; session persists on refresh" is good.
6. Flip an issue to `ready` only when a Coder could implement it without asking a clarifying question.
```

Replace with:

```markdown
3. For each task, open a Linear issue on the `Epistl` team using the Task template via the `open-task-issue` skill. Required sections: Goal, Acceptance criteria, Out of scope, Notes.
4. New issues start in the `Backlog` state (Linear's default for a newly created issue) — no separate label to apply.
5. Self-review every acceptance criterion: it must be concrete and testable. "Add login" is bad. "User can log in with email/password; invalid credentials show an error; session persists on refresh" is good.
6. Move an issue to `Todo` only when a Coder could implement it without asking a clarifying question.
```

- [ ] **Step 2: Update the Coder playbook**

Find:

```markdown
2. Confirm the issue is labeled `ready` (or switch it to `in-progress` if you are starting work).
3. Create a branch named `issue-<number>-<short-slug>` (e.g. `issue-42-login-form`).
```

Replace with:

```markdown
2. Confirm the issue is in the `Todo` state (or move it to `In Progress` if you are starting work).
3. Create a branch named `<linear-id>-<short-slug>` (e.g. `epi-42-login-form`, using the Linear issue identifier lowercased).
```

- [ ] **Step 3: Update the Coder playbook's PR/label steps**

Find:

```markdown
7. Open a PR that references the issue with `Closes #<number>`.
8. Keep the issue labeled `in-progress` until Tester finishes.
```

Replace with:

```markdown
7. Open a PR that references the GitHub mirror issue with `Closes #<gh-number>` — Linear's sync reflects the resulting state change automatically once the PR merges.
8. Keep the issue in the `In Progress` state until Tester finishes.
```

- [ ] **Step 4: Update the Tester playbook**

Find:

```markdown
5. On failure: comment on the PR with specifics and set the issue label to `blocked`.
6. On pass: set the issue label to `needs-review`.
```

Replace with:

```markdown
5. On failure: comment on the PR with specifics and move the issue to the `Blocked` state.
6. On pass: move the issue to the `In Review` state.
```

- [ ] **Step 5: Update the Reviewer playbook**

Find:

```markdown
1. Confirm CI is green and the Tester has set `needs-review`. Trust CI-green plus the Tester's `needs-review` label entirely for correctness — never re-run test suites yourself; spend your review effort on the diff, not on re-verifying "does it pass."
```

Replace with:

```markdown
1. Confirm CI is green and the Tester has moved the issue to `In Review`. Trust CI-green plus that state entirely for correctness — never re-run test suites yourself; spend your review effort on the diff, not on re-verifying "does it pass."
```

Find:

```markdown
7. Merge only when CI is green and criteria are met. Prefer squash merge; delete the branch after merge.
```

Replace with:

```markdown
7. Merge only when CI is green and criteria are met. Prefer squash merge; delete the branch after merge. Merging closes the GitHub mirror issue (via `Closes #<gh-number>`); Linear's sync moves the issue to `Done` automatically — no manual state change needed.
```

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md
git commit -m "$(cat <<'EOF'
AGENTS.md: update Planner/Coder/Tester/Reviewer playbooks for Linear

Each role now reads/writes Linear issue state instead of GitHub labels;
branch naming uses the Linear issue identifier. Per ADR 0015.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Rewrite the `open-task-issue` skill to create Linear issues

**Files:**
- Modify: `.claude/skills/open-task-issue/SKILL.md`

- [ ] **Step 1: Read the current file to confirm no drift**

Run: `cat .claude/skills/open-task-issue/SKILL.md`
Expected: matches the content quoted in the spec's Context section (frontmatter `name: open-task-issue`, a `gh issue create` heredoc example). If it has drifted, adapt the replacement below to match the actual current content instead of assuming this plan's snapshot is still accurate.

- [ ] **Step 2: Replace the file contents**

Write `.claude/skills/open-task-issue/SKILL.md`:

```markdown
---
name: open-task-issue
description: Create a Linear Task issue with Goal, Acceptance criteria, Out of scope, and Notes. Use when planning work or spinning scope creep into a new issue. Leaves it in the Backlog state; GitHub's mirror issue is created automatically by Linear's sync.
---

# Open Task Issue

Create a Linear issue on the `Epistl` team that matches Epistl's Task template. Linear's two-way GitHub sync automatically mirrors it to a GitHub issue in this repo — do not also create a GitHub issue by hand.

## Required sections (all non-empty)

1. **Goal** — what success looks like
2. **Acceptance criteria** — concrete, testable bullets
3. **Out of scope** — what must not land in the PR
4. **Notes** — context, links, constraints (can be brief but not blank; use "None" if truly empty)

## Title convention

`<Area>: <description>` — e.g. `Mobile: FriendsScreen local search filter`, `API: contacts.rs — mutual removal + cancel outgoing request endpoints`.

## Procedure

1. Draft the four sections. Reject vague criteria ("add login") and rewrite until testable.
2. Create the issue with the Linear MCP tool:

```
mcp__linear-server__save_issue(
  team: "Epistl",
  title: "<Area>: <concise title>",
  description: "## Goal\n\n<goal>\n\n## Acceptance criteria\n\n- [ ] <criterion>\n- [ ] <criterion>\n\n## Out of scope\n\n- <item>\n\n## Notes\n\n<notes>"
)
```

Pass the description with literal newlines (the tool does not want escape sequences), not the literal two-character sequence `\n`. Leave `state` unset — new issues default to the team's `Backlog` state.

3. Return the issue identifier (e.g. `EPI-42`) and URL from the tool result.
4. Do **not** move it to `Todo` here unless you explicitly completed the Planner self-review that a Coder needs no clarifying questions.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/open-task-issue/SKILL.md
git commit -m "$(cat <<'EOF'
open-task-issue: create Linear issues instead of gh issue create

GitHub's mirror issue now comes from Linear's sync integration rather
than being created directly. Per ADR 0015.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Update `.claude/agents/*.md` role files

**Files:**
- Modify: `.claude/agents/planner.md`
- Modify: `.claude/agents/coder.md`
- Modify: `.claude/agents/tester.md`
- Modify: `.claude/agents/reviewer.md`

- [ ] **Step 1: Update `.claude/agents/planner.md`**

Find:

```markdown
- One GitHub issue per task — except related, low-risk changes to the same screen/user-facing surface, which may bundle into a single issue with multiple separable, testable acceptance-criteria bullets (still one PR). Hard exclusions that always stay atomic regardless of size: `apps/api/src/crypto/**`, `apps/api/src/auth/**`, `apps/mobile/src/crypto/**`, any migration/data-model change, any new dependency, anything warranting a `docs/decisions/` entry. Use the `open-task-issue` skill (or `gh issue create` with the Task template sections).
- Start every new issue with the `planning` label.
- Flip to `ready` only when a Coder could implement without asking a clarifying question.
```

Replace with:

```markdown
- One Linear issue per task — except related, low-risk changes to the same screen/user-facing surface, which may bundle into a single issue with multiple separable, testable acceptance-criteria bullets (still one PR). Hard exclusions that always stay atomic regardless of size: `apps/api/src/crypto/**`, `apps/api/src/auth/**`, `apps/mobile/src/crypto/**`, any migration/data-model change, any new dependency, anything warranting a `docs/decisions/` entry. Use the `open-task-issue` skill (it creates the Linear issue; do not also open a GitHub issue by hand — the sync mirrors it automatically).
- Start every new issue in the `Backlog` state (Linear's default).
- Move to `Todo` only when a Coder could implement without asking a clarifying question.
```

- [ ] **Step 2: Update `.claude/agents/coder.md`**

Find:

```markdown
- Read **only** the assigned issue (by number). Do not load the full backlog.
- Branch: `issue-<number>-<short-slug>`.
- One issue, one branch, one PR. PR body must include `Closes #<number>`.
- Label the issue `in-progress` while working.
```

Replace with:

```markdown
- Read **only** the assigned issue (by Linear identifier, e.g. `EPI-42`). Do not load the full backlog.
- Branch: `<linear-id>-<short-slug>` (lowercased), e.g. `epi-42-login-form`.
- One issue, one branch, one PR. PR body must include `Closes #<gh-number>` (the GitHub mirror issue's number).
- Move the issue to `In Progress` while working.
```

- [ ] **Step 3: Update `.claude/agents/tester.md`**

Find:

```markdown
- On failure: comment on the PR with specifics; set issue label to `blocked`.
- On pass: set issue label to `needs-review`.
```

Replace with:

```markdown
- On failure: comment on the PR with specifics; move the issue to `Blocked`.
- On pass: move the issue to `In Review`.
```

- [ ] **Step 4: Update `.claude/agents/reviewer.md`**

Find:

```markdown
- Confirm CI green and issue labeled `needs-review`.
- Never re-run test suites yourself — trust CI-green plus the Tester's `needs-review` label entirely for correctness; spend your review effort on the diff, not on re-verifying "does it pass."
```

Replace with:

```markdown
- Confirm CI green and issue in the `In Review` state.
- Never re-run test suites yourself — trust CI-green plus the Tester's `In Review` state entirely for correctness; spend your review effort on the diff, not on re-verifying "does it pass."
```

- [ ] **Step 5: Commit**

```bash
git add .claude/agents/planner.md .claude/agents/coder.md .claude/agents/tester.md .claude/agents/reviewer.md
git commit -m "$(cat <<'EOF'
Update Planner/Coder/Tester/Reviewer agent files for Linear states

Mirrors the AGENTS.md playbook changes in the per-role agent
instructions: Linear issue identifiers and states instead of GitHub
issue numbers and labels. Per ADR 0015.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Update slash commands

**Files:**
- Modify: `.claude/commands/plan-issue.md`
- Modify: `.claude/commands/work-issue.md`
- Modify: `.claude/commands/test-pr.md`
- Modify: `.claude/commands/review-pr.md`
- Modify: `.claude/commands/ship.md`

- [ ] **Step 1: Update `.claude/commands/plan-issue.md`**

Find:

```markdown
Follow the Planner playbook in AGENTS.md. Open Task-template issues labeled `planning`, then move unambiguous ones to `ready`. Do not write application code.
```

Replace with:

```markdown
Follow the Planner playbook in AGENTS.md. Open Task-template Linear issues (they start in `Backlog`), then move unambiguous ones to `Todo`. Do not write application code.
```

- [ ] **Step 2: Update `.claude/commands/work-issue.md`**

Find:

```markdown
---
description: Implement one ready GitHub issue. Usage: /work-issue <issue-number>
---

Delegate to the `coder` subagent for GitHub issue #$ARGUMENTS.

Follow the Coder playbook in AGENTS.md: read only that issue, branch `issue-<n>-<slug>`, implement scope only, open a PR with `Closes #<n>`, label `in-progress`. Scope creep becomes a new issue via `open-task-issue`.
```

Replace with:

```markdown
---
description: Implement one ready Linear issue. Usage: /work-issue <linear-id>
---

Delegate to the `coder` subagent for Linear issue $ARGUMENTS.

Follow the Coder playbook in AGENTS.md: read only that issue, branch `<linear-id>-<slug>`, implement scope only, open a PR with `Closes #<gh-number>` against the GitHub mirror issue, move the issue to `In Progress`. Scope creep becomes a new issue via `open-task-issue`.
```

- [ ] **Step 3: Update `.claude/commands/test-pr.md`**

Find:

```markdown
Follow the Tester playbook in AGENTS.md: CI green, line-by-line acceptance criteria, comment + `blocked` on failure, `needs-review` on pass.
```

Replace with:

```markdown
Follow the Tester playbook in AGENTS.md: CI green, line-by-line acceptance criteria, comment + move the issue to `Blocked` on failure, `In Review` on pass.
```

- [ ] **Step 4: Update `.claude/commands/review-pr.md`**

Find:

```markdown
Delegate to the `reviewer` subagent for pull request #$ARGUMENTS.

Follow the Reviewer playbook in AGENTS.md. If the diff touches crypto/auth paths, require `crypto-reviewer` sign-off before approving. Merge only when CI is green and criteria are met.
```

Replace with:

```markdown
Delegate to the `reviewer` subagent for pull request #$ARGUMENTS.

Follow the Reviewer playbook in AGENTS.md: confirm the linked Linear issue is in `In Review`. If the diff touches crypto/auth paths, require `crypto-reviewer` sign-off before approving. Merge only when CI is green and criteria are met.
```

- [ ] **Step 5: Update `.claude/commands/ship.md`**

Find:

```markdown
2. Run the `tester` subagent on that PR (same as `/test-pr`). If the issue is labeled `blocked`, **stop** and report failures — do not continue.
```

Replace with:

```markdown
2. Run the `tester` subagent on that PR (same as `/test-pr`). If the issue is moved to `Blocked`, **stop** and report failures — do not continue.
```

- [ ] **Step 6: Commit**

```bash
git add .claude/commands/plan-issue.md .claude/commands/work-issue.md .claude/commands/test-pr.md .claude/commands/review-pr.md .claude/commands/ship.md
git commit -m "$(cat <<'EOF'
Update slash commands for Linear issue identifiers and states

/work-issue now takes a Linear identifier instead of a GitHub issue
number; /ship and /test-pr reference Linear states instead of GitHub
labels. Per ADR 0015.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Commit the pre-existing MCP/plugin config changes and document them

**Files:**
- Modify (already changed on disk, uncommitted): `.mcp.json`, `.claude/settings.json`
- Modify: `AGENTS.md` (Claude Code integration section)

`.mcp.json` and `.claude/settings.json` already have the `linear-server` MCP entry and the `linear@claude-plugins-official` plugin enabled locally (uncommitted, made outside this plan). Do not use the Edit or Write tool on `.claude/settings.json` — Claude Code refuses agent self-edits to that file. Just commit it as-is alongside the AGENTS.md doc update.

- [ ] **Step 1: Confirm the existing uncommitted diff is what's expected**

Run: `git diff .mcp.json .claude/settings.json`

Expected: `.mcp.json` gains a `linear-server` entry (`"type": "http", "url": "https://mcp.linear.app/mcp"`), and `.claude/settings.json` gains `"linear@claude-plugins-official": true` under `enabledPlugins`. If this diff is missing or different, stop and ask the user to enable the Linear MCP server and plugin themselves first (per the settings-self-edit restriction, an agent cannot make this change).

- [ ] **Step 2: Document the Linear MCP server in AGENTS.md**

Find this exact sentence at the end of the "Claude Code integration" section:

```markdown
Postgres MCP is configured project-scoped in `.mcp.json` (`crystaldba/postgres-mcp` over Docker, `--network=host`, connects to the local `docker compose` Postgres by default — override via `DATABASE_URL`). **Deferred:** a NATS channel plugin — no such plugin exists in the official Claude Code marketplace as of this writing; revisit if one becomes available, rather than assuming the original "add in the same PR that stands up that service" guidance still applies to something that may not exist.
```

Replace with:

```markdown
Postgres MCP is configured project-scoped in `.mcp.json` (`crystaldba/postgres-mcp` over Docker, `--network=host`, connects to the local `docker compose` Postgres by default — override via `DATABASE_URL`). **Deferred:** a NATS channel plugin — no such plugin exists in the official Claude Code marketplace as of this writing; revisit if one becomes available, rather than assuming the original "add in the same PR that stands up that service" guidance still applies to something that may not exist.

Linear MCP (`linear-server`, `https://mcp.linear.app/mcp`) is configured project-scoped in `.mcp.json`, with the `linear@claude-plugins-official` plugin enabled in `.claude/settings.json`. This is what `open-task-issue` and the Planner/Coder/Tester/Reviewer playbooks use to create and transition Linear issues — see [`docs/decisions/0015-linear-primary-planning-github-synced-mirror.md`](docs/decisions/0015-linear-primary-planning-github-synced-mirror.md).
```

- [ ] **Step 3: Commit**

```bash
git add .mcp.json .claude/settings.json AGENTS.md
git commit -m "$(cat <<'EOF'
Commit Linear MCP server + plugin config, document in AGENTS.md

.mcp.json and .claude/settings.json already had the linear-server MCP
entry and linear@claude-plugins-official plugin enabled locally; this
commits that config and documents it per the Docs freshness rule in
AGENTS.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: End-to-end verification

**Files:** None (verification only — creates and then removes one throwaway Linear/GitHub issue pair).

Depends on Task 1 being complete (GitHub sync connected, `Blocked` state present).

- [ ] **Step 1: Create a test issue via the rewritten skill**

Follow the now-updated `.claude/skills/open-task-issue/SKILL.md` procedure to create a throwaway issue, e.g.:

```
mcp__linear-server__save_issue(
  team: "Epistl",
  title: "Test: verify GitHub sync end to end",
  description: "## Goal\n\nVerify the Linear<->GitHub sync integration works end to end.\n\n## Acceptance criteria\n\n- [ ] Issue appears as a GitHub issue in the epistl repo\n\n## Out of scope\n\n- N/A\n\n## Notes\n\nThrowaway verification issue for the Linear adoption plan; delete after confirming."
)
```

Record the returned Linear identifier (e.g. `EPI-<n>`).

- [ ] **Step 2: Confirm the GitHub mirror was created**

Run: `gh issue list --search "Test: verify GitHub sync end to end" --state all --json number,title`

Expected: one result with a matching title and a `number`. If nothing appears within a minute or two, the sync integration from Task 1 Step 1 is not working — stop and re-check that setup before proceeding.

- [ ] **Step 3: Confirm the issue's Linear state**

Run: `mcp__linear-server__get_issue(id: "<the EPI-n identifier from Step 1>")`

Expected: `state.name` is `"Backlog"`.

- [ ] **Step 4: Clean up both sides**

Run: `gh issue close <the number from Step 2> --reason "not planned"`

Then use `mcp__linear-server__save_issue` with `id: "<EPI-n>"` and `state: "Canceled"` to cancel the Linear side (or confirm the GitHub close synced it to `Canceled`/`Done` automatically via `get_issue` before doing this manually).

- [ ] **Step 5: Report results**

Summarize for the user: whether the mirror was created, how long it took, and the final state of both the Linear issue and GitHub issue after cleanup. No commit for this task — it's verification only, nothing in the repo changes.
