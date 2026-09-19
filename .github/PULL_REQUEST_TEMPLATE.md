## Summary

<!-- What does this PR do, and why? -->

Closes #<!-- issue number, if applicable; omit for chore -->

## Lane

<!-- api | mobile | native | chore -->

## Coverage

<!-- Required for api / mobile / native. For chore: omit this section or use a single n/a row. -->

| Acceptance criterion | Test |
| --- | --- |
| <!-- AC bullet from the issue --> | <!-- path::test_name or n/a — reason --> |

## Testing recommendation

<!-- Logic-affecting — recommend full Coverage table | Non-logic (config/CI/docs/tooling only) — use for chore -->

## Checklist

- [ ] Every acceptance criterion is covered in the Coverage table (or marked n/a with reason) — skip for chore
- [ ] `README.md` / `docs/architecture/overview.md` updated if this PR changes the stack, how to run something, an env var, or an architectural constraint
- [ ] If this PR touches `apps/api/src/crypto/**`, `apps/api/src/auth/**`, or `apps/mobile/src/crypto/**`: the `pqc-crypto-change` checklist was run and `crypto-reviewer` sign-off is attached below

## Crypto/auth sign-off (only if applicable)

<!-- Paste crypto-reviewer's approve/block notes here, or delete this section if not applicable. -->
