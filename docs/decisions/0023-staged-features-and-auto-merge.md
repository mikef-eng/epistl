# 0023: Staged features and auto-merge replace per-PR CI waiting

Supersedes [0021](0021-ci-cost-trip-wire.md). Amends the Gate row and flow
of [0019](0019-harness-area-lanes.md).

## Context

On 2026-09-20 shipping one cross-lane feature (#173 mobile, #249 API,
#250 native) plus CI work exposed where the per-issue PR flow costs time:

- One feature became several PRs landed in a hand-managed order, so
  `main` held half-built pieces, and a crypto module was reviewed without
  its consumers (two review rounds).
- Every PR paid the full pipeline: CI, a `ci-watch` agent blocking on it,
  `merge-gate`, and sometimes a rerun because branch protection required
  the branch to be up to date (`strict: true`). `ci-watch` (haiku, 12
  turns) repeatedly ran out of turns while blocking.
- CI itself was not the problem once fixed: warm `rust (api)` fell from
  4m53s to 2m56s (#254, sccache + nextest), meeting 0021's ~3 minute
  target. The cost was an agent sitting blocked on it, on every PR.
- The project is solo and pre-release; lane agents already run the full
  moon checks locally, and outside PRs are declined.

## Decision

1. **Stop waiting, keep CI.** `merge-gate` arms
   `gh pr merge --squash --auto --delete-branch` and returns. GitHub
   merges when the required `ci` check is green. `ci-watch` is removed.
2. **Staged features.** A multi-issue feature stages its lane PRs onto
   `feat/<slug>` (off `main`, created by `/ship`). Lane PRs into a
   non-`main` base run no CI (`ci.yml` triggers on PRs to `main` only) and
   are merged immediately with a light check. `/gate feat/<slug>` opens the
   **single** PR into `main` (`Closes #N` for every staged issue, each lane's
   Coverage pasted in). CI, `crypto-reviewer` and `merge-gate` run once, on
   the whole diff vs `main`. A single-issue change still opens its PR
   straight to `main`. The PR is opened at the end, not as an early draft:
   GitHub cannot open a PR with no commits, and gating drafts by skipping
   jobs would report the required check as skipped, which (as we understand
   GitHub's behavior; unverified here) counts as passing for a required
   check and could let auto-merge fire before the real run, so it is not
   used.
3. **`strict` off.** Branch protection no longer requires branches to be
   up to date with `main`; `ci` stays required and `enforce_admins` stays
   on. `main`-push CI is the async safety net for semantic conflicts.
4. **Crypto.** `crypto-reviewer` approves a specific head SHA; `merge-gate`
   re-reads `headRefOid` and arms auto-merge only if it is unchanged. No
   crypto/auth code reaches `main` without that sign-off (AGENTS.md
   invariant 5 unchanged).
5. **Trip-wire retired.** CI is not dropped or made non-blocking. 0021's
   condition (roughly under 3 minutes) is met.

## Consequences

- Fewer merges to `main`, one gate per feature; lane parallelism is kept
  (each lane still has its own worktree and branch).
- A red CI run after arming leaves the PR open and unmerged rather than
  blocking anyone; `/gate <pr>` re-run shows the failing jobs.
- `strict: false` can let a stale branch merge; the `main` push run
  catches breakage.
- Staged feature branches must stay short-lived (days) to limit drift;
  `/ship` cuts them from fresh `main`.
- `merge-gate` runs once per feature with more turns/effort, so it must
  read test bodies and list the files it read.
- Repo settings changed alongside this ADR: `allow_auto_merge` enabled,
  `strict` disabled on `main` protection.
