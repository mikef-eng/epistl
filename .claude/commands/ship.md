---
description: Run Coder → Tester → Reviewer for one issue. Usage: /ship <issue-number>
---

Orchestrate shipping GitHub issue #$ARGUMENTS in the **main** thread (subagents cannot chain each other):

1. Run the `coder` subagent for issue #$ARGUMENTS (same as `/work-issue`). Wait for the PR.
2. Run the `tester` subagent on that PR (same as `/test-pr`). If the issue is moved to `Blocked`, **stop** and report failures — do not continue.
3. Run the `reviewer` subagent on that PR (same as `/review-pr`).

Report the final PR URL, labels, and merge status.
