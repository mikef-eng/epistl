---
description: Run Coder → Tester → Reviewer for one issue. Usage: /ship <issue-number>
---

Orchestrate shipping GitHub issue #$ARGUMENTS in the **main** thread (subagents cannot chain each other):

1. Run the `coder` subagent for issue #$ARGUMENTS (same as `/work-issue`). Wait for the PR.
2. Read the Coder's `## Testing recommendation` classification in the PR description. If it says "Logic-affecting — recommend Tester", run the `tester` subagent on that PR (same as `/test-pr`); if the issue is labeled `blocked`, **stop** and report failures — do not continue. If it says "Non-logic ... Tester likely unnecessary", skip this step and go straight to step 3.
3. Run the `reviewer` subagent on that PR (same as `/review-pr`). The Reviewer independently re-checks the classification; if it disagrees and decides the change is actually logic-affecting, it will hold off on merging and ask for a Tester pass instead of merging on its own sign-off. If that happens, run the `tester` subagent at that point, then re-run the `reviewer` subagent.

Report the final PR URL, labels, and merge status.
