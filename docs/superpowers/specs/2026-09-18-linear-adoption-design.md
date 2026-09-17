# Linear adoption: primary planning surface with GitHub as synced public mirror

## Goal

Adopt Linear for day-to-day issue planning/tracking while keeping GitHub
Issues as the public, authoritative record for external visibility — using
Linear's native two-way GitHub sync so neither side has to be updated by
hand. Backfill existing history into Linear for posterity, and put in
place an automatic mechanism (Linear's built-in auto-archive) so the
workspace never hits the Free tier's 250-active-issue cap.

## Context

- `epistl` is a **public** GitHub repository. Fully replacing GitHub
  Issues with Linear would remove that public visibility, so this design
  keeps GitHub Issues as the externally-visible source of truth.
- Linear's GitHub integration supports genuine two-way sync: issues
  created on either side are mirrored to the other, and
  comments/status/labels/assignee stay in sync. This is Linear's
  documented pattern for open-source projects (public GitHub Issues,
  internal Linear planning).
- Linear's Free plan caps a workspace at 250 **non-archived** issues.
  Archived issues don't count and remain searchable/restorable. Each team
  has a configurable auto-archive period (default 6 months) that archives
  issues a set time after they reach a completed/canceled/duplicate
  state.
- Today: 80 closed GitHub issues, 1 open, 80 merged PRs, all in a single
  public repo with no Linear presence. A fresh "Epistl" Linear team
  already exists with Linear's stock defaults (states: Backlog, Todo, In
  Progress, In Review, Done, Canceled, Duplicate; labels: Bug, Feature,
  Improvement).
- The existing SDLC (`AGENTS.md`) drives Planner → Coder → Tester →
  Reviewer entirely off GitHub Issues and labels
  (`planning`/`ready`/`in-progress`/`blocked`/`needs-review`), with
  automation via `gh` CLI in `.claude/agents/`, `.claude/commands/`, and
  `.claude/skills/open-task-issue/`.
- `.github/workflows/ci.yml` job scoping is entirely path-based (`git
  diff --name-only`), not label-based — confirmed via grep, so none of
  this affects CI triggering.
- Only `.claude/agents/planner.md` and
  `.claude/skills/open-task-issue/SKILL.md` reference `gh issue`/`gh pr`
  directly among the agent/skill/command files; the rest reference
  AGENTS.md conventions rather than hardcoding `gh` calls.

## Non-goals / out of scope

- Building custom sync scripts or webhooks — Linear's native GitHub
  integration handles sync and history backfill entirely on its own.
- Changing CI, branch protection, or merge mechanics beyond the branch
  naming convention below.
- Retroactively editing or relabeling the 80 already-closed GitHub
  issues.
- A public-facing Linear roadmap/views product (not requested).

## Design

### 1. System of record

Enable Linear's native GitHub integration (Settings → Integrations →
GitHub → Connected organizations) linking the `epistl` repository to the
`Epistl` Linear team, with two-way issue sync turned on. GitHub Issues
remains the public, authoritative surface; Linear becomes the primary
planning/authoring surface for the Planner/Coder/Tester/Reviewer flow.
Enabling sync automatically imports existing GitHub issues into Linear
(covering the "posterity" backfill of the 80 closed + 1 open issues) —
no manual import step.

### 2. Lifecycle → Linear workflow states

The SDLC lifecycle moves from GitHub labels to real Linear workflow
states (idiomatic Linear usage — states exist for exactly this). Only
one new state needs to be added to the Epistl team's workflow:

| AGENTS.md stage | Linear state | Category | Status |
|---|---|---|---|
| `planning` | Backlog | backlog | existing |
| `ready` | Todo | unstarted | existing |
| `in-progress` | In Progress | started | existing |
| `blocked` | **Blocked** | started | **new — create on team** |
| `needs-review` | In Review | started | existing |
| merged/closed | Done | completed | existing |
| dropped/superseded | Canceled / Duplicate | canceled/duplicate | existing |

### 3. Labels

Linear labels revert to pure categorization — `Bug`, `Feature`,
`Improvement` (already present on the team) — and are no longer
overloaded to represent lifecycle stage. The old GitHub `backlog` label
(idea not yet groomed by a Planner) is not recreated as a separate
Linear label; an ungroomed idea is simply a Linear issue sitting in
`Backlog` state without a filled-out Goal/Acceptance
Criteria/Out-of-scope/Notes body yet.

### 4. Title convention

Formalize the title convention already used organically in this repo's
GitHub issues: `<Area>: <description>` (e.g. `Mobile: FriendsScreen
local search filter`, `API: contacts.rs — mutual removal + cancel
outgoing request endpoints`). This becomes the required Linear issue
title format, carried through to the synced GitHub mirror automatically.

### 5. Branch naming

Branches move from `issue-<gh-number>-<slug>` to `<linear-id>-<slug>`
(lowercased team key + number, e.g. `epi-42-login-form`), since Linear
is now the primary reference point. PRs still include `Closes
#<gh-number>` in the body so GitHub's native close-on-merge keeps
working on the mirrored issue; Linear's sync reflects the resulting
state change automatically without any extra step.

### 6. Auto-archive

Set the Epistl team's auto-archive period (Settings → Team → Workflow)
to **30 days** after an issue reaches Done, Canceled, or Duplicate —
shorter than Linear's 6-month default, given this repo's issue velocity,
to keep the active-issue count low as a matter of habit rather than
waiting until the cap becomes a problem. Archived issues remain
searchable and restorable.

### 7. Automation changes

- **`AGENTS.md`**: rewrite the Planner/Coder/Tester/Reviewer playbooks,
  the labels table, and the branch-naming convention to describe Linear
  as the primary authoring/tracking surface and GitHub Issues as the
  synced public mirror. Add a `docs/decisions/` reference for this
  change per the file's own "Architecture decisions" rule.
- **`.claude/skills/open-task-issue/`**: rewrite to create the issue via
  the Linear MCP server (`save_issue` with the team's Backlog state)
  instead of `gh issue create`, keeping the same four required sections
  (Goal, Acceptance criteria, Out of scope, Notes) in the issue
  description, and applying the `<Area>: <description>` title
  convention.
- **`.claude/agents/planner.md`**: update its `gh issue` reference to
  the Linear-first flow.
- **`.claude/agents/coder.md`/`tester.md`/`reviewer.md`**: light
  terminology touch-ups where they reference labels/state transitions,
  to point at Linear states instead of GitHub labels.
- **`.github/workflows/ci.yml`**: no changes — job scoping is path-based
  and unaffected.
- **New `docs/decisions/0015-linear-primary-planning-github-synced-mirror.md`**:
  records this as a durable decision (changes an architectural
  convention other agents must not silently contradict), per AGENTS.md's
  own criteria for when a decision file is warranted.

## Testing / verification

This is a process/tooling change, not application code, so "testing"
means:

- Manually verify the GitHub↔Linear sync integration by creating a test
  issue on each side and confirming it mirrors to the other within the
  sync's normal latency, then deleting the test issue/mirror.
- Confirm the `Blocked` state exists on the Epistl team and sits in the
  `started` category.
- Confirm the 30-day auto-archive setting is saved on the Epistl team.
- Read through the updated `AGENTS.md`, `open-task-issue` skill, and
  agent files to confirm they no longer instruct an agent to create a
  GitHub issue directly as the first step, and that the label table no
  longer claims labels drive the lifecycle.
