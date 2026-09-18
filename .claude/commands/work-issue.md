---
description: Implement one ready GitHub issue. Usage: /work-issue <issue-number>
---

Delegate to the `coder` subagent for GitHub issue #$ARGUMENTS.

Follow the Coder playbook in AGENTS.md: read only that issue, branch `issue-<n>-<slug>`, implement scope only, open a PR with `Closes #<n>`, label `in-progress`. Scope creep becomes a new issue via `open-task-issue`.
