# 0020: Two-stage dev-setup bootstrap (bash then Rust)

## Context

The original `packages/dev-setup` was a pure Rust CLI whose first check
was `rustup`. That made it useless on a fresh machine: you needed Rust
already installed to run the tool that was supposed to install Rust.
It also only auto-installed on apt-based Linux, never touched mobile
toolchains, and defaulted to detect-only.

Contributors (and agents) need a single entry point that works on a bare
macOS or Linux install and leaves the repo able to boot
(`docker compose` + `moon run api:migrate` + mobile native builds).

## Decision

Split bootstrap into two stages:

1. **`bootstrap.sh`** — dependency-free bash (3.2-safe for macOS).
   Detects OS / distro family (apt, dnf, pacman) / WSL, installs base
   build packages, rustup, and sccache, then `exec`s into the Rust CLI.
   Exists only to make Stage 2 compilable. sccache is mandatory because
   `.cargo/config.toml` sets `rustc-wrapper = "sccache"`.

2. **Rust CLI** — interactive installer by default (`--check` for
   detect-only). Owns Node (via **fnm**, with repo-root `.node-version`
   pinning `22` to match CI), moon, Docker, `.env` files, optional
   Android/iOS toolchains, and `--start` orchestration. Zero external
   crate dependencies; fake-injection traits keep unit tests PATH-free.

**Node via fnm** rather than per-distro NodeSource packages: one install
path on macOS + all Linux families, and it respects `.node-version`.

**Sudo policy:** Stage 1 and Linux Docker / apt|dnf|pacman installs may
call `sudo` after announcing the command. macOS Docker Desktop and
Xcode stay guide-only (GUI / Apple licensing). `--yes` auto-accepts
required tools and declines optional heavy ones (Android Studio IDE).

**Unsupported:** Windows; Linux distros outside apt/dnf/pacman (clear
manual steps, exit 1).

## Consequences

- Fresh-machine entry point is
  `bash packages/dev-setup/bootstrap.sh` (documented in README).
- `moon run dev-setup:run` always passes `--check` so CI/moon never
  mutate the host.
- Mobile SDK/NDK can be installed headlessly via `sdkmanager`; the IDE
  remains optional.
- ADR supersedes the detect-only / `--install` semantics from issues
  #203–#206; those flags are replaced by the table in
  `packages/dev-setup/README.md`.
