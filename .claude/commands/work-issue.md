---
description: Implement one ready Linear issue. Usage: /work-issue <linear-id>
---

Delegate to the `coder` subagent for Linear issue $ARGUMENTS.

Follow the Coder playbook in AGENTS.md: read only that issue, branch `<linear-id>-<slug>`, implement scope only, open a PR with `Closes #<gh-number>` against the GitHub mirror issue, move the issue to `In Progress`. Scope creep becomes a new issue via `open-task-issue`.
