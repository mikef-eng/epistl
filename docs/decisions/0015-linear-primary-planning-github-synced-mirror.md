# 0015: GitHub Issues stays primary; Linear is a connected, passive internal mirror

## Context

`epistl` is a **public** GitHub repository. Public visibility of open
issues — anyone can browse `is:open`, labels, and "good first issue" —
matters for outside contribution, so GitHub Issues cannot be replaced or
sidelined as the primary planning surface.

Linear was connected (workspace + `Epistl` team, `linear-server` MCP,
`linear@claude-plugins-official` plugin) to get a real workflow-state
machine and automatic archiving, since GitHub Issues has neither (hence
this project's existing label-as-state-machine convention) and Linear's
Free tier caps a workspace at 250 non-archived issues.

Two designs were tried and rejected before this one, based on direct
testing against the actual connected workspace (not just documentation):

1. **Linear as primary, GitHub Issues as an auto-created public mirror.**
   Rejected: Linear's GitHub integration reliably imports GitHub issues
   into Linear (confirmed — connecting two-way sync backfilled all
   historical issues automatically, tagged with a `Migrated` label), and
   propagates status changes back to GitHub *for pairs the sync itself
   created*. But it does **not** create a new GitHub issue from an
   issue authored natively in Linear. Manually opening a same-titled
   GitHub issue afterward doesn't merge into the original Linear issue
   either — it gets imported as an independent, unlinked duplicate. Making
   Linear primary would have meant either no public visibility for
   Linear-authored work, or a manual create-then-reconcile-the-duplicate
   step on every single issue.
2. **Linear primary by default, GitHub Issue opened by hand only when an
   issue should be publicly visible before completion (hybrid/opt-in).**
   Rejected for the same reason this file exists: most issues would
   default to Linear-only, which is the opposite of what a public,
   contribution-friendly repo needs — the common case should be
   public-by-default, not opt-in.

Separately, a **different** Linear/GitHub feature was confirmed by
testing and by Linear's docs: including the Linear issue identifier in a
branch name or PR title links a PR directly to a Linear issue (no GitHub
Issue required), with optional team-level workflow automations to
auto-transition Linear status on push/merge. This is real and reliable,
but doesn't help with the actual problem (public *issue* visibility) —
it's a PR-linking feature, not an issue-creation one — so it isn't used
here.

## Decision

GitHub Issues remains exactly what it was before Linear existed: the
single source of truth, fully public, driving the Planner/Coder/Tester/
Reviewer flow via the existing label-based lifecycle
(`planning`/`ready`/`in-progress`/`blocked`/`needs-review`) unchanged.
Nothing about issue creation, branch naming (`issue-<number>-<slug>`), or
`open-task-issue` changes.

Linear stays connected via its native two-way GitHub sync, used
one-directionally in practice: every GitHub issue (existing and future)
syncs into Linear automatically, with no action from the Planner/Coder/
Tester/Reviewer flow. This gives Linear a real workflow-state view and
automatic archiving (see below) purely as an internal reporting/roadmap
convenience. Nobody authors, edits, or manually transitions issues in
Linear as part of this SDLC — GitHub remains the only place work is
actually created and tracked.

The `Epistl` Linear team's auto-archive period is set to 30 days after an
issue reaches a completed/canceled state, so the mirrored, non-archived
issue count stays low without any manual archiving — confirmed working:
the historical backfill's already-old closed issues were auto-archived
within the same sync pass. Archived issues remain searchable and
restorable in Linear.

The `Blocked` custom workflow state created on the `Epistl` team during
this exploration is left in place (harmless, no cost to keep) but is not
part of any required workflow — GitHub's `blocked` label remains the
actual source of truth for that state.

## Consequences

- `AGENTS.md`, `.claude/skills/open-task-issue/`, and the Planner/Coder/
  Tester/Reviewer agent files and slash commands are unchanged from
  their pre-Linear form other than a short mention that Linear exists as
  a connected mirror.
- Nobody should point Planner/Coder/Tester/Reviewer automation at Linear
  MCP tools (`save_issue`, state transitions, etc.) as part of the
  regular workflow — that was tried, and reintroducing it reopens the
  duplicate-issue problem described above. Linear MCP tools remain
  available for ad hoc internal reporting/read queries only.
- If a future need specifically requires an internal-only issue with no
  public GitHub counterpart, author it directly in Linear and accept
  that it has no GitHub mirror (the sync only pulls GitHub → Linear, not
  the reverse) — don't attempt to backfill a GitHub issue for it later
  without repeating the duplicate-reconciliation dance documented here.
- If the GitHub↔Linear sync integration is ever disconnected, Linear
  simply stops receiving new issues; nothing in the actual SDLC depends
  on it, so there is no fallback needed.
