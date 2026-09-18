---
description: Final review and merge gate for a PR. Usage: /review-pr <pr-number>
---

Delegate to the `reviewer` subagent for pull request #$ARGUMENTS.

Follow the Reviewer playbook in AGENTS.md: confirm the linked Linear issue is in `In Review`. If the diff touches crypto/auth paths, require `crypto-reviewer` sign-off before approving. Merge only when CI is green and criteria are met.
