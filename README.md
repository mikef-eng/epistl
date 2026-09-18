# Epistl

Epistl is a cutting-edge chat platform. The long-term vision is a social hybrid between LinkedIn, Facebook, and Slack. The near-term goal is a solid end-to-end encrypted chat MVP.

## MVP goal

Ship post-quantum E2EE chat using CRYSTALS-Kyber and CRYSTALS-Dilithium (standardized by NIST as ML-KEM and ML-DSA), with a basic chat interface that includes a contacts list and the ability to add and manage contacts.

## Stack

| Layer | Choice |
| --- | --- |
| Monorepo | [moonrepo](https://moonrepo.dev) |
| Build tooling | [`sccache`](https://github.com/mozilla/sccache) (required, not optional — root [`.cargo/config.toml`](.cargo/config.toml) sets `rustc-wrapper = "sccache"` for the whole Cargo workspace `apps/api` and `packages/quic-relay-client` share, so every `cargo`/`moon run api:*`/`moon run quic-relay-client:*` invocation, local or CI, requires it on `PATH`; see "Running the stack locally" below for install instructions and [`docs/decisions/0016-concurrent-subagents-require-isolated-worktrees.md`](docs/decisions/0016-concurrent-subagents-require-isolated-worktrees.md)'s addendum for why a shared compiler cache doesn't reintroduce the lock-contention risk a shared raw `CARGO_TARGET_DIR` would) |
| Frontend | Expo + React Native (TypeScript) + expo-sqlite + [`drizzle-orm`](https://orm.drizzle.team) (via its `expo-sqlite` driver) / [`drizzle-kit`](https://orm.drizzle.team/kit-docs/overview) (dev dependency) for the on-device message history database — `apps/mobile/src/storage/schema.ts` defines the schema, `apps/mobile/drizzle.config.ts` configures `drizzle-kit`, and `apps/mobile/drizzle/` holds the generated migrations that `apps/mobile/src/storage/messages.ts` applies at startup via `drizzle-orm/expo-sqlite/migrator`, replacing that module's old hand-written SQL strings and ad hoc `PRAGMA table_info` migration guard — see [`docs/decisions/0012-mobile-local-storage-uses-drizzle-going-forward.md`](docs/decisions/0012-mobile-local-storage-uses-drizzle-going-forward.md); one such migration (`apps/mobile/drizzle/0001_messages_fts.sql`, hand-authored via `drizzle-kit generate --custom` since the schema builder has no FTS5 support) adds a `messages_fts` FTS5 virtual table kept in sync with `messages` via triggers, queried by `messages.ts`'s `searchMessages()` for conversation full-text search + NativeWind (Tailwind) + [`@noble/post-quantum`](https://www.npmjs.com/package/@noble/post-quantum) (pinned Kyber/ML-KEM and Dilithium/ML-DSA implementation) + [`@noble/curves`](https://www.npmjs.com/package/@noble/curves) (pinned X25519 implementation, same `paulmillr`-maintained suite) + [`@noble/ciphers`](https://www.npmjs.com/package/@noble/ciphers) (pinned XChaCha20-Poly1305 AEAD, same `paulmillr`-maintained suite, used by `apps/mobile/src/crypto/envelope.ts`'s message encryption) + [`@tanstack/react-store`](https://tanstack.com/store) (`apps/mobile/src/transport/store.ts` owns the chat relay's connection lifecycle — `status`/`activeTransport`/`lastFrame` state plus `connect`/`send`/`close` actions — per [`docs/decisions/0009-tanstack-store-and-query-for-network-layer.md`](docs/decisions/0009-tanstack-store-and-query-for-network-layer.md); its `connect` action tries QUIC first and only falls back to WS on failure/timeout, see the Transport row below; `@tanstack/react-query` is deferred to a later issue in that same batch. The connection itself is opened/closed at the app level — `apps/mobile/src/inbox/appSession.ts`, called from `apps/mobile/src/navigation/MainTabs.tsx`'s mount/unmount — not per-screen: `apps/mobile/src/inbox/listener.ts` is a second `@tanstack/react-store` store (`inboxStore`) that decodes/verifies and persists every incoming `message` frame for every contact independent of which screen is open, publishing each outcome for a currently-open `ChatScreen` to render without decoding anything itself, fixing the cross-contact silent message loss a purely per-`ChatScreen` connection/decode had before issue #165) + [`@react-native-async-storage/async-storage`](https://react-native-async-storage.github.io/async-storage/) (pinned to the version bundled with this repo's Expo SDK; `apps/mobile/src/settings/preferences.ts` uses it for non-sensitive local UI prefs — theme choice, notification toggle — leaving `expo-secure-store` reserved for actual secrets) + [`@react-navigation/bottom-tabs`](https://reactnavigation.org/docs/bottom-tab-navigator) (pinned in lockstep with the existing `@react-navigation/native`/`native-stack`; `apps/mobile/src/navigation/MainTabs.tsx` is the post-login `Main` route's nested `Conversations`/`Friends` tab navigator, with `Chat`/`AddContact`/`Settings` staying on the root stack, pushed over `Main` rather than nested inside the tabs) + [`expo-image-picker`](https://docs.expo.dev/versions/latest/sdk/imagepicker/) (issue #182; `SettingsScreen`'s "Change avatar" control opens the device's photo library only, no camera capture, then uploads the picked image via `apps/mobile/src/api/client.ts`'s `uploadAvatar` — the three-step presigned-URL flow against the avatar endpoints documented in the Object storage row below. `apps/mobile/src/components/Avatar.tsx` is the shared component (`ConversationsScreen`/`FriendsScreen`/`ChatScreen`'s header/`SettingsScreen`'s own preview) that renders a user's real avatar via `GET /api/avatar/{user_id}` with the session bearer token attached, falling back to the existing colored-initial circle whenever there's no avatar set or the image fails to load) |
| Backend | Rust (Axum, tokio) + [`better-auth`](https://crates.io/crates/better-auth) (crate name is `better-auth`, **not** `better-auth-rs` — see `apps/api/Cargo.toml` for why). `GET /api/users/search` (issue #99, discover-search) is the API's first rate-limited route: `apps/api/src/search.rs` wraps it in a small fixed-window `axum`/`tower` middleware (30 requests/60s per process, returning `429 { "error": "rate_limited" }` once exceeded) rather than `tower::limit::RateLimitLayer` directly — see that module's doc comment for why. No other route is rate-limited. Outbound push notifications (issue #167) go through [`reqwest`](https://crates.io/crates/reqwest) (pinned in `apps/api/Cargo.toml` to the version already resolved transitively via `better-auth`) — `apps/api/src/push.rs::send_push_notification` POSTs a content-free title/body plus a small opaque `data` payload to the Expo Push Notification service's HTTPS API (`https://exp.host/--/api/v2/push/send`), the standard delivery mechanism for this Expo-managed app (one unified endpoint for both APNs and FCM, no direct Apple/Google credentials needed by the API). Per-device tokens (e.g. Expo push tokens) are registered via `POST /api/push-tokens` (issue #166, `apps/api/src/push_tokens.rs`) into the `push_tokens` table. Issue #168 wires the two together: `apps/api/src/relay.rs::queue_for_offline_delivery` (the path taken whenever a `send` frame's recipient isn't currently connected, i.e. offline) spawns a best-effort `notify_push_tokens_for_offline_message` call after a successful offline-queue publish, which looks up every token registered for the recipient and sends each one a generic, content-free push (via `apps/api/src/auth.rs::AppState::push_notifier`, an injectable `crate::push::PushNotifier` trait object — the real `ExpoPushNotifier` at runtime, a mock in tests) carrying only the sender's `user_id` in `data.fromUserId`. A live-delivered message (recipient already connected) never triggers a push. |
| Message broker | NATS JetStream, via [`async-nats`](https://crates.io/crates/async-nats) (the official `nats-io`-maintained Rust client, pinned in `apps/api/Cargo.toml`) — local dev requires the `nats` docker-compose service. On startup the API configures (or fetches, if already present) the `EPISTL_OFFLINE_MESSAGES` stream, a transient, short-TTL offline-delivery queue — see [`docs/decisions/0008-jetstream-transient-offline-queue.md`](docs/decisions/0008-jetstream-transient-offline-queue.md). A `/ws` `send` to a recipient who isn't currently connected is published to this stream (one subject per recipient, `epistl.offline.<user_id>`) instead of failing; on reconnect (or initial connect), `/ws` fetches and delivers everything queued for that user, in order, over the same live-relay frame shape, acking each only after it's actually been forwarded — so it's removed from the queue once delivered, not on any fixed timer |
| Primary DB | Postgres (auth and core app data only — see [`docs/decisions/0001-message-content-never-in-postgres.md`](docs/decisions/0001-message-content-never-in-postgres.md)) |
| Cold storage | ScyllaDB (chat history backup; opt-in, not yet built — see [`docs/decisions/0002-scylla-backup-is-opt-in.md`](docs/decisions/0002-scylla-backup-is-opt-in.md)) |
| Object storage | SeaweedFS (S3-compatible, Apache-2.0, actively maintained), via the `seaweedfs` docker-compose service's `weed mini` all-in-one mode — chosen after MinIO Community Edition was found to be dead upstream (admin console dropped, then archived/no-longer-maintained; see the decision doc below for the timeline). Chosen for its S3-API compatibility so a future migration to a cloud object store (S3, R2, etc.) needs only a config change, not a client rewrite. Holds avatar image bytes; Postgres's `users.image TEXT` column only ever stores a reference (the API's own `/api/avatar/{user_id}` serving path), never the bytes or a raw SeaweedFS/S3 URL. The API is the sole issuer of short-lived presigned upload/download URLs (never proxying image bytes itself) — see [`docs/decisions/0018-seaweedfs-object-storage-for-avatars.md`](docs/decisions/0018-seaweedfs-object-storage-for-avatars.md). The `seaweedfs` docker-compose service auto-creates the `avatars` bucket itself on startup (no API-side bucket-creation logic). Accessed server-side (issue #189) via [`aws-sdk-s3`](https://crates.io/crates/aws-sdk-s3) (the official AWS Rust SDK, pinned in `apps/api/Cargo.toml`; see `apps/api/src/avatars.rs`'s module doc comment for the full rationale), configured with `force_path_style(true)` (required by SeaweedFS's S3 gateway) and two separate `aws_sdk_s3::Client`s — one against `SEAWEEDFS_INTERNAL_ENDPOINT` for server-side `HeadObject`/`DeleteObject` calls, one against `SEAWEEDFS_PUBLIC_ENDPOINT` for generating presigned PUT/GET URLs, since a presigned URL's SigV4 signature is bound to the host inside it. `POST /api/avatar/upload-url` returns a presigned PUT URL for the caller's avatar object; `POST /api/avatar/confirm` verifies the upload landed (and is within a 5 MiB cap, deleting and rejecting it otherwise) and updates `users.image`; `GET /api/avatar/{user_id}` (any authenticated user) redirects (`302`) to a freshly generated presigned GET URL. |
| Native module tooling | [`packages/quic-relay-client`](packages/quic-relay-client) (Rust crate wrapping [Quinn](https://crates.io/crates/quinn)) + [`uniffi-bindgen-react-native`](https://github.com/jhugman/uniffi-bindgen-react-native) (generates the RN TurboModule glue at `apps/mobile/modules/quic-relay-client`, a local, unpublished `file:` dependency of `apps/mobile`). Exposes two things: `quic_ping`, a one-shot async function (issue #67's spike, proving Quinn can be exposed to React Native as a real TurboModule at all) kept in place as a standalone dev-only smoke-test tool (`QuicSpikeScreen.tsx`); and `QuicConnection` (issue #75), a persistent-connection UniFFI object (`connect`/`send`/`close` plus a `QuicConnectionListener` callback interface for inbound frames/close notifications) that speaks `apps/api/src/quic.rs`'s real wire protocol for the lifetime of a chat session. `apps/mobile/src/transport/quic.ts` (issue #76) wraps `QuicConnection` in a thin driver (`connectQuic`/`connectQuicTo`, parsing frames into the same `IncomingFrame` shape `api/ws.ts` uses, and distinguishing an auth failure from a transient network failure); `transport/store.ts`'s `connect` action (issue #77) is what actually dials it — see the Transport row below. |
| Transport | QUIC is the default, always-attempted-first live-relay transport (issue #114); HTTP/WebSocket (`/ws`) is its fallback, dialed only once QUIC is unavailable or times out — WS remains fully functional and is never removed. A real (non-throwaway) Quinn-based QUIC listener exists at `apps/api/src/quic.rs`, **on by default**: it binds `0.0.0.0:4433` (`api::quic::DEFAULT_LISTEN_ADDR`) unless `QUIC_LISTEN_ADDR` overrides the bind address, or is explicitly set to `off` to disable it — see `.env.example`. When running (the default), it authenticates connections and relays messages through the same `ConnectionRegistry`/shared relay logic `/ws` uses, so cross-transport delivery works regardless of which transport the sender or recipient is connected over. Its TLS trust story (self-signed dev cert generated fresh in memory per process start, no production cert-issuance pipeline) is a deliberately interim decision — see [`docs/decisions/0011-quic-dev-cert-trust-remains-dev-only.md`](docs/decisions/0011-quic-dev-cert-trust-remains-dev-only.md). On the mobile client, `apps/mobile/src/transport/store.ts`'s `connect` action (issue #114, correcting issue #77's original concurrent-race design) attempts a QUIC connection (`transport/quic.ts`, issue #76) alone first on every (re)connect, with a bounded timeout (`QUIC_CONNECT_TIMEOUT_MS`, 2000ms): QUIC succeeding within that timeout sets `activeTransport: 'quic'` and WS is never dialed at all for that attempt; QUIC failing outright or exceeding the timeout starts a WS attempt for the first time, setting `activeTransport: 'ws'` once it connects. WS is never dialed concurrently alongside a QUIC attempt that hasn't yet failed or timed out. The original (never-aborted) QUIC attempt can still resolve after WS has been dialed; if WS has already connected by then, the late QUIC success is discarded (closed immediately, never displacing an already-connected WS session), but if WS is still mid-connect, QUIC still wins and the in-flight WS attempt is discarded instead. See also [`packages/quic-relay-client`](packages/quic-relay-client) (the Rust client side of that same protocol). |

Postgres, NATS, and SeaweedFS are stood up and required for local development (see "Running the stack locally" below). ScyllaDB is documented here for orientation only — it is not yet stood up.

## Repository layout

```
apps/
  mobile/   Expo + React Native client
  api/      Rust Axum API
packages/   Shared libraries
  quic-relay-client/   Rust/Quinn QUIC client crate (quic_ping spike + QuicConnection persistent-connection API; see Stack table)
```

## Development harness

Work is tracked through GitHub Issues and role handoffs (Planner → Coder → Tester → Reviewer). See [AGENTS.md](AGENTS.md) for conventions and role playbooks, and [`docs/decisions/`](docs/decisions/) for durable architecture decisions.

Any git worktree created for a concurrent agent/Coder dispatch (see [`docs/decisions/0016-concurrent-subagents-require-isolated-worktrees.md`](docs/decisions/0016-concurrent-subagents-require-isolated-worktrees.md)) belongs at `.worktrees/<name>` under the repo root (e.g. `git worktree add .worktrees/issue-123-slug`) — that directory is gitignored, disposable scratch space, not committed content.

## Claude Code

Root [CLAUDE.md](CLAUDE.md) imports [AGENTS.md](AGENTS.md). Agent tooling lives under `.claude/`:

- **Agents** — `planner`, `coder`, `tester`, `reviewer`, `crypto-reviewer`
- **Commands** — `/plan-issue`, `/work-issue`, `/test-pr`, `/review-pr`, `/ship`
- **Skills** — `open-task-issue`, `pqc-crypto-change`
- **Plugins** — root enables `superpowers@claude-plugins-official`; `apps/mobile` enables `expo@claude-plugins-official`

Postgres MCP is configured in [`.mcp.json`](.mcp.json) (project-scoped, via [`crystaldba/postgres-mcp`](https://github.com/crystaldba/postgres-mcp) over Docker — connects to the local `docker compose` Postgres by default). A NATS channel plugin remains deferred — no such plugin was found in the official Claude Code marketplace as of this writing; revisit if one becomes available.

## Running the stack locally

1. **Install [`sccache`](https://github.com/mozilla/sccache)** (one-time, required before your first Rust build — `apps/api` and `packages/quic-relay-client` share a workspace whose root [`.cargo/config.toml`](.cargo/config.toml) sets `rustc-wrapper = "sccache"`, so `cargo build`/`moon run api:*`/`moon run quic-relay-client:*` all fail outright with an "executable `sccache` not found" error until it's on your `PATH`):

   ```bash
   cargo install sccache --locked
   ```

   This isn't a personal optimization — it's a required project convention (see [`docs/decisions/0016-concurrent-subagents-require-isolated-worktrees.md`](docs/decisions/0016-concurrent-subagents-require-isolated-worktrees.md)'s addendum for why: it lets concurrent worktrees/CI runs share one compiled-output cache instead of each recompiling the same dependency graph from scratch).

2. **Set up your env file** (from repo root, one-time):

   ```bash
   cp .env.example .env
   ```

   `.env` is gitignored — see `.env.example` for what each var is for and which process consumes it. The defaults work as-is against the local docker-compose Postgres below; you only need to edit it if you want different values. Nothing else to do here: `docker compose` reads `.env` from this directory natively, and the API loads it itself via [`dotenvy`](https://docs.rs/dotenvy) on startup (walking up from wherever it's run from, so this works whether you invoke it from the repo root or from `apps/api`) — no manual `export`/`source` step needed.

3. **Start Postgres, NATS, and SeaweedFS** (from repo root):

   ```bash
   docker compose up -d
   ```

   This runs `postgres:16` on `localhost:5432` (configured from your `.env`; defaults: user/password/db all `epistl`), `nats:2-alpine` on `localhost:4222` (JetStream-enabled, monitoring on `8222`), and `chrislusf/seaweedfs:4.47` (in `weed mini` all-in-one mode) on `localhost:8333` (S3 API) / `localhost:23646` (Admin UI), each with a named volume so data survives restarts. (The `nats` service uses the `-alpine` tag rather than the bare `nats:2` tag purely so its healthcheck has a shell + `wget` to run against `8222`'s `/healthz` — it's still the same official `nats-io` image otherwise. SeaweedFS's S3 API and Admin UI ports are both published to the host, not just exposed internally, because presigned URLs handed to the mobile client must be reachable from outside the docker-compose network — see [`docs/decisions/0018-seaweedfs-object-storage-for-avatars.md`](docs/decisions/0018-seaweedfs-object-storage-for-avatars.md). SeaweedFS's S3 gateway credentials come from the checked-in `docker/seaweedfs-s3-config.json`, which must match `SEAWEEDFS_S3_ACCESS_KEY`/`SEAWEEDFS_S3_SECRET_KEY` in your `.env` — see that file's comments.) The `seaweedfs` service auto-creates the `avatars` bucket itself on startup. The API itself always runs on the host (not containerized), even in local dev, so if you're running it via `moon run api:dev` set `SEAWEEDFS_INTERNAL_ENDPOINT` to `http://localhost:8333` in your own `.env` too (not the `seaweedfs:8333` service-hostname value that would only resolve from inside the docker-compose network) — see `.env.example`'s comment on that var. The avatar upload/serving endpoints themselves (`POST /api/avatar/upload-url`, `POST /api/avatar/confirm`, `GET /api/avatar/{user_id}`) are documented in the Stack table's Object storage row above.

4. **Run migrations** (via [moon](https://moonrepo.dev) — install with `curl -fsSL https://moonrepo.dev/install/moon.sh | bash`, or see the [moon install docs](https://moonrepo.dev/docs/install) for other platforms):

   ```bash
   moon run api:migrate
   ```

5. **Run the API server** (listens on `0.0.0.0:3000`; refuses to start unless `DATABASE_URL`, `AUTH_SECRET`, and `NATS_URL` — all in your `.env` — resolve to a value; also configures the `EPISTL_OFFLINE_MESSAGES` JetStream stream at startup, using `OFFLINE_QUEUE_MAX_AGE_SECS` from your `.env` if set, otherwise defaulting to 24 hours; also starts a real QUIC listener alongside `/ws` on `0.0.0.0:4433` by default — override the bind address or disable it entirely via `QUIC_LISTEN_ADDR` in your `.env` — see the Transport row in the Stack table above):

   ```bash
   moon run api:dev
   ```

6. **Run the mobile app:**

   ```bash
   cd apps/mobile && npm install && cd ../..
   moon run mobile:start   # equivalent to: npm start (from apps/mobile)
   ```

   The client reads its API base URL from `EXPO_PUBLIC_API_URL`, defaulting to `http://localhost:3000` — fine for the iOS simulator or web on the same machine, but an Android emulator or physical device needs your machine's LAN IP instead. Expo's CLI auto-loads `apps/mobile/.env` (see `apps/mobile/.env.example`) the same way `docker compose` and the API auto-load the root `.env` — copy it and set `EXPO_PUBLIC_API_URL` there rather than exporting it inline each time. The QUIC driver (`src/transport/quic.ts`, tried first on every connect by `src/transport/store.ts`, before falling back to WS — see the Transport row above) reuses that same host and only needs a separate `EXPO_PUBLIC_QUIC_PORT` if the API's `QUIC_LISTEN_ADDR` is bound to a non-default port (defaults to `4433`, matching `QUIC_LISTEN_ADDR`'s own default).

   **Android, from a clean clone to a working emulator:** `apps/mobile` depends on a custom native module (`quic-relay-client`), so plain Expo Go can't run it — Android needs a real native build, not `moon run mobile:start` alone. `apps/mobile/android` is gitignored (generated on demand via Expo prebuild, not committed), so the steps below take you from nothing to a running emulator:

   - **Prerequisites** (one-time, manual — these are not auto-installed by anything in this repo):
     - [Android Studio](https://developer.android.com/studio), which bundles the Android SDK. Set `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) to its SDK location, e.g. `~/Library/Android/sdk` (macOS) or `~/Android/Sdk` (Linux).
     - At least one AVD (Android Virtual Device) — create one from Android Studio's Device Manager (or `avdmanager`), then start it (or let the next step start it for you).
     - The Android NDK, installed via Android Studio's SDK Manager or `sdkmanager --install "ndk;<version>"`. This is the one native-build prerequisite that isn't auto-installed for you (see below) — without it, the Android build fails fast with an error naming the exact `sdkmanager` command to run.
     - [`rustup`](https://rustup.rs) and a working Rust toolchain for `packages/quic-relay-client`. You do **not** need to install the Android Rust targets or `cargo-ndk` yourself — the Android Gradle build's `ensureQuicRelayClientNativeBuilt` task (`apps/mobile/modules/quic-relay-client/android/build.gradle`) auto-installs whichever `rustup target` (e.g. `aarch64-linux-android`) and `cargo-ndk` it needs the first time you build, cross-compiling `packages/quic-relay-client` per ABI. See that module's `README.md` and `docs/decisions/0013-quic-relay-client-android-native-build-bootstrap.md` for the full flow.
   - **Commands**, from repo root:

     ```bash
     cd apps/mobile && npm install
     npx expo run:android   # prebuilds android/ if missing, builds the native app, and launches it on a running/booted emulator (or connected device)
     ```

     The first build is slow (Gradle, plus the one-time Rust target/cargo-ndk install and native library cross-compile); subsequent builds are fast, since both Gradle and `ensure-native-built.js` skip work that's already up to date. Once installed, day-to-day iteration can go back to `moon run mobile:start` (Metro only) with the app already on the emulator, re-running `npx expo run:android` only after a native (not JS) change.

   **iOS, from a clean clone to a working simulator (macOS only):** same underlying problem as Android — `quic-relay-client` needs a real native build, not plain Expo Go. `apps/mobile/ios` is gitignored (generated on demand via Expo prebuild, not committed), so the steps below take you from nothing to a running simulator:

   - **Prerequisites** (one-time, manual — these are not auto-installed by anything in this repo):
     - Xcode (from the App Store) plus its Command Line Tools (`xcode-select --install` if you only need those, e.g. for CI-adjacent tooling — a real device/simulator build needs full Xcode). This is the one native-build prerequisite that isn't auto-installed for you (see below) — without it, the iOS build fails fast with an error telling you to install Xcode or run `xcode-select --install`.
     - [CocoaPods](https://cocoapods.org) (`sudo gem install cocoapods`, or via Homebrew), which `npx expo run:ios` uses under the hood to run `pod install`.
     - [`rustup`](https://rustup.rs) and a working Rust toolchain for `packages/quic-relay-client`. You do **not** need to install the iOS Rust targets yourself — `QuicRelayClient.podspec`'s `script_phase` (`apps/mobile/modules/quic-relay-client/scripts/ensure-native-built-ios.js`) auto-installs whichever `rustup target` (`aarch64-apple-ios`, `aarch64-apple-ios-sim`, `x86_64-apple-ios`) it needs the first time you build, cross-compiling `packages/quic-relay-client` and packaging it into an xcframework via `ubrn build ios`.
   - **Commands**, from repo root:

     ```bash
     cd apps/mobile && npm install
     npx expo run:ios   # prebuilds ios/ if missing, runs pod install, builds the native app, and launches it on a booted/available simulator
     ```

     The first build is slow (CocoaPods, plus the one-time Rust target install and native library cross-compile via the podspec's `script_phase`); subsequent builds are fast, since the script's own freshness check skips work that's already up to date. Once installed, day-to-day iteration can go back to `moon run mobile:start` (Metro only) with the app already on the simulator, re-running `npx expo run:ios` only after a native (not JS) change.

   See that module's `README.md` and `docs/decisions/0014-quic-relay-client-ios-native-build-bootstrap.md` for the full flow, and why it's a `script_phase`-triggered bootstrap rather than a CI cross-compile step (expected to also work unmodified under EAS Build's cloud macOS runners, once EAS is adopted).

`api:dev` and `mobile:start` are long-running dev servers (moon's `persistent` task option) — each occupies its terminal until you stop it, same as running `cargo run`/`npm start` directly. `moon run` is otherwise a thin wrapper: `moon.yml` in each app just declares the same commands moon runs, so you can always fall back to invoking `cargo`/`npm` directly from that app's directory if you'd rather not use moon.

## Local commands

All check/lint/test tasks are defined once in each app's `moon.yml` (`apps/api/moon.yml`, `apps/mobile/moon.yml`) and run through [moon](https://moonrepo.dev) — from repo root, no need to `cd` into an app first:

```bash
# Mobile
moon run mobile:lint
moon run mobile:typecheck
moon run mobile:test

# Mobile: regenerate drizzle-kit migrations after changing
# apps/mobile/src/storage/schema.ts (writes into apps/mobile/drizzle/;
# commit the result)
moon run mobile:db-generate

# Mobile: hand-author a raw-SQL migration for schema drizzle-kit's builder
# can't express (e.g. the messages_fts FTS5 virtual table + sync triggers
# in apps/mobile/drizzle/0001_messages_fts.sql) — creates an empty
# migration file under apps/mobile/drizzle/ for you to fill in; run from
# apps/mobile since moon's `--` passthrough doesn't reach npm's own `--`
cd apps/mobile && npm run db:generate -- --custom --name=<name>

# API (requires Postgres running, see above — api:test depends on
# api:migrate, so migrations run automatically first)
moon run api:check    # cargo fmt --check
moon run api:lint     # cargo clippy -D warnings
moon run api:test

# packages/quic-relay-client (Rust/Quinn QUIC client crate -- see the Stack table)
moon run quic-relay-client:check
moon run quic-relay-client:lint
moon run quic-relay-client:test
```

All `api:*`/`quic-relay-client:*` commands above (and any direct `cargo` invocation in either project) require [`sccache`](https://github.com/mozilla/sccache) on `PATH` — see step 1 of "Running the stack locally" above. Without it, they fail immediately with an "executable `sccache` not found" error, since the shared workspace's root [`.cargo/config.toml`](.cargo/config.toml) sets it as the required `rustc-wrapper`.

CI (`.github/workflows/ci.yml`) runs these same `moon run` tasks, so a green local run is a reliable predictor of a green CI run.
