# quic-relay-client (local, spike-only)

Local React Native TurboModule package for GitHub issue #67's spike: proving
that [`packages/quic-relay-client`](../../../../packages/quic-relay-client)
(a Rust crate wrapping Quinn, the QUIC implementation) can be exposed to
React Native via
[`uniffi-bindgen-react-native`](https://github.com/jhugman/uniffi-bindgen-react-native).

This is **not** a published npm package -- `apps/mobile/package.json`
depends on it via `"quic-relay-client": "file:./modules/quic-relay-client"`.
It exists only to give `apps/mobile/src/screens/QuicSpikeScreen.tsx`
(dev-only, `__DEV__`-gated) something real to call. See issue #67 and
`docs/superpowers/specs/2026-09-13-quic-quinn-transport-design.md` for full
context.

## Regenerating the bindings

`src/index.tsx`, `src/NativeQuicRelayClient.ts`, `src/generated/`,
`cpp/`, `android/` (excluding `android/generated`, which is React Native's
own Codegen output, not `ubrn`'s), `ios/`, and `QuicRelayClient.podspec`
were produced by `uniffi-bindgen-react-native` (`ubrn`), not hand-written.
To regenerate them after a change to the Rust crate:

```sh
# From this directory, with the Rust crate built for host first so ubrn can
# read its UniFFI metadata:
cargo build --release --manifest-path ../../../../packages/quic-relay-client/Cargo.toml

node_modules/.bin/ubrn generate jsi bindings --library \
  --ts-dir src/generated --cpp-dir cpp/generated \
  ../../../../target/release/libquic_relay_client.so

node_modules/.bin/ubrn generate jsi turbo-module --config ubrn.config.yaml quic_relay_client
```

A real per-platform build (`ubrn build android --and-generate` / `ubrn
build ios --and-generate`) additionally cross-compiles the Rust crate itself
(via `cargo-ndk` + the Android NDK, or Xcode's toolchain for iOS) and is
what a real device/emulator run needs -- see issue #67's PR description for
this spike's exact toolchain findings.
