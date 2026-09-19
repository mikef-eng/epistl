---
description: CI-watch then merge-gate for a PR opened outside /ship. Usage: /gate <pr-number>
---

Run the post-PR gate for pull request #$ARGUMENTS:

1. Dispatch `ci-watch` for PR #$ARGUMENTS. If red, report failing jobs and stop.
2. Dispatch `merge-gate` for that PR (pass the CI-green confirmation). It verifies the Coverage table, scope, docs freshness, and crypto-reviewer when needed, then squash-merges or blocks.

Report the final PR URL and merge status.
