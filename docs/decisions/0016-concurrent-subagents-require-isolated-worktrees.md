# 0016: Concurrent coding subagents require isolated git worktrees

## Context

While shipping issues #166 and #167 in the same session, an orchestrating
Claude session dispatched two `coder` subagents concurrently, both
pointed at the single shared repo checkout at the project root. Nothing
in the orchestration set up separate working directories for them.

The two collided on disk: the #167 agent switched the shared checkout's
active branch to `issue-167-expo-push-send` and left uncommitted, staged
changes there (`Cargo.toml`/`Cargo.lock`, a new `push.rs`, an edit to
`lib.rs`). The #166 agent, working in the same directory, found its own
in-progress files interleaved with the other agent's, and the checked-out
branch changed out from under it mid-task.

The #166 agent noticed the collision, diffed against the other agent's
staged content to confirm it wasn't corrupting anything, restored the
shared directory to exactly the other agent's in-progress state, and
finished its own work in a `git worktree` it created ad hoc for itself.
This time it worked — but it depended entirely on that agent noticing the
collision and reasoning correctly about how to undo it. A subagent that
didn't check `git status` before writing, or that resolved the conflict
by guessing instead of diffing, could just as easily have silently
discarded or corrupted the other agent's uncommitted work.

Independently, the #167 agent hit a second, different collision from the
same root cause: both agents' `moon run api:test` runs share one local
Postgres instance. #166's in-progress migration got applied to that
shared database, then briefly went missing from disk mid-edit on #166's
side, leaving #167 with a local `moon run api:test` failure
("migration 7 was previously applied but is missing in the resolved
migrations") that had nothing to do with its own diff. A git worktree
alone does not fix this — worktrees isolate the filesystem/branch, not a
shared external resource like a database that multiple worktrees'
`moon run api:test` invocations still point at.

## Decision

Whenever an orchestrating session dispatches more than one write-capable
subagent (`coder`, or any subagent expected to switch branches / commit /
leave uncommitted changes) to run **concurrently** against this repo,
the orchestrator — not the subagents — is responsible for isolation: it
must create a dedicated `git worktree add` per concurrent dispatch
*before* launching each one, and tell that subagent to do its work there
instead of in the shared primary checkout. The orchestrator removes the
worktree once that subagent's task is done (PR opened, or task
abandoned).

This is an orchestration-level rule, not a change to the Coder/Tester/
Reviewer playbooks themselves. Sequential dispatch — one Coder finishing
before the next starts, which is this repo's normal default per the
Coder playbook ("implements one ready issue at a time") — is unaffected
and doesn't need a worktree beyond the branch already created in the
shared checkout.

A subagent that finds itself running without a dedicated worktree while
another concurrent write-capable subagent may be active should still
check `git status` before writing and self-rescue into an isolated
worktree if it detects someone else's uncommitted state — as the #166
agent did — but this is a fallback, not the primary safety mechanism.
Relying on it as the primary mechanism is exactly the gap this decision
closes.

## Consequences

- Any future session (this one, `/ship`, `/plan-issue`-driven batches, or
  other harness automation) that deliberately parallelizes Coder/Tester
  work across multiple `ready` issues must set up one worktree per
  concurrent subagent up front, and pass each subagent its worktree path
  explicitly in its dispatch prompt.
- A subagent prompt that says "work in the shared repo directory" without
  first confirming no other concurrent write-capable subagent is active
  is no longer sufficient once more than one such subagent is in flight.
- This does not require every subagent invocation to use a worktree —
  only concurrent ones. A single Coder working alone continues to use
  the shared checkout as before.
