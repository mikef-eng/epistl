---
name: open-task-issue
description: Create a Linear Task issue with Goal, Acceptance criteria, Out of scope, and Notes. Use when planning work or spinning scope creep into a new issue. Leaves it in the Backlog state; GitHub's mirror issue is created automatically by Linear's sync.
---

# Open Task Issue

Create a Linear issue on the `Epistl` team that matches Epistl's Task template. Linear's two-way GitHub sync automatically mirrors it to a GitHub issue in this repo — do not also create a GitHub issue by hand.

## Required sections (all non-empty)

1. **Goal** — what success looks like
2. **Acceptance criteria** — concrete, testable bullets
3. **Out of scope** — what must not land in the PR
4. **Notes** — context, links, constraints (can be brief but not blank; use "None" if truly empty)

## Title convention

`<Area>: <description>` — e.g. `Mobile: FriendsScreen local search filter`, `API: contacts.rs — mutual removal + cancel outgoing request endpoints`.

## Procedure

1. Draft the four sections. Reject vague criteria ("add login") and rewrite until testable.
2. Create the issue with the Linear MCP tool:

```
mcp__linear-server__save_issue(
  team: "Epistl",
  title: "<Area>: <concise title>",
  description: "## Goal\n\n<goal>\n\n## Acceptance criteria\n\n- [ ] <criterion>\n- [ ] <criterion>\n\n## Out of scope\n\n- <item>\n\n## Notes\n\n<notes>"
)
```

Pass the description with literal newlines (the tool does not want escape sequences), not the literal two-character sequence `\n`. Leave `state` unset — new issues default to the team's `Backlog` state.

3. Return the issue identifier (e.g. `EPI-42`) and URL from the tool result.
4. Do **not** move it to `Todo` here unless you explicitly completed the Planner self-review that a Coder needs no clarifying questions.
