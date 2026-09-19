---
name: systematic-debugging
description: Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes
---

# Systematic Debugging

**Iron law:** no fixes without root-cause investigation first. Symptom fixes are failure.

## Phase 1 — Root cause

1. Read the full error / stack trace (line numbers, codes).
2. Reproduce consistently; if not reproducible, gather more data — don't guess.
3. Check recent changes (`git diff`, new deps, env).
4. In multi-component systems, instrument boundaries and find *where* it breaks before proposing a fix.
5. Trace bad values backward to their source; fix at source.

## Phase 2 — Pattern

Find a working example in the same codebase. Diff working vs broken. List every difference. Understand dependencies and assumptions.

## Phase 3 — Hypothesis

One hypothesis: "X is the root cause because Y." Smallest change to test it. One variable at a time. If it fails, new hypothesis — don't stack fixes.

## Phase 4 — Implement

Create a failing test that reproduces the bug, then one fix. Use `test-driven-development`. Verify the original failure is gone and nothing else broke.

## Don't

- "Just one quick fix" under time pressure
- Multiple simultaneous changes
- Claiming you understand X when you don't — say so and investigate
