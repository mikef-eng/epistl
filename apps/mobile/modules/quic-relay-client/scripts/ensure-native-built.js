#!/usr/bin/env node
'use strict';

/**
 * Wired into `android/build.gradle` (a Gradle task that `preBuild` and
 * `externalNativeBuild*` depend on) -- see issue #156.
 *
 * NOT wired into this package's `prepare` npm lifecycle script:
 * `prepare` runs on every plain `npm install`/`npm ci`, including CI's
 * `mobile` job (which never runs Gradle at all, per
 * docs/decisions/0010-no-device-testing-gate.md). Requiring cargo-ndk/the
 * Android NDK there would newly break that job for everyone, not just
 * developers doing an Android build.
 *
 * Produces `android/src/main/jniLibs/<abi>/libquic_relay_client.a` per ABI
 * by cross-compiling `packages/quic-relay-client` (the Rust crate; its
 * `[lib] crate-type` already includes `staticlib`, see that crate's
 * Cargo.toml) via `cargo-ndk`. `android/CMakeLists.txt` already expects
 * that file per ABI -- this script is only concerned with producing it.
 *
 * Reuses `scripts/lib-freshness.js`'s `newestMtimeMs` (issue #111's
 * dependency-free mtime-walk helper, generic over arbitrary directories)
 * to skip any ABI whose jniLibs/<abi> output is already newer than the
 * crate's sources, so a Gradle build stays fast when nothing changed.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { newestMtimeMs } = require('./lib-freshness');

const MODULE_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(MODULE_ROOT, '..', '..', '..', '..');
const DEFAULT_CRATE_ROOT = path.join(REPO_ROOT, 'packages', 'quic-relay-client');
// The Cargo workspace's single Cargo.lock lives at the repo root, not
// inside packages/quic-relay-client/ -- a `cargo update` can change it
// (and therefore what gets built) without touching anything under the
// crate root itself, so it's checked as an extra source-freshness input
// alongside newestMtimeMs(crateRoot) rather than folded into a directory
// walk.
const DEFAULT_WORKSPACE_LOCKFILE = path.join(REPO_ROOT, 'Cargo.lock');
const DEFAULT_JNI_LIBS_ROOT = path.join(MODULE_ROOT, 'android', 'src', 'main', 'jniLibs');

const ABIS = [
  { abi: 'arm64-v8a', triple: 'aarch64-linux-android' },
  { abi: 'armeabi-v7a', triple: 'armv7-linux-androideabi' },
  { abi: 'x86', triple: 'i686-linux-android' },
  { abi: 'x86_64', triple: 'x86_64-linux-android' },
];

/** Default command runner: a thin `spawnSync` wrapper, swapped out in tests. */
function defaultRunner(command, args, options = {}) {
  return spawnSync(command, args, options);
}

/** Newest mtime across the crate root plus the workspace Cargo.lock, or `null` if neither exists. */
function sourceNewestMtimeMs(crateRoot, workspaceLockfile) {
  const candidates = [newestMtimeMs(crateRoot)];

  try {
    candidates.push(fs.statSync(workspaceLockfile).mtimeMs);
  } catch {
    // No workspace lockfile to consider (shouldn't happen in this repo,
    // but isn't this script's problem to fail on).
  }

  const known = candidates.filter((value) => value !== null && value !== undefined);
  return known.length > 0 ? Math.max(...known) : null;
}

/** True when `abiDir` needs a rebuild: missing/empty, or older than the crate's sources. */
function isAbiBuildStale(crateRoot, workspaceLockfile, abiDir) {
  const outputNewest = newestMtimeMs(abiDir);
  if (outputNewest === null) {
    return true;
  }

  const srcNewest = sourceNewestMtimeMs(crateRoot, workspaceLockfile);
  if (srcNewest === null) {
    return false;
  }

  return srcNewest > outputNewest;
}

function hasRustupTargetInstalled(runner, triple) {
  const result = runner('rustup', ['target', 'list', '--installed'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(
      `\`rustup target list --installed\` failed: ${result.error || `exit code ${result.status}`}`
    );
  }
  return (result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .includes(triple);
}

function ensureRustupTarget(runner, triple) {
  if (hasRustupTargetInstalled(runner, triple)) {
    return;
  }
  const result = runner('rustup', ['target', 'add', triple], { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw new Error(
      `\`rustup target add ${triple}\` failed: ${result.error || `exit code ${result.status}`}`
    );
  }
}

function hasCargoNdk(runner) {
  const result = runner('cargo', ['ndk', '--version'], { encoding: 'utf8' });
  return !result.error && result.status === 0;
}

function ensureCargoNdk(runner) {
  if (hasCargoNdk(runner)) {
    return;
  }
  const result = runner('cargo', ['install', 'cargo-ndk'], { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw new Error(
      `\`cargo install cargo-ndk\` failed: ${result.error || `exit code ${result.status}`}`
    );
  }
}

/**
 * Resolves an Android NDK directory from the environment, or `null` if none
 * is resolvable. Mirrors the env vars the Android Gradle plugin itself
 * recognizes (`ANDROID_NDK_HOME`/`ANDROID_NDK_ROOT`), falling back to an
 * `ndk/` directory under the SDK root.
 */
function resolveNdk(env) {
  if (env.ANDROID_NDK_HOME) {
    return env.ANDROID_NDK_HOME;
  }
  if (env.ANDROID_NDK_ROOT) {
    return env.ANDROID_NDK_ROOT;
  }

  const sdkRoot = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  if (sdkRoot) {
    const ndkDir = path.join(sdkRoot, 'ndk');
    if (fs.existsSync(ndkDir)) {
      return ndkDir;
    }
  }

  return null;
}

function ndkMissingError() {
  return new Error(
    'Android NDK not found: set ANDROID_NDK_HOME (or ANDROID_NDK_ROOT) to an installed NDK, ' +
      'or install one under your Android SDK (ANDROID_HOME/ANDROID_SDK_ROOT) via, e.g.:\n' +
      '  sdkmanager --install "ndk;27.1.12297006"\n' +
      'Re-run the Android build once that finishes.'
  );
}

function buildAbi(runner, { abi, triple }, crateRoot, jniLibsRoot) {
  ensureRustupTarget(runner, triple);
  ensureCargoNdk(runner);

  const result = runner(
    'cargo',
    [
      'ndk',
      '-t',
      abi,
      '-o',
      jniLibsRoot,
      'build',
      '--release',
      '--manifest-path',
      path.join(crateRoot, 'Cargo.toml'),
    ],
    { stdio: 'inherit' }
  );

  if (result.error || result.status !== 0) {
    throw new Error(
      `\`cargo ndk\` build for ${abi} failed: ${result.error || `exit code ${result.status}`}`
    );
  }
}

/**
 * Builds any ABI (of `abis`) whose `jniLibs/<abi>` output is stale relative
 * to the crate, auto-installing the Rust target and cargo-ndk as needed.
 * Throws (without attempting any build) if no ABI needs rebuilding work
 * that would require the Android NDK, and the NDK isn't resolvable.
 *
 * Returns the list of ABI names actually (re)built, for logging/tests.
 */
function ensureNativeBuilt({
  crateRoot = DEFAULT_CRATE_ROOT,
  workspaceLockfile = DEFAULT_WORKSPACE_LOCKFILE,
  jniLibsRoot = DEFAULT_JNI_LIBS_ROOT,
  abis = ABIS,
  runner = defaultRunner,
  env = process.env,
} = {}) {
  const stale = abis.filter((target) =>
    isAbiBuildStale(crateRoot, workspaceLockfile, path.join(jniLibsRoot, target.abi))
  );

  if (stale.length === 0) {
    return [];
  }

  if (!resolveNdk(env)) {
    throw ndkMissingError();
  }

  for (const target of stale) {
    buildAbi(runner, target, crateRoot, jniLibsRoot);
  }

  return stale.map((target) => target.abi);
}

if (require.main === module) {
  try {
    const built = ensureNativeBuilt();
    if (built.length > 0) {
      console.log(`quic-relay-client: built native library for ${built.join(', ')}`);
    }
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
}

module.exports = {
  ABIS,
  ensureNativeBuilt,
  isAbiBuildStale,
  resolveNdk,
};
