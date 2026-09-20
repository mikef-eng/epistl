# `dev-setup`

Two-stage local toolchain bootstrap for Epistl (issues #222–#224).

**Windows is unsupported.** On anything other than macOS or Linux the CLI
exits with a clear error — Windows contributors should follow the root
README's manual steps.

## Fast path (fresh machine)

From the repo root:

```bash
bash packages/dev-setup/bootstrap.sh
```

Optional flags (forwarded to the Rust CLI):

```bash
bash packages/dev-setup/bootstrap.sh --yes --start --skip-mobile
bash packages/dev-setup/bootstrap.sh --check
```

### Stage 1 — `bootstrap.sh`

Dependency-free bash (macOS bash 3.2 safe). Detects OS / arch / distro
family (apt, dnf, pacman) / WSL, then installs only what's needed to
*compile* Stage 2:

1. Base packages (C/C++ toolchain, cmake, pkg-config, OpenSSL headers,
   perl, curl, git). On macOS: Xcode CLT + Homebrew first.
2. rustup (stable + rustfmt + clippy).
3. sccache 0.18.0 (prebuilt release into `~/.local/bin`; `cargo install`
   fallback; clears `RUSTC_WRAPPER` if both fail so the handoff can still
   build). Required because [`.cargo/config.toml`](../../.cargo/config.toml)
   sets `rustc-wrapper = "sccache"`.
4. `exec cargo run --manifest-path packages/dev-setup/Cargo.toml -- "$@"`.

### Stage 2 — Rust CLI

Interactive install is the **default**. `--check` is detect-only.

| Flag | Behavior |
| --- | --- |
| *(none)* | Prompt-and-install each missing required tool; offer to start the stack |
| `--check` | Detect-only report; non-zero exit if a required tool is missing |
| `--yes` / `-y` | Non-interactive: yes to required tools, no to optional heavy ones (Android Studio IDE, Xcode) |
| `--start` / `--no-start` | Force / skip `docker compose up` + health wait + `moon run api:migrate` |
| `--skip-mobile` | Skip Android / iOS toolchain prompts |

Non-TTY stdin implies `--yes` so agents and CI never hang on a prompt.

**Always-on (every run):**

1. Copy root `.env.example` → `.env` if missing, rewriting
   `SEAWEEDFS_INTERNAL_ENDPOINT` to `http://localhost:8333` (the API
   runs on the host, not inside compose).
2. Copy `apps/mobile/.env.example` → `apps/mobile/.env` if missing.

**Core tools:** rustup/cargo/rustc, sccache, Node (reuse if it satisfies
RN 0.86's engines range; otherwise fnm + Node 22), moon, Docker
(`docker info` — daemon must be up). On Linux, Docker installs via
get.docker.com + docker group; a fresh install in the same session may
drive compose via `sg docker` until you log out/in (or `newgrp docker`).
On recent Ubuntu, Stage 2 installs `util-linux-extra` when `sg`/`newgrp`
are missing so that path works. WSL reuses Docker Desktop's socket when
present; macOS stays guide-only for Docker Desktop.

**Mobile (unless `--skip-mobile`):** JDK 17, Android cmdline-tools +
sdkmanager packages (platform 36, build-tools 36.0.0, NDK
27.1.12297006, cmake 3.22.1), optional Android Studio IDE; on macOS,
Xcode (guide-only) + CocoaPods.

**Also:** `npm ci` in `apps/mobile` when `node_modules` is missing.

## Via moon

```bash
moon run dev-setup:run              # always --check (non-mutating)
moon run dev-setup:run -- --yes --start
moon run dev-setup:bootstrap-lint   # shellcheck bootstrap.sh
```

## What this doesn't do

- Start `moon run api:dev` or `moon run mobile:start` (long-running
  servers, intentionally out of scope).
- Auto-install Xcode itself (Apple licensing — guide only).
- Anything on Windows.

See [`docs/decisions/0020-dev-setup-two-stage-bootstrap.md`](../../docs/decisions/0020-dev-setup-two-stage-bootstrap.md)
for the design rationale, and the root [`README.md`](../../README.md)
"Running the stack locally" section for the manual walkthrough.
