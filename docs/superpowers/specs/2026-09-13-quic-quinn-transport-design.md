# Quinn/QUIC transport — design (issue #11)

Status: approved by user, spike phase only. Full dual-stack design is directional, not yet detailed — it depends on the spike's outcome.

## Context

Issue #11 has sat as a `planning`-stage stub since the walking skeleton was bootstrapped, gated on "once the REST + WebSocket skeleton has landed and proven itself out." That trigger condition is now satisfied: the walking skeleton, the full PQXDH/Double-Ratchet E2EE batch, and the NATS JetStream offline-delivery batch (including WS auto-reconnect, issue #55) are all merged to `main`.

A first design pass (posted as a comment on issue #11, dated 2026-09-13) recommended deferring QUIC indefinitely, on two grounds:

1. No viable Expo/RN QUIC client library exists on npm — the ecosystem (`@matrixai/quic`, `@chainsafe/libp2p-quic`, etc.) ships as Node.js native addons that don't run under Hermes/JSC, and the one Expo-specific hit (`expo-cronet`) is unmaintained (0 stars/forks/issues), Android-only, and HTTP-request-only (no bidirectional stream API — couldn't carry the `/ws` relay's protocol regardless of maturity).
2. The connection-resilience gap QUIC would close is already substantially closed by issue #55 (WS reconnect-with-backoff) + ADR 0008 (JetStream transient offline queue) + issue #54 (deliver-on-reconnect): a message sent during a network transition today is never lost and is wire-indistinguishable from a live send.

**This finding was correct about (1) as literally stated — no pre-built npm library exists — but incomplete as a verdict on QUIC's feasibility in RN generally.** Hermes doesn't need to execute a QUIC implementation in JavaScript any more than it executes SQLite in JavaScript for `expo-sqlite`; native capabilities reach RN through JSI/TurboModules wrapping native code. The first pass didn't evaluate "build our own native module" as a category of solution, only "does an off-the-shelf JS-callable library exist."

Re-researched with that gap in mind (2026-09-13):

- **[`uniffi-bindgen-react-native`](https://github.com/jhugman/uniffi-bindgen-react-native)** (Mozilla/Filament) is a real, actively maintained tool (docs updated as of April 2026) purpose-built for exposing Rust code as genuine React Native TurboModules via UniFFI. Since Quinn is a Rust crate — and this project's backend already depends on and has working familiarity with Rust — this is a directly applicable, non-hypothetical mechanism.
- The platform-native alternative (`react-native-cronet`, wrapping Apple/Android's native QUIC stacks) is **deprecated**, and even maintained would only accelerate HTTP request/response (`fetch`/XHR) — no bidirectional stream API, so it couldn't carry the `/ws` relay's protocol shape regardless.

Conclusion: a real mechanism exists to bring Quinn into RN as a native module. This does not mean QUIC is now trivially "worth building" — building and maintaining a custom Rust-to-native-mobile integration is substantial, ongoing engineering investment, weighed against a resilience gap that's already substantially closed (finding #2 above still stands unchanged). This spec's scope is deliberately narrow: answer the one real unknown (does Quinn specifically survive this toolchain) as cheaply as possible before committing to anything larger.

## Decisions made during brainstorming

1. **Scope, if pursued past the spike: full dual-stack**, not client-only. "QUIC primary, WS fallback" only means something if the server actually speaks QUIC — a client dialing QUIC against a server that only speaks WebSocket doesn't do anything. `apps/api` would gain a real Quinn-based QUIC listener alongside the existing Axum WS relay (which stays up unchanged as the fallback path), sharing message-handling logic where practical.
2. **Local dev TLS: self-signed dev certificate, explicitly trusted by the client in dev builds only.** QUIC mandates TLS 1.3 unconditionally (no plaintext option, unlike today's `ws://`). No TLS/cert story or deployment target exists anywhere in this repo yet. Rather than inventing a production cert story that doesn't exist, or adding a heavier mkcert-style local-CA setup step to every developer's machine, the API generates/loads a self-signed cert (matching this repo's existing pattern for dev-only, clearly-labeled non-secrets, e.g. `AUTH_SECRET`'s dev value), and the mobile Quinn client trusts that specific dev cert only in dev builds — explicit and contained, never assumed to carry over to a real deployment.
3. **Spike first, not a full batch.** The one substantive unknown — whether Quinn's dependency tree (rustls, ring, tokio) actually cross-compiles cleanly for iOS and Android through `uniffi-bindgen-react-native`'s toolchain — is unverified; no evidence was found of anyone having built Quinn specifically through this tool (only that the general tool works for other Rust code). A single narrow, bounded issue answers this cheaply before any larger design commitment, the same "verify before committing" discipline this project has applied to every other library/toolchain choice (issues #17, #36, #51).

## The spike (this is what gets planned into a concrete issue)

**New Rust crate at `packages/quic-relay-client/`** — the repository's `README.md` already reserves `packages/` for exactly this ("Shared libraries (reserved)"). Separate from `apps/api`'s server binary, since this crate compiles for iOS/Android targets via `uniffi-bindgen-react-native`, not the server's Linux target.

**Minimal scope:**
- One UniFFI-annotated async function that opens a Quinn QUIC client connection to a caller-supplied address+port, opens a bidirectional stream, writes `"ping"`, reads back a response, and returns success (with the response bytes) or a typed failure.
- A throwaway minimal Quinn server — a `cargo run --example` under `apps/api`, explicitly not product code — using the self-signed dev cert (decision 2 above), that just echoes whatever it receives back on the same stream.
- Wired through `uniffi-bindgen-react-native`'s codegen to produce a real iOS + Android TurboModule, callable from a bare Expo test screen (not integrated into `ChatScreen.tsx` or any real app flow).

**Success criteria:** from that bare test screen, on **both** a real iOS build and an Android emulator, the RN app calls the generated TurboModule and gets back the echoed response over a real QUIC connection to the local throwaway server. This proves the entire toolchain end-to-end in one shot — Quinn's dependencies cross-compiling for mobile, `uniffi-bindgen-react-native`'s codegen producing working Xcode/Gradle integration, and the JS-facing API actually being callable — without building any product logic on an unproven foundation.

**Explicitly out of scope for the spike:**
- Any fallback logic, any shared handler code with `apps/api/src/ws.rs`, any change to `ChatScreen.tsx` or any real app flow.
- A real (non-throwaway) server-side QUIC listener.
- Any production TLS/cert/deployment story beyond the dev self-signed cert.
- Windows/web platform support (this project's mobile target is iOS + Android via Expo only, per existing `app.json` config).

## What happens after the spike (directional only, not designed here)

**If the spike succeeds:** a real `apps/api/src/quic.rs` (Quinn listener sharing message-handling logic with `ws.rs` where practical), the mobile client racing a QUIC connect attempt against the existing `createReconnectingChatSocket` WS path with a bounded timeout before falling back, and a follow-up decision (deliberately not pre-designed here) on how the dev self-signed cert relates to a real deployment cert once an actual deployment target is chosen. This should go through its own Planner pass once the spike's real result is in — designing it now, against an unproven foundation, would repeat the exact mistake this spike exists to avoid.

**If the spike fails or reveals major friction** (e.g. Quinn's native dependencies don't cross-compile cleanly, `uniffi-bindgen-react-native`'s generated bindings don't actually expose a usable async streaming API, build tooling friction disproportionate to the payoff): that is a legitimate, valuable, and fully expected possible outcome — the same category of honest finding as the original "no npm library exists" result, just one level deeper and empirically verified rather than inferred from ecosystem search. Issue #11 goes back to `planning` with the concrete failure mode documented, and no further QUIC work is scheduled unless the blocking condition changes.

## Non-goals (both now and for any plausible future phase)

- Making QUIC exclusive (removing WebSocket) — the WS relay is a comparatively mature, tested system (issues #4, #53, #54, #55, ADR 0008) with real recent resilience investment; nothing in this design proposes retiring it.
- Any change to the wire message format, E2EE envelope, or NATS offline-delivery logic — QUIC is a transport-layer change only; the opaque `body_b64` envelope (ADR 0003) and everything built on top of it (ADRs 0005-0008) are unaffected regardless of which transport carries it.
