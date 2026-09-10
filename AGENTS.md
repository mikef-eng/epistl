# Agent / contributor conventions

Epistl uses a controlled SDLC harness so humans and AI agents work through small, trackable issues instead of vibe-coding straight into the repo.

## Single source of truth

- Every unit of work is a **GitHub Issue**.
- Nothing gets built without an issue.
- Acceptance criteria are written **before** implementation starts, never after.

## Roles and handoffs

| Role | Responsibility |
| --- | --- |
| **Planner** | Breaks the goal into small tasks; opens issues with clear goal, acceptance criteria, and out of scope. Labels `planning`, then `ready` when unambiguous. |
| **Coder** | Implements **one** `ready` issue at a time. Creates a branch, opens a PR that closes the issue. Extra discoveries become new issues — not scope on the current branch. |
| **Tester** | Runs CI, adds tests for acceptance criteria when missing, checks the PR against criteria line by line. Failures → PR comment + `blocked`. Pass → `needs-review`. |
| **Reviewer** | Final pass on quality, security, conventions, and scope. Merge only when CI is green and criteria are met. |

Deep role prompts and checklists will be added in a later harness pass.

## Labels

| Label | Meaning |
| --- | --- |
| `planning` | Issue is being refined; not ready for implementation |
| `ready` | Clear enough for the Coder |
| `in-progress` | Actively being implemented |
| `blocked` | Waiting on a fix or decision |
| `needs-review` | Tester passed; awaiting Reviewer |
| `bug` | Defect against expected behavior |
| `backlog` | Idea not ready for Planner/Coder yet |

Flow: `planning` → `ready` → `in-progress` → (`blocked` \| `needs-review`) → merge/close.

## Coder rules

1. Read **only** the assigned issue — do not load the whole backlog into context.
2. Branch name: `issue-<number>-<short-slug>` (e.g. `issue-42-login-form`).
3. One issue, one branch, one PR.
4. PR body must reference the issue with `Closes #<number>`.
5. Label the issue `in-progress` while working.
6. Scope creep → open a new issue; do not expand the current PR.

## Tester rules

1. CI must be green (lint, build, test).
2. Verify each acceptance criterion explicitly.
3. On failure: comment with specifics and set `blocked`.
4. On pass: set `needs-review`.

## Issue template

Use the Task template. Required sections:

- **Goal** — what success looks like
- **Acceptance criteria** — testable, concrete bullets (not "add login")
- **Out of scope** — what must not land in this PR
- **Notes** — context, links, constraints

## For AI coding agents

Feed **one issue at a time**. Pasting the full backlog dilutes focus and causes scope creep.
