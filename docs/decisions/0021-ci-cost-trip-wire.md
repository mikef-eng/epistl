# 0021: CI speed trip-wire — GitHub CI checks are droppable until outside PRs

## Context

On 2026-09-20 a ~50-line, single-file API change (#245 / PR #246) took
about nine minutes of GitHub CI: `rust (api)` spent 152 s in Clippy and
366 s in tests. Most of that was cold compilation. Investigation showed
the `sccache` cache was effectively empty on every run: the cache key
hashed only `Cargo.lock`, `actions/cache` entries are immutable, so the
first run for a lockfile saved a ~1 MB entry that every later run
restored, rebuilt everything from (1,466 misses), and then refused to
overwrite ("Cache hit occurred on the primary key, not saving cache").

Each lane's PR also waits on `ci-watch` and `merge-gate`, so slow CI
directly stretches every ship. During a solo, pre-release phase there
are no outside contributors whose PRs need a gate.

## Decision

1. `chore-ci-cache-and-watch` makes the `sccache` cache useful: restore
   the newest entry (per matrix project), and save a fresh entry per
   commit only from pushes to `main`. It also fixes `ci-watch` giving up
   on runs longer than the Bash tool's default timeout.
2. **Trip-wire.** If, after that lands and `main` has produced a warm
   cache, typical PR CI for an API change does **not** drop drastically
   (target: roughly under 3 minutes for a small `apps/api` diff, versus
   ~9 minutes before), we will consider removing the GitHub CI checks
   (or making them non-blocking) until we start accepting outside PRs.
   Slowing development is not acceptable just because a check is best
   practice.
3. If removed, `moon run <project>:check|lint|test` (already required
   locally by `AGENTS.md` invariant 2) becomes the only gate, `merge-gate`
   stops requiring green CI, and CI is re-enabled before the first
   outside PR is accepted. That change gets its own ADR superseding this
   one.

## Consequences

- Measure before deciding: compare `rust (api)` wall time on a small API
  PR after a `main` push has saved a cache against the ~9 min baseline
  above. Until a `main` push saves a cache, PR runs are still cold, so do
  not judge the fix from the first PR after it merges.
- Dropping CI removes the safety net that caught the environment-specific
  failures in this session's lanes (e.g. stale `node_modules` masking real
  results locally), so that trade-off must be weighed at decision time.
