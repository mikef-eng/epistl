---
description: Open (if needed) and gate the PR into main, then arm auto-merge. Usage: /gate <pr-number | feat/branch>
---

Run the final gate for `$ARGUMENTS` as the lead dispatcher. Nobody waits on CI: `merge-gate` arms GitHub auto-merge and returns.

1. **Resolve the target.**
   - A PR number → use it. If its state is already `MERGED`, skip to step 5.
   - A `feat/<slug>` branch with no open PR into `main` → open one now: `gh pr create --base main --head feat/<slug>`. Build the body from the merged lane PRs (`gh pr list --base feat/<slug> --state merged --json number,title,body`): `## Lane: feature (staged)`, a `## Testing recommendation`, one `Closes #N` per staged issue, and each lane PR's `## Coverage` section pasted under its title. CI starts automatically when the PR opens against `main`.
2. Dispatch `merge-gate` on the PR (background). It reviews the whole diff vs `main`, runs `crypto-reviewer` when crypto/auth paths appear, and arms `gh pr merge --squash --auto --delete-branch`.
3. If `merge-gate` returns `PENDING: crypto verdict`, `SendMessage` the **same** `merge-gate` agent to finish. Never start a second `crypto-reviewer` or `merge-gate` for the same PR.
4. Report **armed** / **blocked** / **pending** with the PR URL. Armed means GitHub merges when the required `ci` check is green; if CI later goes red the PR just stays open, so re-run `/gate <pr>` to see the failing jobs.
5. **Post-merge sync** (only when `gh pr view <n> --json state -q .state` is `MERGED`; this command is safe to re-run later): `git fetch origin --prune`. Only if the current branch is `main` and `git status --porcelain` is empty, run `git pull --ff-only`; otherwise skip and say why (wrong branch, dirty tree, non-fast-forward). Never stash, reset, or force. Delete leftover local `issue-<n>-*`, `feat/<slug>` and `worktree-agent-*` branches **only** when their PRs are confirmed `MERGED` and no worktree under `.claude/worktrees/` still uses them (`git branch -D`, since squash merges leave commits unmerged by SHA). Report what was pulled and deleted. If an api lane ran, remind the human to run `moon run api:db-prune` or `moon run api:db-drop`.
6. Remind the human: **/clear before the next batch.**
