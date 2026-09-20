# 0013: quic-relay-client's Android native build is an on-demand, per-machine bootstrap

## Context

`apps/mobile/modules/quic-relay-client`'s Android target links a static
library (`android/src/main/jniLibs/<abi>/libquic_relay_client.a`) that
`android/CMakeLists.txt` already expects, cross-compiled per ABI from
`packages/quic-relay-client` (the Rust crate) via `cargo-ndk`. Before issue
#156, producing that file was a manual, undocumented incantation (`ubrn
build android --and-generate` + `cargo-ndk`) that only worked if a developer
already happened to have the right Rust targets, cargo-ndk, and the Android
NDK installed — and only produced the one ABI they targeted. PR #155
narrowed `android/build.gradle`'s `abiFilters` to `x86_64`-only as a
stopgap after a machine switch (laptop → desktop) exposed that this build
had never actually been reproducible from a clean checkout.

Issue #156 fixes the reproducibility gap and restores full ABI coverage.
This ADR records where the resulting build step lives, since two other
plausible designs were considered and rejected.

## Decision

**The native Android build is an on-demand bootstrap triggered by the
Android Gradle build itself, not a CI cross-compile step, and the resulting
`.a` files are never committed to the repo.**

- `apps/mobile/modules/quic-relay-client/android/build.gradle` registers an
  `ensureQuicRelayClientNativeBuilt` Gradle task that `preBuild` and the
  `externalNativeBuild*` tasks depend on. It runs
  `scripts/ensure-native-built.js`, which per ABI (`arm64-v8a`,
  `armeabi-v7a`, `x86`, `x86_64`): skips the ABI if its `jniLibs/<abi>`
  output is already newer than the crate's sources; otherwise
  auto-installs the missing `rustup` target and/or `cargo-ndk` and then
  runs `cargo ndk` to produce the `.a`.
- This is deliberately **not** wired into the module's `prepare` npm
  lifecycle script. `prepare` runs on every plain `npm install`/`npm ci`,
  including CI's `mobile` job — which never runs a Gradle/Android build at
  all (`docs/decisions/0010-no-device-testing-gate.md`) and has no
  cargo-ndk/NDK installed. Putting the build there would newly require that
  toolchain in CI and break it for everyone, not just Android developers.
- The Android NDK itself is the one prerequisite this script does **not**
  auto-install: if it isn't resolvable via `ANDROID_NDK_HOME`/
  `ANDROID_NDK_ROOT` or an `ndk/` directory under `ANDROID_HOME`/
  `ANDROID_SDK_ROOT`, the build fails fast with an actionable error (the
  exact `sdkmanager --install "ndk;<version>"` command to run) rather than
  attempting anything.

### Rejected alternative: a CI job that builds/publishes the native library

A CI-produced artifact would need its own distribution mechanism to reach
developer machines, since CI's `mobile` job never runs a Gradle/Android
build today (per ADR 0010) — that job would have to be added first, and
would still need some way to hand the resulting per-ABI `.a` files back to
a local `./gradlew` build. That's strictly more moving parts than a bootstrap
that runs where the build actually happens.

### Rejected alternative: committing prebuilt per-ABI `.a` binaries

Committed binary blobs would have no build step keeping them in sync with
`packages/quic-relay-client`'s Rust source — this is the exact drift this
issue exists to fix (a developer's environment producing, or failing to
produce, an artifact nobody else can reproduce or verify). A checked-in
binary is opaque to code review and would go stale silently the moment the
crate changes without someone remembering to regenerate and re-commit it.

## Amendment (issue #235)

Two bugs were found and fixed after the original PR #156 implementation:

1. **`.a` was not copied to `jniLibs/`.** `cargo-ndk -o <dir>` only copies
   the `.so` into `<dir>/<abi>/`; the static library (`.a`) remains in
   `target/<triple>/release/`. `scripts/ensure-native-built.js` now
   explicitly copies `target/<triple>/release/libquic_relay_client.a` →
   `jniLibs/<abi>/libquic_relay_client.a` after the ndk build.
   CMakeLists.txt links `my_rust_lib STATIC IMPORTED` against the `.a`;
   the `.so` alone is insufficient.

2. **Freshness check ignored missing `.a`.** `isAbiBuildStale` previously
   only compared mtimes: a `jniLibs/<abi>/` directory containing only a
   `.so` (newer than sources) was incorrectly treated as "not stale", even
   though the required `.a` was absent. The check now requires
   `libquic_relay_client.a` to be present in `jniLibs/<abi>/` before
   treating the ABI as fresh.

3. **Bootstrap integration.** `packages/dev-setup` (issue #235) now invokes
   `scripts/ensure-native-built.js` as a stage-2 step immediately after the
   Android SDK/NDK setup succeeds, so `jniLibs/<abi>/libquic_relay_client.a`
   is ready when the developer first opens Android Studio or runs
   `./gradlew`. The script is still **not** on `npm prepare` or CI — this
   addition only runs when the NDK is actually available on the machine.
   API-only contributors (no NDK) receive a non-blocking advisory message.

## Consequences

- Every developer doing a real Android build (`./gradlew`, Android Studio,
  or an Expo/EAS Android build) pays the one-time cost of the Rust
  target/cargo-ndk auto-install and the initial per-ABI `cargo ndk` build
  the first time they build after a clean checkout or a crate change. This
  is judged acceptable: it's a local, on-machine cost that only recurs when
  the crate actually changes (the freshness check makes it a no-op
  otherwise), and it fixes the actual regression (a real-device ABI with no
  reliable way to produce its native artifact) rather than deferring it.
- CI's `mobile` job continues to run with no cargo-ndk, Android NDK, or
  Android SDK installed, and stays green — this ADR's bootstrap only runs
  when Gradle runs, which CI's `mobile` job never does.
- If a future issue adds an Android build/device-testing gate to CI (which
  would need to revisit ADR 0010 first), that job would need to either
  provision the NDK/cargo-ndk itself or reconsider this decision.
