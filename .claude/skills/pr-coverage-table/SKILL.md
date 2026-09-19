---
name: pr-coverage-table
description: Required PR body Coverage table mapping each acceptance criterion to a test. Used by lane agents and merge-gate.
---

# PR coverage table

Every **lane-agent** PR body (`api` / `mobile` / `native`) must include:

## Coverage

| Acceptance criterion | Test |
| --- | --- |
| <exact AC bullet from the issue> | `path/to/test.rs::test_name` or `path/to/file.test.ts` |

One row per acceptance-criterion bullet. If an AC is not reasonably unit-testable (pure docs/config), put `n/a — <reason>` and make sure merge-gate can verify by inspection.

Also include:

## Lane

`api` | `mobile` | `native` | `chore`

## Testing recommendation

- **Logic-affecting** (default for any `apps/*/src/**`, migrations, assertion changes), or
- **Non-logic (config/CI/docs/tooling only)** — merge-gate may verify without expecting a full coverage table of product tests.

**Chore PRs** (`## Lane: chore`) omit the Coverage table and `Closes #N`. Use `## Testing recommendation: non-logic` instead. Keep this skill and [`.github/PULL_REQUEST_TEMPLATE.md`](../../.github/PULL_REQUEST_TEMPLATE.md) lane values in sync.

`merge-gate` checks each Coverage row points at a real test that exercises the claimed behavior — it does not re-derive the table from scratch. For chore PRs it skips the Coverage check and still enforces scope and docs freshness.
