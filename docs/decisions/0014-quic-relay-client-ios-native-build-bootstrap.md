# 0014: quic-relay-client's iOS native build is an on-demand, per-machine bootstrap

## Context

`apps/mobile/modules/quic-relay-client`'s iOS target links a vendored
`QuicRelayClientFramework.xcframework` (`QuicRelayClient.podspec`'s
`s.vendored_frameworks` already expects it at the module root), built from
`packages/quic-relay-client` (the Rust crate) for three target triples --
`aarch64-apple-ios` (device), `aarch64-apple-ios-sim` (Apple Silicon
simulator), and `x86_64-apple-ios` (Intel simulator). Before issue #161,
producing that file was a manual, undocumented incantation (`ubrn build ios
--and-generate`, run by hand from this module's directory) that only
worked if a developer already happened to have the right Rust targets and
Xcode/Command Line Tools installed -- the same kind of reproducibility gap
Android had before issue #156 (`docs/decisions/0013-quic-relay-client-android-native-build-bootstrap.md`).

Issue #161 is the iOS companion to #156, split into its own issue (rather
than bundled with it) because the two platforms' packaging technique and
native hook point are materially different: Android's script drives
`cargo-ndk` directly per ABI, while iOS's script wraps `ubrn build ios`
(which already performs the per-target `cargo build`, lipo-merges the
simulator slices, and runs `xcodebuild -create-xcframework` internally --
see `node_modules/uniffi-bindgen-react-native/crates/ubrn_cli/src/jsi/ios/commands.rs`),
and the native hook point is a CocoaPods `script_phase` in
`QuicRelayClient.podspec` rather than a Gradle task, since there is no
checked-in Xcode project for this module to hook a build phase into
directly (`apps/mobile/ios/` is a gitignored, Expo-prebuild-generated
folder, same as `apps/mobile/android/`).

This ADR records where the resulting build step lives, mirroring ADR 0013's
reasoning for Android, since the same two alternative designs were
considered and rejected for the same reasons.

## Decision

**The native iOS build is an on-demand bootstrap triggered by any real
Xcode build via a CocoaPods `script_phase`, not a CI cross-compile step,
and the resulting `.xcframework` is never committed to the repo.**

- `QuicRelayClient.podspec` declares an `s.script_phase` block
  (`execution_position :before_compile`, no `output_files` declared -- the
  script's own freshness check, not CocoaPods'/Xcode's script-phase
  caching, is what keeps repeat invocations fast) that runs
  `scripts/ensure-native-built-ios.js` on any `pod install`/Xcode build of
  the app: a plain `pod install` + Xcode build, `npx expo run:ios`, and,
  once EAS Build is adopted, its cloud macOS runners too -- EAS runs `pod
  install`/`xcodebuild` itself, so this same mechanism is expected to fire
  unmodified there, without needing any iOS-build-specific EAS
  configuration beyond whatever EAS setup already needs for any other
  reason. Adopting EAS itself remains a separate, out-of-scope decision.
- The script: skips the build entirely if
  `QuicRelayClientFramework.xcframework` is already newer than the crate's
  sources (crate root plus the workspace `Cargo.lock`); otherwise checks
  that `xcodebuild -version` succeeds (failing fast with an actionable
  "install Xcode / run `xcode-select --install`" error -- including the
  case of not running on macOS at all -- without attempting a build if it
  doesn't); auto-installs any of the three iOS Rust targets not already
  installed via `rustup target add`; and then runs `ubrn build ios
  --and-generate -t aarch64-apple-ios,aarch64-apple-ios-sim,x86_64-apple-ios`.
- This is deliberately **not** wired into the module's `prepare` npm
  lifecycle script, for the same reason as Android: `prepare` runs on every
  plain `npm install`/`npm ci`, including CI's `mobile` job, which never
  runs `pod install`/`xcodebuild` at all
  (`docs/decisions/0010-no-device-testing-gate.md`) and has no Xcode or iOS
  Rust targets installed. Putting the build there would newly require that
  toolchain in CI and break it for everyone, not just iOS developers.
- The `script_phase`'s shell explicitly sources `$HOME/.cargo/env` (and
  prefixes `PATH` with `$HOME/.cargo/bin`) before invoking the script,
  because Xcode's build-phase shell does not inherit a developer's
  interactive shell `PATH`/rc files -- `cargo`/`rustup` would not otherwise
  be found there even though they work fine from a normal terminal.
- Xcode/the Command Line Tools themselves are the one prerequisite this
  script does **not** auto-install, mirroring Android's stance on the NDK:
  a missing/unusable Xcode is a fail-fast actionable error, not a silent
  `xcode-select --install` invocation on the developer's behalf.

### Rejected alternative: a CI job that builds/publishes the native library

This repo's CI has no macOS runner and never runs `pod install`/`xcodebuild`
today (per ADR 0010), so a CI-produced xcframework would need its own
distribution mechanism to reach developer machines (or EAS) -- that job and
mechanism would have to be built first, and would still need some way to
hand the resulting xcframework back to a local `pod install`/`xcodebuild`.
That's strictly more moving parts than a bootstrap that runs where the
build actually happens, and mirrors why Android rejected the same
alternative.

### Rejected alternative: committing a prebuilt `.xcframework` binary

A committed binary blob would have no build step keeping it in sync with
`packages/quic-relay-client`'s Rust source, reintroducing the exact drift
this issue exists to fix. It would also be opaque to code review and would
go stale silently the moment the crate changes without someone remembering
to regenerate and re-commit it.

## Consequences

- Every developer doing a real iOS build (`pod install` + Xcode, or `npx
  expo run:ios`) pays the one-time cost of the Rust target auto-install and
  the initial `ubrn build ios` the first time they build after a clean
  checkout or a crate change. This is judged acceptable for the same reason
  as Android: it's a local, on-machine cost that only recurs when the crate
  actually changes (the freshness check makes it a no-op otherwise), and it
  fixes the actual reproducibility gap rather than deferring it.
- CI's `mobile` job continues to run with no Xcode, no macOS, and no iOS
  Rust targets installed, and stays green -- this ADR's bootstrap only runs
  when a real `pod install`/Xcode build runs, which CI's `mobile` job never
  does.
- This same `script_phase` mechanism is expected to work unmodified once
  EAS Build is adopted for iOS, since EAS's cloud macOS runners already run
  `pod install`/`xcodebuild` as part of a normal build. If that assumption
  turns out to be wrong once EAS is actually configured, that future issue
  would need to revisit this decision.
- If a future issue adds an iOS build/device-testing gate to CI (which
  would need to revisit ADR 0010 first), that job would need to either
  provision Xcode/the iOS Rust targets itself or reconsider this decision.
