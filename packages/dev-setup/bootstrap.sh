#!/usr/bin/env bash
# Stage 1 bootstrap for Epistl's local dev environment (issues #222–#224).
#
# Installs only what's needed to *compile* the Stage 2 Rust CLI
# (base build packages, rustup, sccache), then hands off to
# `cargo run -p dev-setup`. Safe to re-run; bash-3.2 compatible (macOS).
#
# Usage (from anywhere):
#   bash packages/dev-setup/bootstrap.sh [--check] [--yes] [--start|--no-start] [--skip-mobile]

set -euo pipefail

SCCACHE_VERSION="0.18.0"
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"

log() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------

OS="$(uname -s)"
ARCH="$(uname -m)"
IS_WSL=0
DISTRO_FAMILY=""

case "$OS" in
  Darwin) OS_KIND="macos" ;;
  Linux)  OS_KIND="linux" ;;
  *)      die "unsupported OS: $OS (only macOS and Linux are supported)" ;;
esac

if [ "$OS_KIND" = "linux" ]; then
  if [ -r /proc/version ] && grep -qi microsoft /proc/version; then
    IS_WSL=1
  fi
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    ID_LOWER="$(printf '%s' "${ID:-}" | tr '[:upper:]' '[:lower:]')"
    LIKE_LOWER="$(printf '%s' "${ID_LIKE:-}" | tr '[:upper:]' '[:lower:]')"
    case " $ID_LOWER $LIKE_LOWER " in
      *" debian "*|*" ubuntu "*) DISTRO_FAMILY="apt" ;;
      *" rhel "*|*" fedora "*|*" centos "*|*" rocky "*|*" alma "*) DISTRO_FAMILY="dnf" ;;
      *" arch "*) DISTRO_FAMILY="pacman" ;;
      *)
        die "unsupported Linux distro (ID=${ID:-unknown}). Supported families: apt (Debian/Ubuntu), dnf (Fedora/RHEL), pacman (Arch).
Manual steps:
  1. Install a C/C++ toolchain, cmake, pkg-config, OpenSSL headers, perl, curl, git
  2. Install rustup: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --component rustfmt clippy
  3. Install sccache ${SCCACHE_VERSION} onto PATH (see https://github.com/mozilla/sccache/releases)
  4. cargo run --manifest-path ${REPO_ROOT}/packages/dev-setup/Cargo.toml -- $*"
        ;;
    esac
  else
    die "cannot read /etc/os-release; unsupported environment"
  fi
fi

log "Epistl bootstrap (stage 1)"
if [ "$IS_WSL" -eq 1 ]; then
  log "  OS: $OS_KIND ($ARCH) [WSL]"
else
  log "  OS: $OS_KIND ($ARCH)"
fi
[ -n "$DISTRO_FAMILY" ] && log "  package manager: $DISTRO_FAMILY"
log "  repo: $REPO_ROOT"
log ""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

need_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    return 1
  fi
  return 0
}

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    log "→ running with sudo: $*"
    sudo "$@"
  fi
}

ensure_local_bin() {
  mkdir -p "${HOME}/.local/bin"
  case ":${PATH}:" in
    *":${HOME}/.local/bin:"*) ;;
    *) export PATH="${HOME}/.local/bin:${PATH}" ;;
  esac
}

# ---------------------------------------------------------------------------
# Base system packages
# ---------------------------------------------------------------------------

install_base_packages() {
  case "$OS_KIND" in
    linux)
      case "$DISTRO_FAMILY" in
        apt)
          log "Installing base packages via apt (build-essential, cmake, pkg-config, libssl-dev, perl, curl, git)…"
          run_as_root apt-get update -qq
          run_as_root apt-get install -y -qq \
            build-essential cmake pkg-config libssl-dev perl curl git ca-certificates
          ;;
        dnf)
          log "Installing base packages via dnf…"
          # Prefer dnf; fall back to yum on older RHEL.
          if have dnf; then
            PM=dnf
          else
            PM=yum
          fi
          run_as_root "$PM" install -y \
            gcc gcc-c++ make cmake pkgconf-pkg-config openssl-devel perl-core curl git ca-certificates
          ;;
        pacman)
          log "Installing base packages via pacman…"
          run_as_root pacman -Sy --needed --noconfirm \
            base-devel cmake pkgconf openssl perl curl git ca-certificates
          ;;
      esac
      ;;
    macos)
      if ! xcode-select -p >/dev/null 2>&1; then
        log "Installing Xcode Command Line Tools (a GUI dialog may appear)…"
        xcode-select --install || true
        log "Waiting for Xcode Command Line Tools…"
        until xcode-select -p >/dev/null 2>&1; do
          sleep 5
        done
      else
        log "Xcode Command Line Tools: present"
      fi

      if ! have brew; then
        log "Installing Homebrew…"
        NONINTERACTIVE=1 /bin/bash -c \
          "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        # Apple Silicon puts brew under /opt/homebrew.
        if [ -x /opt/homebrew/bin/brew ]; then
          eval "$(/opt/homebrew/bin/brew shellenv)"
        elif [ -x /usr/local/bin/brew ]; then
          eval "$(/usr/local/bin/brew shellenv)"
        fi
      else
        log "Homebrew: present"
      fi

      log "Installing cmake, pkg-config, openssl@3 via Homebrew…"
      brew install cmake pkg-config openssl@3
      ;;
  esac
}

# ---------------------------------------------------------------------------
# rustup
# ---------------------------------------------------------------------------

install_rustup() {
  if have rustup && have cargo && have rustc; then
    log "rustup/cargo/rustc: present"
    # Ensure components exist even on an existing install.
    rustup component add rustfmt clippy >/dev/null 2>&1 || true
    return 0
  fi

  log "Installing rustup (stable + rustfmt + clippy)…"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain stable --component rustfmt,clippy
  # shellcheck disable=SC1091
  . "${HOME}/.cargo/env"
}

# ---------------------------------------------------------------------------
# sccache (required by .cargo/config.toml rustc-wrapper)
# ---------------------------------------------------------------------------

sccache_triple() {
  case "$OS_KIND-$ARCH" in
    linux-x86_64)  printf 'x86_64-unknown-linux-musl' ;;
    linux-aarch64|linux-arm64) printf 'aarch64-unknown-linux-musl' ;;
    macos-x86_64)  printf 'x86_64-apple-darwin' ;;
    macos-arm64|macos-aarch64) printf 'aarch64-apple-darwin' ;;
    *) return 1 ;;
  esac
}

install_sccache() {
  if have sccache; then
    log "sccache: present ($(sccache --version 2>/dev/null | head -n1))"
    return 0
  fi

  ensure_local_bin
  triple="$(sccache_triple || true)"
  if [ -n "$triple" ]; then
    url="https://github.com/mozilla/sccache/releases/download/v${SCCACHE_VERSION}/sccache-v${SCCACHE_VERSION}-${triple}.tar.gz"
    log "Installing sccache ${SCCACHE_VERSION} from ${url}…"
    tmp="$(mktemp -d)"
    if curl -fsSL "$url" | tar -xz -C "$tmp"; then
      # Archive contains a single top-level dir with the binary inside.
      bin_path="$(find "$tmp" -type f -name sccache | head -n1)"
      if [ -n "$bin_path" ]; then
        install -m 755 "$bin_path" "${HOME}/.local/bin/sccache"
        rm -rf "$tmp"
        log "sccache installed to ${HOME}/.local/bin/sccache"
        return 0
      fi
    fi
    rm -rf "$tmp"
    warn "prebuilt sccache download failed; falling back to cargo install"
  else
    warn "no prebuilt sccache for $OS_KIND-$ARCH; falling back to cargo install"
  fi

  # cargo install needs sccache absent from rustc-wrapper, or it loops.
  # Temporarily clear the wrapper for this one install.
  if RUSTC_WRAPPER='' cargo install sccache --locked --version "${SCCACHE_VERSION}"; then
    log "sccache installed via cargo"
    return 0
  fi

  warn "sccache install failed; continuing with RUSTC_WRAPPER= so the handoff can still build"
  export RUSTC_WRAPPER=
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

install_base_packages
install_rustup

# Ensure cargo env is loaded even if rustup was already present but PATH
# wasn't set in this non-login shell.
if [ -f "${HOME}/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "${HOME}/.cargo/env"
fi

install_sccache

log ""
log "Stage 1 complete. Handing off to the Rust CLI…"
log ""

exec cargo run --quiet --manifest-path "${REPO_ROOT}/packages/dev-setup/Cargo.toml" -- "$@"
