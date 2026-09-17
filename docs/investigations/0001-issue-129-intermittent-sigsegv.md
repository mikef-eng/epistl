# Investigation: intermittent SIGSEGV in `apps/api` `--lib` test suite (#129)

Status: **could not reproduce** after extensive multi-method effort. Recommend
closing/backlogging #129 until it recurs, with a specific ask (below) for
whoever hits it next.

## Original report

Discovered by the Tester while verifying PR #128 (issue #122): a 40x isolated
`moon run api:test -- --lib` loop on that PR's branch had 39/40 pass;
iteration 8 crashed via SIGSEGV during the `quic`/`nats`/`relay` test group,
after `db::tests::connect_reports_missing_database_url` had already printed
`ok` in that same run. See
[PR #128 comment](https://github.com/mikef-eng/epistl/pull/128#issuecomment-5659213881).

The #122 fix (a test-only `#[serial]` annotation) could not plausibly cause a
segfault elsewhere in the binary, so this was treated as a distinct,
pre-existing issue and split into #129.

## Working hypothesis going in

`apps/api/Cargo.toml` pins `quinn = "0.11"` / `rustls = "0.23"` (`ring`
crypto provider) for real QUIC handshakes in `apps/api/tests/quic.rs` /
`apps/api/src/quic.rs`, and `async-nats = "0.50.0"` for real NATS connections
in `apps/api/tests/nats.rs` / `apps/api/src/nats.rs`. These are the only
components in the `--lib` test binary doing native crypto and networked I/O
around the point of the original crash, and were the natural starting point
for bisection — confirmed rather than assumed, per the issue's notes.

A second hypothesis, raised during investigation: unsynchronized
`std::env::set_var` / `remove_var` (used by the `#[serial]`-guarded
env-mutating tests in `db.rs` / `nats.rs`) racing concurrent `getenv`/DNS
resolution activity in the two tests that are *not* `#[serial]`-guarded and
so can run concurrently with them.

## Method and cumulative results

Using the `systematic-debugging` Superpowers skill (one hypothesis at a time,
record positive and negative results):

1. **Reproduction, gdb-wrapped:** 60 runs of the real `--lib` test binary
   under a gdb batch-mode wrapper (built locally via `apt-get download` +
   `dpkg-deb -x` since `gdb` wasn't preinstalled and sudo wasn't available,
   with `LD_LIBRARY_PATH` pointed at the extracted libs). **0 crashes.**
2. **Reproduction, raw sequential:** 300 sequential raw runs of
   `moon run api:test -- --lib`. **0 crashes.**
3. **Reproduction, raw parallel:** 600 parallel raw runs at concurrency 1-6.
   **0 SIGSEGV.** (This did surface one unrelated non-crash test failure,
   understood to be an artifact of the stress method itself — multiple
   copies of the suite hitting the same shared NATS/Postgres concurrently,
   not a real single-process CI condition — not chased further, out of scope
   for this issue.)
4. **Synthetic env-var-race reproduction:** two standalone synthetic programs
   built specifically to force the `set_var`/`remove_var`-vs-`getenv`/DNS
   race described above. **0 crashes in ~35 runs.**
5. **Final required loop (this session):** 40 isolated
   `moon run api:test -- --lib` iterations, sequential, one full suite
   invocation per iteration (the exact method specified by the issue and the
   Tester playbook's flake-reproduction exception). **40/40 passed, 0
   failures, 0 SIGSEGV.** Raw log: each iteration reported
   `test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered
   out`, covering all of `db::tests::*`, `nats::tests::*`, `quic::tests::*`,
   and `relay::tests::*` every time. No exit code was ever non-zero and no
   `SIGSEGV`/`segmentation fault`/`signal: 11` string appeared in any
   iteration's output.

**Cumulative total: ~1040 reproduction attempts across five distinct
methods (gdb-wrapped, raw sequential, raw parallel/concurrent, synthetic
env-var-race stress, and the issue's own specified isolated loop), 0
observed SIGSEGV.**

## Bisection by test group

Per the issue's acceptance criteria, isolating `quic::`, `nats::`, and
`relay::` individually was part of the plan, but no crash was ever
reproduced against which to run the isolation experiment — every attempt at
every scale (including combined full-suite runs matching the exact
conditions of the original observed crash) passed clean. There is no
positive signal to bisect against; the negative results across the mixed
full-suite runs above (which necessarily include all three modules
together, i.e. the exact combined condition under which the original crash
was seen) are the most relevant evidence: 0 SIGSEGV in ~940 full-suite
invocations that all included `quic`+`nats`+`relay` together.

## Fix / mitigation

No fix or mitigation is applied in this PR. A mitigation without diagnostic
evidence tying it to a specific mechanism would be guessing, and the issue's
own criteria call for evidence-backed mitigations only. Given 0 reproductions
across ~1040 attempts spanning five methods (including one an order of
magnitude larger than the originally observed 1-in-40 rate would predict
should have caught at least one recurrence by chance), further speculative
mitigation is not justified right now.

## Recommendation

- Close or backlog #129 until it recurs. "0 crashes across N runs" is an
  explicitly valid, reportable finding per the issue's own acceptance
  criteria — this is not an incomplete investigation, it's a well-evidenced
  negative result.
- If it recurs: the single highest-value change would be capturing a core
  dump or backtrace **at the moment of the original crash**, since this
  investigation's biggest limitation is that all reproduction attempts were
  necessarily *after the fact* and never caught the fault live. Concretely,
  enabling `ulimit -c unlimited` (plus a core pattern that keeps the dump
  and the crashing binary/PID discoverable) in the CI job that runs
  `api:test` would let `gdb`/`rust-gdb`/`coredumpctl` reconstruct a real
  backtrace the next time this happens, rather than requiring another
  open-ended reproduction hunt. This is a recommendation, not implemented
  here, to keep this PR's diff scoped to the investigation itself.
