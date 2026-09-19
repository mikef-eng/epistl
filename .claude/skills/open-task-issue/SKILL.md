---
name: open-task-issue
description: Create a GitHub Task issue with Goal, Acceptance criteria, Out of scope, and Notes. Use when planning work or spinning scope creep into a new issue.
---

# Open Task Issue

Create a GitHub issue that matches Epistl's Task template.

## Required sections (all non-empty)

1. **Goal** — what success looks like
2. **Acceptance criteria** — concrete, testable bullets
3. **Out of scope** — what must not land in the PR
4. **Notes** — context, links, constraints (can be brief but not blank; use "None" if truly empty)

## Labels

Pass an explicit **state** label (exactly one):

- `planning` — default when refining toward `ready`
- `backlog` — deferred / later-work (scope creep that should not expand the current PR, or untriaged)

Add **type** labels when applicable: `bug`, `feature-request`, or `enhancement` (see `AGENTS.md`). For `bug`, at least one acceptance criterion must be a **regression test that reproduces the defect**.

## Procedure

1. Draft the four sections. Reject vague criteria ("add login") and rewrite until testable.
2. Create the issue with `gh` (replace `<state-label>` and optional `--label` type flags):

```bash
gh issue create \
  --title "<Area: concise title>" \
  --label "<state-label>" \
  --body "$(cat <<'EOF'
## Goal

<goal>

## Acceptance criteria

- [ ] <criterion>
- [ ] <criterion>

## Out of scope

- <item>

## Notes

<notes>
EOF
)"
```

Example state labels: `--label "planning"` or `--label "backlog"`. Add `--label "bug"` (and keep an area title prefix) for defects.

3. Return the issue URL and number.
4. Do **not** label `ready` here unless you explicitly completed the Planner self-review that a lane agent needs no clarifying questions.
