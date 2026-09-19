---
name: open-task-issue
description: Create a GitHub Task issue with Goal, Acceptance criteria, Out of scope, and Notes. Use when planning work or spinning scope creep into a new issue. Applies the planning label.
---

# Open Task Issue

Create a GitHub issue that matches Epistl's Task template.

## Required sections (all non-empty)

1. **Goal** — what success looks like
2. **Acceptance criteria** — concrete, testable bullets
3. **Out of scope** — what must not land in the PR
4. **Notes** — context, links, constraints (can be brief but not blank; use "None" if truly empty)

## Procedure

1. Draft the four sections. Reject vague criteria ("add login") and rewrite until testable.
2. Create the issue with `gh`:

```bash
gh issue create \
  --title "<concise title>" \
  --label "planning" \
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

3. Return the issue URL and number.
4. Do **not** label `ready` here unless you explicitly completed the Planner self-review that a lane agent needs no clarifying questions.
