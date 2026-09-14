# SDLC Harness: Verification Responsibility, CI Path-Scoping, and Planner Bundling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop redundant test re-execution across Coder/Tester/Reviewer/CI, scope CI jobs to the paths they actually cover, make `quic-relay-client` a required status check, and let the Planner bundle low-risk same-screen UI work into fewer issues.

**Architecture:** This is a docs/policy/CI-config change, not application code — no new subsystem, no runtime behavior change to the product itself. Each task edits one file (or one GitHub setting) that governs the SDLC harness: `AGENTS.md` (the canonical playbooks), the four `.claude/agents/*.md` role definitions that must stay consistent with it, `.github/workflows/ci.yml` (the CI pipeline itself), and `main`'s branch protection settings.

**Tech Stack:** Markdown (`AGENTS.md`, `.claude/agents/*.md`), GitHub Actions YAML (`.github/workflows/ci.yml`), GitHub REST API via `gh api` (branch protection), `moon` (task runner referenced by the playbooks), `git`/`gh` CLI for verification.

**Spec:** `docs/superpowers/specs/2026-09-14-sdlc-harness-verification-ci-scoping-design.md` — read it in full before starting; this plan implements its decisions verbatim and does not re-derive them.

## Global Constraints

- Do not change `crypto-reviewer`'s checklist or gating logic — out of scope per the spec.
- Do not introduce `dorny/paths-filter` or any other third-party GitHub Action — reuse the `git diff --name-only | grep -E` technique already used by `.github/workflows/ci.yml`'s existing `crypto-review-notice` job.
- Do not restructure the Cargo workspace or adopt `moon ci`/`moon run --affected` — job-level path scoping (skipping runner setup entirely) is the problem being solved, not task-level caching.
- Do not touch `apps/mobile/modules/quic-relay-client/package.json`'s stale `"Spike (issue #67)"` description — out of scope per the spec.
- Do not touch issue #111 or #118 — tracked separately, unrelated to this plan.
- CI path-scoping (the new `changes` job and its gating) applies **only** to `pull_request` events; `push` to `main` must keep running `api`, `mobile`, and `quic-relay-client` unconditionally.
- Every markdown edit in this plan is a **surgical** edit (Edit tool, old_string/new_string) — do not rewrite whole files.

---

### Task 1: `AGENTS.md` — Tester/Reviewer/Planner playbooks + CI job scoping note

**Files:**
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: decisions from spec sections "Verification responsibility across roles", "Planner bundling rule", "CI job-level path scoping".
- Produces: the canonical playbook text that Tasks 2-5 (`.claude/agents/*.md`) must stay consistent with — those files say "Follow the **X playbook** in `AGENTS.md` exactly," so this task's wording is the source of truth they point back to.

- [ ] **Step 1: Edit the Tester playbook**

Replace:
```markdown
## Tester playbook

1. Confirm CI is green (lint, build, test) for the PR.
2. Run the local suite if needed, via moon (matching CI exactly — see README's "Local commands" section): `moon run mobile:lint`, `moon run mobile:typecheck`, `moon run mobile:test` for `apps/mobile`; `moon run api:check`, `moon run api:lint`, `moon run api:test` for `apps/api`. Do not substitute raw `cargo`/`npm` invocations, and do not manually `source .env`/`set -o allexport` before them — moon's task definitions are the actual source of truth CI runs against (a raw command can silently diverge from it), and moon already loads `.env` for every task, so manual sourcing is redundant. Need a filtered or repeated run (e.g. one test name, looped N times to chase a flake)? Use moon's `--` passthrough rather than dropping to raw `cargo`/`npm`: `moon run api:test -- <test_name_filter>` runs as `cargo test <test_name_filter>` with env already loaded, and that can be wrapped in a shell loop the same way a raw command could.
3. Verify **each** acceptance criterion on the linked issue line by line — not just "does it run."
4. Add tests for acceptance criteria when none exist and they are reasonably testable in this PR.
5. On failure: comment on the PR with specifics and set the issue label to `blocked`.
6. On pass: set the issue label to `needs-review`.
```

With:
```markdown
## Tester playbook

1. Confirm CI is green (lint, build, test) for the PR — this is the authoritative "does it pass" signal. `moon`/CI parity is guaranteed by convention (see README's "Local commands" section), so do **not** re-run the full local suite just to reconfirm what a green CI already tells you. If CI hasn't finished, wait for it (or check/re-trigger via `gh run watch`) rather than substituting a local run.
2. Verify **each** acceptance criterion on the linked issue line by line — not just "does it run." Audit coverage: confirm a real test exists for each criterion and actually exercises the claimed behavior — read the test, don't just trust the PR description's claims.
3. Add or fix tests for acceptance criteria when coverage is missing or wrong, and reasonably testable in this PR. Run anything you add or change yourself, via moon (matching CI exactly — see README's "Local commands" section): `moon run mobile:lint`, `moon run mobile:typecheck`, `moon run mobile:test` for `apps/mobile`; `moon run api:check`, `moon run api:lint`, `moon run api:test` for `apps/api`. Do not substitute raw `cargo`/`npm` invocations. This is new verification you're adding, not a re-check of what CI already confirmed.
4. **Exception — repeated/probabilistic verification criteria** (e.g. a flake-reproduction loop the PR claims to have closed): CI's single pass structurally can't confirm this. Always fully independently re-run the stated N yourself, using moon's `--` passthrough (e.g. `for i in $(seq 1 40); do moon run api:test -- --lib || echo "FAILED on iteration $i"; done`) — never just audit the Coder's reported numbers or methodology. This is the one case where full duplication of the Coder's own check is intentional and required.
5. On failure: comment on the PR with specifics and set the issue label to `blocked`.
6. On pass: set the issue label to `needs-review`.
```

- [ ] **Step 2: Edit the Reviewer playbook**

Replace:
```markdown
## Reviewer playbook

1. Confirm CI is green and the Tester has set `needs-review`.
2. Re-read the issue acceptance criteria against the PR diff.
```

With:
```markdown
## Reviewer playbook

1. Confirm CI is green and the Tester has set `needs-review`. Trust CI-green plus the Tester's `needs-review` label entirely for correctness — never re-run test suites yourself; spend your review effort on the diff, not on re-verifying "does it pass."
2. Re-read the issue acceptance criteria against the PR diff.
```

- [ ] **Step 3: Edit the Planner playbook**

Replace:
```markdown
## Planner playbook

1. Intake the goal (MVP slice, bug cluster, or newly discovered work). Do not implement anything.
2. Break the goal into small, independent-ish tasks (aim for under a day of work each).
3. For each task, open a GitHub issue using the Task template via the `open-task-issue` skill. Required sections: Goal, Acceptance criteria, Out of scope, Notes.
```

With:
```markdown
## Planner playbook

1. Intake the goal (MVP slice, bug cluster, or newly discovered work). Do not implement anything.
2. Break the goal into small, independent-ish tasks (aim for under a day of work each). **Bundling**: related, low-risk changes to the same screen/user-facing surface may be combined into one issue — multiple separable, testable acceptance-criteria bullets, still one PR — rather than one issue per change (e.g. a settings screen's dark-mode toggle, nav scaffold, visual pass, log-out flow, and delete-account flow can be one issue if each piece is independently low-risk). **Hard exclusions — always stay atomic regardless of size or how related they look**: anything touching `apps/api/src/crypto/**`, `apps/api/src/auth/**`, `apps/mobile/src/crypto/**`; any database migration or data-model change; any new dependency; anything that would warrant a `docs/decisions/` entry per this file's "Architecture decisions" section. There's no fixed time-budget cap layered on top of the same-screen/low-risk gate — if a bundle grows large enough that it no longer reads as one coherent day-or-so of work, split along a natural sub-boundary rather than reverting to one-issue-per-tiny-change.
3. For each task, open a GitHub issue using the Task template via the `open-task-issue` skill. Required sections: Goal, Acceptance criteria, Out of scope, Notes.
```

- [ ] **Step 4: Add the "CI job scoping" section**

Find the existing `## Docs freshness` section (it ends right before `## Architecture decisions` begins with `` `docs/decisions/` holds short, durable architecture decisions...``). Insert a new section between them.

Replace:
```markdown
Coder updates the docs in the same PR; Reviewer blocks merge if they're stale relative to the diff.

## Architecture decisions
```

With:
```markdown
Coder updates the docs in the same PR; Reviewer blocks merge if they're stale relative to the diff.

## CI job scoping

`.github/workflows/ci.yml`'s `api`, `mobile`, and `quic-relay-client` jobs only run on `pull_request` when their own paths (or the shared Cargo workspace files `Cargo.toml`/`Cargo.lock`, since `apps/api` and `packages/quic-relay-client` share one workspace) are touched — a `changes` job at the top of the workflow computes this via `git diff --name-only`, the same technique `crypto-review-notice` already uses. A job showing as **skipped** on your PR is expected, not a problem: it means that project's paths weren't touched, not that the check silently passed. `push` to `main` always runs all three jobs unconditionally, as a full post-merge safety net.

## Architecture decisions
```

- [ ] **Step 5: Verify the edits landed correctly**

Run: `grep -n "does not need to re-run\|Exception — repeated\|Bundling\|CI job scoping\|never re-run test suites" AGENTS.md`
Expected: matches for `Exception — repeated`, `Bundling`, `CI job scoping`, and `never re-run test suites` (four separate lines/sections found — the exact grep pattern for the first alternative is a decoy, ignore if it doesn't match, the other three must).

Also visually re-read the full `Tester playbook`, `Reviewer playbook`, `Planner playbook`, and new `CI job scoping` sections in `AGENTS.md` to confirm numbering is sequential (no skipped/duplicated step numbers) and no stray markdown artifacts from the edits.

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md
git commit -m "docs: redistribute Coder/Tester/Reviewer verification responsibility, add Planner bundling rule and CI scoping note"
```

---

### Task 2: `.claude/agents/tester.md` — redirect verification + fix stale local-checks line

**Files:**
- Modify: `.claude/agents/tester.md`

**Interfaces:**
- Consumes: Task 1's updated Tester playbook (this file must stay consistent with it).
- Produces: nothing consumed by later tasks; independently reviewable.

- [ ] **Step 1: Edit the Rules section**

Replace:
```markdown
## Rules

- Confirm CI is green (lint, build, test).
- Verify **each** acceptance criterion on the linked issue line by line.
- You may add or fix **tests** that cover acceptance criteria. Do not change product behavior to make tests pass — that is the Coder's job (set `blocked` instead).
- On failure: comment on the PR with specifics; set issue label to `blocked`.
- On pass: set issue label to `needs-review`.
- Use `systematic-debugging` (Superpowers) when failures are unclear.
- Local checks: `apps/mobile` → `npm run lint`, `npm run typecheck`, `npm test`; API → `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`.
```

With:
```markdown
## Rules

- Confirm CI is green (lint, build, test) — this is authoritative. Do not re-run the full local suite to reconfirm it once CI is green on the exact commit under review.
- Verify **each** acceptance criterion on the linked issue line by line. Audit coverage: does a real test exist for each criterion, and does it actually exercise the claimed behavior — read the test, don't just trust the PR description.
- You may add or fix **tests** that cover acceptance criteria. Do not change product behavior to make tests pass — that is the Coder's job (set `blocked` instead). Run anything you add or change yourself, via moon.
- **Exception**: acceptance criteria requiring repeated/probabilistic verification (e.g. a flake-reproduction loop) can't be confirmed by CI's single pass — always fully independently re-run the stated N yourself; never just audit the Coder's reported numbers.
- On failure: comment on the PR with specifics; set issue label to `blocked`.
- On pass: set issue label to `needs-review`.
- Use `systematic-debugging` (Superpowers) when failures are unclear.
- Local checks (only for tests you add/fix, or the repeated-verification exception above — not a blanket CI re-check), via moon, matching CI exactly: `moon run mobile:lint`, `moon run mobile:typecheck`, `moon run mobile:test` for `apps/mobile`; `moon run api:check`, `moon run api:lint`, `moon run api:test` for `apps/api`. Do not substitute raw `cargo`/`npm`.
```

- [ ] **Step 2: Verify**

Run: `grep -n "moon run\|cargo test\|npm test" .claude/agents/tester.md`
Expected: every `cargo`/`npm` invocation shown is prefixed by `moon run ...` (e.g. `moon run api:test`) — no bare `cargo fmt --check`, `cargo clippy`, `cargo test`, `npm run lint`, `npm run typecheck`, or `npm test` remain.

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/tester.md
git commit -m "docs: align tester.md with AGENTS.md's CI-trust/coverage-audit rules, fix stale raw-cargo/npm line"
```

---

### Task 3: `.claude/agents/reviewer.md` — never re-run test suites

**Files:**
- Modify: `.claude/agents/reviewer.md`

**Interfaces:**
- Consumes: Task 1's updated Reviewer playbook.
- Produces: nothing consumed by later tasks; independently reviewable.

- [ ] **Step 1: Edit the Rules section**

Replace:
```markdown
## Rules

- Confirm CI green and issue labeled `needs-review`.
- Diff vs acceptance criteria; reject scope creep.
```

With:
```markdown
## Rules

- Confirm CI green and issue labeled `needs-review`.
- Never re-run test suites yourself — trust CI-green plus the Tester's `needs-review` label entirely for correctness; spend your review effort on the diff, not on re-verifying "does it pass."
- Diff vs acceptance criteria; reject scope creep.
```

- [ ] **Step 2: Verify**

Run: `grep -n "Never re-run test suites" .claude/agents/reviewer.md`
Expected: one match.

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/reviewer.md
git commit -m "docs: reviewer.md never re-runs test suites, trusts CI + Tester"
```

---

### Task 4: `.claude/agents/planner.md` — bundling heuristic

**Files:**
- Modify: `.claude/agents/planner.md`

**Interfaces:**
- Consumes: Task 1's updated Planner playbook.
- Produces: nothing consumed by later tasks; independently reviewable.

- [ ] **Step 1: Edit the Rules section**

Replace:
```markdown
## Rules

- Do **not** edit application code, open PRs, or implement features.
- One GitHub issue per task. Use the `open-task-issue` skill (or `gh issue create` with the Task template sections).
```

With:
```markdown
## Rules

- Do **not** edit application code, open PRs, or implement features.
- One GitHub issue per task — except related, low-risk changes to the same screen/user-facing surface, which may bundle into a single issue with multiple separable, testable acceptance-criteria bullets (still one PR). Hard exclusions that always stay atomic regardless of size: `apps/api/src/crypto/**`, `apps/api/src/auth/**`, `apps/mobile/src/crypto/**`, any migration/data-model change, any new dependency, anything warranting a `docs/decisions/` entry. Use the `open-task-issue` skill (or `gh issue create` with the Task template sections).
```

- [ ] **Step 2: Verify**

Run: `grep -n "may bundle into a single issue" .claude/agents/planner.md`
Expected: one match.

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/planner.md
git commit -m "docs: planner.md may bundle same-screen low-risk work into one issue"
```

---

### Task 5: `.claude/agents/coder.md` — pre-PR re-run not required

**Files:**
- Modify: `.claude/agents/coder.md`

**Interfaces:**
- Consumes: spec's "Verification responsibility across roles" (Coder sub-section — no rule change to the TDD loop itself, just a clarifying note).
- Produces: nothing consumed by later tasks; independently reviewable.

- [ ] **Step 1: Edit the Rules section**

Replace:
```markdown
- Prefer TDD (`test-driven-development` Superpowers skill): red → green → refactor.
```

With:
```markdown
- Prefer TDD (`test-driven-development` Superpowers skill): red → green → refactor.
- A final full-suite re-run right before opening the PR isn't required — CI is the authoritative pass/fail signal once pushed. Your TDD inner-loop runs during development are what matter.
```

- [ ] **Step 2: Verify**

Run: `grep -n "isn't required — CI is the authoritative" .claude/agents/coder.md`
Expected: one match.

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/coder.md
git commit -m "docs: coder.md notes final pre-PR full-suite re-run isn't required"
```

---

### Task 6: `.github/workflows/ci.yml` — path-scoped `changes` job + gating

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: nothing from earlier tasks (independent of the docs changes).
- Produces: a `changes` job with outputs `api`, `mobile`, `quic_relay_client` (booleans as strings `'true'`/`'false'`), consumed by the `needs`/`if` on the `api`, `mobile`, and `quic-relay-client` jobs added in this same task.

**Important gotchas this task must get right:**
1. A job with `needs: changes` is skipped by default if `changes` itself was skipped (which it always is on `push`, since `changes` only runs `if: github.event_name == 'pull_request'`). Every gated job's `if:` must therefore start with `always() &&` and explicitly allow the non-`pull_request` case, or `push` to `main` would stop running CI entirely — a much worse regression than the one being fixed.
2. **Fail open, not fail skip.** If the `changes` job itself fails (a bug in the diff/grep script, an API hiccup) on a `pull_request` run, the gated jobs must still run rather than silently skip — a skipped required check reads as satisfied to branch protection, so a broken detection script must never be able to wave a PR through untested. Each gated job's `if:` therefore also treats `needs.changes.result != 'success'` as "run it," alongside the actual per-project boolean.

- [ ] **Step 1: Add the `changes` job**

Replace:
```yaml
jobs:
  api:
    name: api
    runs-on: ubuntu-latest
```

With:
```yaml
jobs:
  changes:
    name: changes
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    outputs:
      api: ${{ steps.filter.outputs.api }}
      mobile: ${{ steps.filter.outputs.mobile }}
      quic_relay_client: ${{ steps.filter.outputs.quic_relay_client }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Determine which projects changed
        id: filter
        run: |
          CHANGED=$(git diff --name-only "${{ github.event.pull_request.base.sha }}" "${{ github.event.pull_request.head.sha }}")

          echo "Changed files:"
          echo "$CHANGED"

          # apps/api and packages/quic-relay-client share one Cargo
          # workspace (root Cargo.toml / Cargo.lock) -- a dependency bump
          # in either project's manifest can change the shared lockfile's
          # resolved versions for the other, so both must react to it.
          if echo "$CHANGED" | grep -qE '^(apps/api/|Cargo\.toml$|Cargo\.lock$|\.github/workflows/ci\.yml$|\.moon/)'; then
            echo "api=true" >> "$GITHUB_OUTPUT"
          else
            echo "api=false" >> "$GITHUB_OUTPUT"
          fi

          if echo "$CHANGED" | grep -qE '^(apps/mobile/|\.github/workflows/ci\.yml$|\.moon/)'; then
            echo "mobile=true" >> "$GITHUB_OUTPUT"
          else
            echo "mobile=false" >> "$GITHUB_OUTPUT"
          fi

          if echo "$CHANGED" | grep -qE '^(packages/quic-relay-client/|Cargo\.toml$|Cargo\.lock$|\.github/workflows/ci\.yml$|\.moon/)'; then
            echo "quic_relay_client=true" >> "$GITHUB_OUTPUT"
          else
            echo "quic_relay_client=false" >> "$GITHUB_OUTPUT"
          fi

  api:
    name: api
    needs: changes
    # Runs on: non-PR events (push to main, unconditional); changes-job
    # failure (fail open, never silently skip on a broken filter); or a
    # PR that actually touched api's paths per the changes job's output.
    if: >-
      always() &&
      (github.event_name != 'pull_request' ||
       needs.changes.result != 'success' ||
       needs.changes.outputs.api == 'true')
    runs-on: ubuntu-latest
```

- [ ] **Step 2: Gate the `mobile` job**

Replace:
```yaml
  mobile:
    name: mobile
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: apps/mobile
```

With:
```yaml
  mobile:
    name: mobile
    needs: changes
    if: >-
      always() &&
      (github.event_name != 'pull_request' ||
       needs.changes.result != 'success' ||
       needs.changes.outputs.mobile == 'true')
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: apps/mobile
```

- [ ] **Step 3: Gate the `quic-relay-client` job**

Replace:
```yaml
  quic-relay-client:
    name: quic-relay-client
    runs-on: ubuntu-latest
```

With:
```yaml
  quic-relay-client:
    name: quic-relay-client
    needs: changes
    if: >-
      always() &&
      (github.event_name != 'pull_request' ||
       needs.changes.result != 'success' ||
       needs.changes.outputs.quic_relay_client == 'true')
    runs-on: ubuntu-latest
```

- [ ] **Step 4: Validate YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('OK')"`
Expected: `OK` with no exception. If `python3`/`pyyaml` isn't available, substitute `ruby -ryaml -e "YAML.load_file('.github/workflows/ci.yml'); puts 'OK'"` or any locally available YAML parser — the point is a clean parse, not the specific tool.

- [ ] **Step 5: Re-read the full file**

Read `.github/workflows/ci.yml` top to bottom and confirm: `changes` job appears first; `api`, `mobile`, `quic-relay-client` each have `needs: changes` and the `always() && (... || needs.changes.result != 'success' || ...)` fail-open guard; `crypto-review-notice` is completely untouched; indentation is consistent (2 spaces, matching the rest of the file).

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: scope api/mobile/quic-relay-client jobs to their own changed paths on PRs"
```

---

### Task 7: `main` branch protection — require `quic-relay-client`

**Files:**
- None (GitHub repo setting via `gh api`).

**Interfaces:**
- Consumes: the `quic-relay-client` job name from Task 6 (must match exactly — it does, both are the literal string `quic-relay-client`).
- Produces: nothing consumed by later tasks.

**Before running this step:** this is a live, immediate change to `main`'s branch protection, visible repo-wide and affecting every currently-open PR's merge gating, not just this one. Confirm with the user immediately before executing it, even if the rest of this plan is being run non-interactively — this is exactly the kind of "modifying shared infrastructure" action `AGENTS.md`'s permissions policy and this harness's own safety conventions call out for a pause, not a hooks/permissions bypass.

- [ ] **Step 1: Read the current required status checks**

Run: `gh api repos/mikef-eng/epistl/branches/main/protection/required_status_checks --jq '{strict, contexts}'`
Expected output (current state, before this change):
```json
{"strict":true,"contexts":["api","mobile"]}
```

- [ ] **Step 2: Add `quic-relay-client` to the required checks**

```bash
gh api --method PATCH repos/mikef-eng/epistl/branches/main/protection/required_status_checks \
  --input - <<'EOF'
{
  "strict": true,
  "checks": [
    {"context": "api"},
    {"context": "mobile"},
    {"context": "quic-relay-client"}
  ]
}
EOF
```

- [ ] **Step 3: Verify**

Run: `gh api repos/mikef-eng/epistl/branches/main/protection/required_status_checks --jq '{strict, contexts}'`
Expected:
```json
{"strict":true,"contexts":["api","mobile","quic-relay-client"]}
```

No commit for this task — it's a GitHub setting, not a repo file.

---

### Task 8: End-to-end verification via throwaway PRs

**Files:**
- Create (temporarily): a throwaway branch/file under `apps/mobile/` and one under `Cargo.lock`'s trigger path (or any file matching the shared-workspace pattern), each on its own short-lived branch. Both are deleted at the end of this task.

**Interfaces:**
- Consumes: Task 6's `changes` job/gating and Task 7's required-check change — this task is the empirical proof both work together, per the spec's "Testing / verification" section.
- Produces: nothing — terminal task.

**This task must run *after* Tasks 6 and 7 have both merged to `main`**, since path-scoping only takes effect once `.github/workflows/ci.yml` on `main` (the version PRs are diffed against) has the `changes` job.

- [ ] **Step 1: Confirm mobile-only PRs skip `api` and `quic-relay-client` without hanging**

```bash
git checkout main
git pull
git checkout -b ci-scoping-verify-mobile
echo "// ci-scoping verification, safe to delete" >> apps/mobile/README.md
git add apps/mobile/README.md
git commit -m "test: verify mobile-only PR skips api/quic-relay-client CI jobs"
git push -u origin ci-scoping-verify-mobile
gh pr create --title "TEMP: verify CI path-scoping (mobile-only)" --body "Throwaway PR to verify path-scoped CI jobs. Will be closed without merging." --base main
```

Then: `gh pr checks <pr-number> --watch`
Expected: `mobile` runs and passes; `api` and `quic-relay-client` show as **skipped** (not pending, not failing); the PR is mergeable (not stuck waiting on a check that never reports) — confirm via `gh pr view <pr-number> --json mergeStateStatus --jq '.mergeStateStatus'`, expecting `CLEAN` or `UNSTABLE` (not `BLOCKED` due to a hung required check).

- [ ] **Step 2: Clean up the mobile-only verification PR**

```bash
gh pr close <pr-number> --delete-branch
git checkout main
```

- [ ] **Step 3: Confirm a shared-workspace-file PR runs both `api` and `quic-relay-client`**

```bash
git pull
git checkout -b ci-scoping-verify-shared
echo "" >> Cargo.lock
git add Cargo.lock
git commit -m "test: verify Cargo.lock change runs both api and quic-relay-client CI jobs"
git push -u origin ci-scoping-verify-shared
gh pr create --title "TEMP: verify CI path-scoping (shared workspace file)" --body "Throwaway PR to verify Cargo.lock changes trigger both api and quic-relay-client. Will be closed without merging." --base main
```

If the trailing-newline diff to `Cargo.lock` doesn't actually register as a content change (`git diff` shows nothing), instead make a trivial no-op comment-free touch that produces a real diff — e.g. temporarily bump then revert a patch-level dependency version in `apps/api/Cargo.toml` and run `cargo update -p <that-dependency> --precise <original-version>`-equivalent to regenerate `Cargo.lock` with a genuine diff, or simply append a blank line and confirm with `git diff --stat Cargo.lock` before committing.

Then: `gh pr checks <pr-number> --watch`
Expected: both `api` and `quic-relay-client` run; `mobile` shows as skipped.

- [ ] **Step 4: Clean up the shared-workspace verification PR**

```bash
gh pr close <pr-number> --delete-branch
git checkout main
git branch -D ci-scoping-verify-mobile ci-scoping-verify-shared 2>/dev/null || true
```

- [ ] **Step 5: Report results**

Summarize, for the user: whether both throwaway PRs behaved as expected (correct jobs ran/skipped, no hung required checks), and confirm `quic-relay-client` is now enforced (a PR with a genuinely failing `quic-relay-client` test would be blocked from merging — this doesn't need to be separately proven with a real failing PR unless the user wants that extra confirmation).

No commit for this task — cleanup leaves no trace on `main` beyond Tasks 1-7's already-merged changes.
