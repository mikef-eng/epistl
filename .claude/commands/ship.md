---
description: Ship one or more ready issues via area lanes. Usage: /ship <issue-number> [issue-number...]
---

Orchestrate shipping GitHub issue(s) $ARGUMENTS as the **lead dispatcher** (you do not implement, run moon, or read source):

1. For each issue number, fetch the body **once** (`gh issue view <n> --json number,title,body,labels`). Skip any not labeled `ready` (report and continue).
2. **Preflight (resume-or-reset):** before dispatching issue N, check for an existing local/remote branch matching `issue-<N>-*` and any worktree under `.claude/worktrees/` whose branch matches. If found, report the branch name, commit count ahead of `main`, and whether the worktree is locked. Ask the human once: **resume** (dispatch the lane onto that branch/worktree) or **reset** (reap per AGENTS.md recovery procedure, then dispatch fresh). Never collide silently.
3. Route each issue to a lane:
   - Title/Notes start with `API:` or paths under `apps/api` → `api-dev`
   - `Mobile:` or `apps/mobile` (not modules/quic-relay-client) → `mobile-dev`
   - `QUIC relay client:` / `dev-setup:` / `packages/quic-relay-client` / `packages/dev-setup` / `apps/mobile/modules/quic-relay-client` → `native-dev`
   - Ambiguous → ask once; default to the path that matches Out of scope / Notes.
   - Chore / harness titles (`Harness:`, etc.) → do **not** dispatch; tell the human to use the chore route.
4. **One-api-lane rule:** dispatch at most one `api-dev` at a time. Mobile/native may run in parallel with each other and with a single api lane.
5. Dispatch each lane in background with the **full issue body inlined** in the prompt (title, goal, AC, out of scope, notes). Tell it not to re-fetch the issue. If the issue has the `bug` label, tell the lane to run `systematic-debugging` (root cause) before TDD.
6. When a lane returns a PR URL: run `ci-watch` on that PR, then `merge-gate`. If merge-gate blocks, stop that issue and report; continue other issues.
7. Report final PR URLs, merge status per issue.
8. Remind the human: **/clear before the next batch** so this session does not accumulate orchestrator context.
