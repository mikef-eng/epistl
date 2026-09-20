---
description: Ship one or more ready issues via area lanes, staging multi-issue features on a feature branch. Usage: /ship [--onto feat/<slug>] <issue-number> [issue-number...]
---

Orchestrate shipping GitHub issue(s) $ARGUMENTS as the **lead dispatcher** (you do not implement, run moon, or read source). `/ship` never merges into `main`; `/gate` does that.

1. For each issue number, fetch the body **once** (`gh issue view <n> --json number,title,body,labels`). Skip any not labeled `ready` (report and continue).
2. **Preflight (resume-or-reset):** before dispatching issue N, check for an existing local/remote branch matching `issue-<N>-*` and any worktree under `.claude/worktrees/` whose branch matches. If found, report the branch name, commit count ahead of `main`, and whether the worktree is locked. Ask the human once: **resume** (dispatch the lane onto that branch/worktree) or **reset** (reap per AGENTS.md recovery procedure, then dispatch fresh). Never collide silently.
3. Route each issue to a lane:
   - Title/Notes start with `API:` or paths under `apps/api` → `api-dev`
   - `Mobile:` or `apps/mobile` (not modules/quic-relay-client) → `mobile-dev`
   - `QUIC relay client:` / `dev-setup:` / `packages/quic-relay-client` / `packages/dev-setup` / `apps/mobile/modules/quic-relay-client` → `native-dev`
   - Ambiguous → ask once; default to the path that matches Out of scope / Notes.
   - Chore / harness titles (`Harness:`, etc.) → do **not** dispatch; tell the human to use the chore route.
4. **Integration mode.** Each `/ship` call is its own feature: unrelated features are separate `/ship` calls, each with its own `feat/<slug>`, gated separately.
   - **`--onto feat/<slug>`** → *staged onto an existing feature*. Check it exists (`git ls-remote --heads origin feat/<slug>`) and has no PR into `main` that is already merged or closed; if it does, stop and report. Do **not** create a new branch.
   - **One issue** → *direct*: the lane's PR targets `main`. Finish with step 9 and tell the human to run `/gate <pr#>`.
   - **Two or more issues** → *staged* if they are one feature (Notes reference each other as siblings/blockers), otherwise *direct* each; ask once if unclear. For staged: `git fetch origin main`, then create the feature branch on origin without touching the local checkout: `git push origin origin/main:refs/heads/feat/<slug>` (slug from the lead issue title; tell the human the name).
5. **Dependencies.** For each issue, read its Notes for `Depends on #N` / `blocked on #N`. Then:
   - `#N` is closed or merged to `main` → fine.
   - `#N` is in this batch → dispatch this issue only after `#N`'s PR has been staged.
   - `#N` is already staged on the `--onto` branch → fine (the lane starts from that branch's tip).
   - `#N` is staged on a different, unmerged `feat/<slug>` → stop and offer the two options: rerun with `--onto feat/<slug>`, or wait until that feature has merged to `main`.
   - `#N` is open and not staged anywhere → stop and report; do not dispatch. No stacked feature branches.
6. **Parallelism:** mobile, native, ui, and api lanes may run concurrently (per-worktree Postgres + NATS isolation, issue #219). Independent lanes run at the same time; only a dependent lane waits.
7. Dispatch each lane in background with the **full issue body inlined** (title, goal, AC, out of scope, notes) and the PR target: "open your PR with `--base <feat/<slug> | main>`". Tell it not to re-fetch the issue. If the issue has the `bug` label, tell the lane to run `systematic-debugging` (root cause) before TDD. **Staged mode:** also tell the lane, as its first two commands and as separate calls, `git fetch origin` then `git checkout -B issue-<n>-<short-slug> origin/feat/<slug>`, so it starts from the feature branch tip and sees whatever its siblings already staged (an isolated worktree otherwise starts from `main`).
8. **Staged mode: when a lane returns a PR URL,** confirm `gh pr view <pr> --json baseRefName` is the feature branch, then stage it with a light merge: `gh pr merge <pr> --squash --delete-branch`. No CI runs on PRs that do not target `main`, and no gate here; substance is checked once, on the whole diff, by `/gate`. Crypto/auth paths are still staged; `crypto-reviewer` runs at `/gate`. On a merge conflict or a lane failure, stop that lane and report; continue the others.
9. Report: the feature branch (if staged), each lane PR and its status, and the next step: **`/gate feat/<slug>`** (staged) or **`/gate <pr#>`** (direct).
10. Remind the human: **/clear before the next batch** so this session does not accumulate orchestrator context.
