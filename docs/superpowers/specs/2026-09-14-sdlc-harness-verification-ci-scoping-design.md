# SDLC harness: verification responsibility, CI path-scoping, and Planner bundling — design

Status: approved by user in brainstorming; ready for implementation plan.

## Context

Epistl's Coder → Tester → Reviewer pipeline (`AGENTS.md`, `.claude/agents/*.md`) and CI (`.github/workflows/ci.yml`) grew organically and now has two efficiency problems, both surfaced while shipping issue #121 (a flaky-test fix) end-to-end:

1. **Redundant test execution across roles.** Coder writes and runs tests locally via `moon`, Tester re-runs the full suite to confirm, sometimes Reviewer does too, and CI runs everything again on top — for issue #121 this meant the full `moon` suite ran 3x and an expensive 40x flake-reproduction loop ran 2-3x, across a single issue's lifecycle. `AGENTS.md` already establishes `moon` as the single source of truth CI runs against specifically to kill local/CI divergence — the current playbooks don't yet take advantage of that guarantee to stop re-deriving the same "does it pass" signal.
2. **Planner issue granularity too fine for low-risk UI work.** 8+ separate GitHub issues exist for what is really one mobile screen's worth of related, low-risk changes (dark mode toggle, settings scaffold + nav, dark mode visual pass, log out flow, delete account flow) — each paying the full issue → branch → PR → CI → three-agent-review ceremony for a 20-30 minute change. Current guidance ("aim for under a day of work each") gives no bundling heuristic.
3. **(Discovered mid-brainstorm) CI runs every project's full suite on every PR regardless of what changed.** `apps/api`, `apps/mobile`, and `packages/quic-relay-client` each get their own always-on job. `apps/api` and `packages/quic-relay-client` share a single Cargo workspace (root `Cargo.toml`, one `Cargo.lock`). Branch protection on `main` only requires `["api", "mobile"]` as status checks — `quic-relay-client` is not required, despite its own crate description now describing it as real production code backing `apps/api`'s QUIC listener (QUIC became the default transport in #116), not the "spike" its `package.json` `description` field still calls it.

## Decisions made during brainstorming

1. **Bundling shape**: fewer, larger GitHub issues from the start (one issue = the whole bundle, one PR) — not granular issues bundled at PR time. Keeps the Coder's existing "one issue, one branch, one PR" rule intact.
2. **Bundling criteria**: gate bundling on *same screen/surface* + *each sub-change independently low-risk*. No time-budget cap layered on top — Planner judgment, not a hard day-cap, decides when a screen's bundle has grown too large.
3. **Flake/repeated-verification acceptance criteria** (the one case CI's single pass structurally cannot confirm): Tester always fully independently re-runs the stated N itself — never just audits the Coder's reported methodology/numbers. This is intentional, non-wasteful duplication.
4. **CI job-level path scoping**: add a `changes` detection job to `.github/workflows/ci.yml`, using the same `git diff --name-only <base> <head> | grep -E ...` technique the file's existing `crypto-review-notice` job already uses (no new third-party action). Gate `api`, `mobile`, and `quic-relay-client` jobs behind it. Apply only to `pull_request` runs; `push` to `main` stays unfiltered as a cheap, infrequent "main is fully green post-merge" safety net.
5. **Bundle the `quic-relay-client` required-status-check fix into this same change** (default chosen since the user didn't specify otherwise; easy to split out later if desired) — add it to branch protection's required contexts alongside `api` and `mobile`.

## Design

### Verification responsibility across roles

The goal: each role verifies something only *it* can add, instead of re-deriving "does the suite pass" — which `moon`/CI parity already answers authoritatively once CI runs.

- **Coder** (`.claude/agents/coder.md`, `AGENTS.md` Coder playbook): unchanged for the TDD inner loop — local `moon run api:check`/`api:lint`/`api:test` (or mobile equivalents) during red→green→refactor is how the fix gets built, not duplicate verification. No longer expected to do one more full-suite pass purely to reconfirm before opening the PR; push and let CI confirm. For issues whose acceptance criteria require empirical/repeated verification (e.g. flake closure), Coder still runs that investigation loop itself, since that's how the fix is developed and its root cause confirmed — not a redundant check.
- **Tester** (`.claude/agents/tester.md`, `AGENTS.md` Tester playbook): stops re-running the full `moon` suite as a pass/fail re-check once CI is green on the exact commit under review — trusts CI for that. Redirects effort into **coverage auditing**: does a real test exist for each acceptance-criteria bullet, does it actually exercise the claimed behavior (read the test, don't just trust the PR description's claims), and are there gaps to fill. The existing "may add or fix tests" power is unchanged, and Tester obviously runs anything it adds or changes itself — that's new signal, not duplication. **Explicit carve-out**: for acceptance criteria requiring repeated/probabilistic verification (flake-reproduction loops and similar), Tester always fully independently re-runs the stated N — decision 3 above. If CI hasn't finished, Tester waits for it (or checks/re-triggers via `gh run watch` etc.) rather than substituting a local run.
- **Reviewer** (`.claude/agents/reviewer.md`, `AGENTS.md` Reviewer playbook): never re-runs test suites. Trusts CI-green + Tester's `needs-review` label entirely for correctness, and spends its whole budget on diff-level review — scope creep, conventions, security, docs freshness, and crypto-reviewer delegation where applicable (that gate is unaffected by this design).
- **CI**: unchanged in role — remains the one authoritative, deterministic "does it pass" signal for the normal (non-repeated) suite.

Net effect: normal-suite duplication drops from ~3x (Coder, Tester, CI) to Coder's dev-loop runs plus one CI pass; full duplication is preserved exactly where it isn't wasteful (flake-class checks, and any test Tester itself writes or fixes).

### Planner bundling rule

Add to the Planner playbook (`AGENTS.md`, `.claude/agents/planner.md`):

- **May bundle** multiple small changes into a single issue (single Goal/Acceptance-criteria/Out-of-scope/Notes, multiple separable and independently testable acceptance-criteria bullets, one PR) when **all** bundled changes touch the same screen/user-facing surface **and** each is independently low-risk: no new dependency, no data-model/migration change, no cross-cutting shared state, not on the hard-exclusion list below.
- **Hard exclusions — always stay atomic (one issue each), regardless of size or how related they look**: anything touching `apps/api/src/crypto/**`, `apps/api/src/auth/**`, `apps/mobile/src/crypto/**`; any database migration or data-model change; any new dependency; anything that would warrant a `docs/decisions/` entry per `AGENTS.md`'s existing "Architecture decisions" criteria.
- No fixed time-budget cap on top of the same-screen/low-risk gate (decision 2) — if a screen's bundle grows large enough that Planner judgment says it no longer reads as one coherent day-or-so of work, split along a natural sub-boundary rather than reverting to one-issue-per-tiny-change.

### CI job-level path scoping

Add a `changes` job to `.github/workflows/ci.yml`, running first, computing three boolean outputs (`api`, `mobile`, `quic_relay_client`) via `git diff --name-only` between the PR's base and head SHAs (mirroring `crypto-review-notice`'s existing technique) matched against these path sets:

| Job | Paths that mark it affected |
| --- | --- |
| `api` | `apps/api/**`, `Cargo.toml`, `Cargo.lock`, `.github/workflows/ci.yml`, `.moon/**` |
| `mobile` | `apps/mobile/**` (already covers the nested `modules/quic-relay-client` TurboModule wrapper), `.github/workflows/ci.yml`, `.moon/**` |
| `quic-relay-client` | `packages/quic-relay-client/**`, `Cargo.toml`, `Cargo.lock`, `.github/workflows/ci.yml`, `.moon/**` |

`Cargo.toml`/`Cargo.lock` are included for both `api` and `quic-relay-client` because they share one Cargo workspace — a dependency bump in one project's manifest can change the shared lockfile's resolved versions for the other. `.github/workflows/ci.yml` is included everywhere so a change to the pipeline itself always re-validates every job it defines.

Each of `api`, `mobile`, `quic-relay-client` gains `needs: changes` and an `if:` on its corresponding output. This scoping applies **only** when `github.event_name == 'pull_request'`; `push` to `main` keeps running all three jobs unconditionally, since post-merge runs are infrequent and act as a cheap safety net that `main` itself is fully green, not just the subset of what the last PR touched.

Because the gated jobs stay in the *same* workflow file (rather than moving to separate workflow files with their own `on.pull_request.paths:` triggers), a skipped job still reports a status GitHub's required-status-checks feature accepts as satisfied, rather than leaving `main`'s `strict: true` required checks pending forever. This must be confirmed empirically during implementation (e.g. open a real PR touching only `apps/mobile/**` and confirm the `api` required check shows as skipped/passing, not stuck pending) before relying on it.

### `quic-relay-client` required status check

Add `quic-relay-client` to `main`'s branch protection `required_status_checks.contexts` (currently `["api", "mobile"]`), matching the fact that it now backs production QUIC transport rather than being an unused spike.

## File-level changes

1. `AGENTS.md` — Tester playbook: replace "re-run local suite" language with CI-trust + coverage-audit language, and state the flake/repeated-verification carve-out explicitly. Reviewer playbook: state it never re-runs test suites. Planner playbook: add the bundling rule and hard-exclusion list. Add a short note describing the new CI path-scoping behavior (so a Coder/Tester isn't confused when a job shows as skipped on their PR).
2. `.claude/agents/tester.md` — same redirection as above, **and** fix the stale "Local checks: `apps/mobile` → `npm run lint`, `npm run typecheck`, `npm test`; API → `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`" line, which already contradicts `AGENTS.md`'s `moon`-only mandate today (a pre-existing bug, unrelated to this design, fixed here since the file is already being edited).
3. `.claude/agents/reviewer.md` — add an explicit "never re-run test suites; trust CI + Tester" rule.
4. `.claude/agents/planner.md` — add the bundling heuristic and hard-exclusion list.
5. `.claude/agents/coder.md` — no rule change required (TDD inner loop is unchanged); add a one-line note that a final pre-PR full-suite re-run is not required since CI covers it.
6. `.github/workflows/ci.yml` — add the `changes` job; add `needs`/`if` to `api`, `mobile`, `quic-relay-client`.
7. `main` branch protection (GitHub repo settings, via `gh api`) — add `quic-relay-client` to required status check contexts.

## Testing / verification

This is a process and CI-config change, not application code — verification is behavioral rather than unit-testable:

- After implementation, open a throwaway PR touching only `apps/mobile/**` and confirm: `mobile` job runs, `api` and `quic-relay-client` jobs show as skipped, and — critically — the `api` required check does not leave the PR stuck in a pending state.
- Open a throwaway PR touching only `Cargo.lock` (or a shared dependency bump) and confirm both `api` and `quic-relay-client` jobs run (proving the shared-workspace path inclusion works).
- Confirm a PR touching `.github/workflows/ci.yml` itself runs all three jobs regardless of other paths touched.
- No repo test suite changes are needed for this design itself; the next few real issues shipped through the updated playbooks are the actual validation that Tester/Reviewer changes hold up in practice.

## Out of scope

- Changing `crypto-reviewer`'s own checklist or gating logic — untouched by this design.
- Introducing `dorny/paths-filter` or any other third-party GitHub Action — the existing `git diff`/`grep` pattern already in `crypto-review-notice` is reused instead.
- Restructuring the Cargo workspace, or adopting `moon ci`/`moon run --affected` as a replacement for the existing per-project `moon run <task>` invocations inside each job — job-level path scoping (skipping the runner/setup entirely) is the actual problem being solved here, which task-level `--affected` doesn't address on its own.
- Fixing `apps/mobile/modules/quic-relay-client/package.json`'s stale `"Spike (issue #67)"` description text — a minor, unrelated doc-staleness nit, not required for this design.
- Issue #111 (`quic-relay-client`'s compiled `lib/` drift) and issue #118/relay.rs's own pre-existing flake — both already tracked separately and untouched by this design.

## Notes

- Originated from a live retrospective while shipping issue #121 end-to-end (Coder → Tester → Reviewer → merge), where the redundant-verification pattern and CI's always-on job structure were both observed directly.
- The user selected the "fewer, larger issues" bundling shape, the "same screen/surface + low risk" bundling gate (no time cap), and "always fully independently re-run" for flake-class verification via explicit choices during brainstorming — these are decisions, not defaults, and shouldn't be revisited without going back through this document.
