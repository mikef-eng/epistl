---
name: test-driven-development
description: Use when implementing any feature or bug fix, before writing implementation code
---

# Test-Driven Development (TDD)

Write the test first. Watch it fail. Write minimal code to pass.

**Iron law:** no production code without a failing test first. If you wrote implementation first, delete it and start from the test.

## When

Always for new features, bug fixes, refactoring, behavior changes. Skip only for throwaway prototypes, generated code, or pure config (ask if unsure).

## Red → Green → Refactor

1. **RED** — One minimal failing test for one behavior. Clear name. Prefer real code over mocks.
2. **Verify RED** — Run it (via moon: `moon run api:test -- <filter>` or `moon run mobile:test -- <path>`). Confirm it fails for the right reason (feature missing, not a typo).
3. **GREEN** — Smallest code that passes. No extra features, no drive-by refactors.
4. **Verify GREEN** — Same test pass; suite still green for what you touched.
5. **REFACTOR** — Clean names/duplication while staying green. Then next failing test.

## Anti-patterns

- Testing mocks instead of behavior
- Over-engineering the green step
- Skipping the red verification
- Fixing the test when the code is wrong (or vice versa without evidence)
