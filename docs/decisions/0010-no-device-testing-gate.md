# 0010: Device/emulator hardware testing is not a default acceptance gate

## Context

The QUIC spike (issue #67, PR #69) explicitly waived its own on-device iOS/Android verification checklist rather than executing it: this dev environment has no Xcode (iOS device/simulator testing is categorically impossible here, not just currently missing), and the Android SDK/emulator that exists is on a separate Windows machine, runnable only manually by the user, not automatable in this environment or in CI.

Despite that waiver being explicit and scoped to issue #67 alone, a subsequent Planner dispatch for the full QUIC dual-stack batch (planning issue #70, "Verify the QUIC spike end-to-end on a real iOS device/simulator and Android emulator") reintroduced on-device verification as a default, batch-gating requirement — a reasonable-sounding risk mitigation in isolation, but one the user had not asked for and did not want as standing policy. Without recording the decision durably, a future Planner or Coder pass (or a fresh session without this one's memory) could reintroduce the same gate again.

## Decision

- New issues (Planner-authored or otherwise) must not include real iOS/Android on-device or emulator verification as a default, blocking acceptance criterion, CI check, or sequencing dependency for other work.
- Automated verification relies on unit/integration tests instead — including in-process test servers or mocked native bindings for things that would otherwise seem to need a real device (e.g. `packages/quic-relay-client/tests/ping.rs`'s in-process Quinn test server, not a real QUIC round trip over real hardware).
- The user may still run manual, on-demand device verification themselves whenever they choose — Android via their own separate Windows Android SDK; iOS is not available in any environment used by this project — but this is opt-in per-issue, never a default requirement.
- If the user explicitly asks for a device check on a specific issue, that's fine case by case. This ADR establishes a default-off policy, not a ban on ever verifying on real hardware.

## Consequences

- Issue #70 was closed as not planned per this decision, with the reasoning recorded on the issue itself.
- Issue #75 (which had cited #70 as a hard gate in its Notes) was updated to drop that dependency and rely on its own crate-level integration tests instead.
- Future Planner dispatches — this session's and any future one's — must not add on-device verification as default scope; cite this ADR rather than re-deriving the reasoning each time.
- `.github/workflows/ci.yml` is unaffected — it already runs no device/emulator jobs; this ADR formalizes that as intentional policy, not an accidental gap.
