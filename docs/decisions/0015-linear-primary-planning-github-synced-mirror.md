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
