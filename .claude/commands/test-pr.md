---
description: Test a pull request against acceptance criteria. Usage: /test-pr <pr-number>
---

Delegate to the `tester` subagent for pull request #$ARGUMENTS.

Follow the Tester playbook in AGENTS.md: CI green, line-by-line acceptance criteria, comment + move the issue to `Blocked` on failure, `In Review` on pass.
