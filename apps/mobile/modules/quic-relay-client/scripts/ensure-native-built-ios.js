#!/usr/bin/env node
'use strict';

/**
 * Wired into `QuicRelayClient.podspec`'s `s.script_phase` (see that file's
 * comment for why a `script_phase` rather than this package's `prepare`
 * npm lifecycle script) -- see issue #161, the iOS companion to #156
 * (Android; `scripts/ensure-native-built.js`).
 *
 * Produces `QuicRelayClientFramework.xcframework` at this module's root by
 * cross-compiling `packages/quic-relay-client` (the Rust crate) for all
 * three iOS target triples and lipo/xcframework-packaging them, exactly
 * where the podspec's existing `s.vendored_frameworks` already expects it.
 *
 * Unlike Android's script (which drives `cargo-ndk` directly per ABI),
 * this shells out to `ubrn build ios --and-generate`, which already runs
 * the per-target `cargo build`, lipo-merges the simulator slices, and runs
 * `xcodebuild -create-xcframework` internally -- see
 * `node_modules/uniffi-bindgen-react-native/crates/ubrn_cli/src/jsi/ios/commands.rs`.
 * This script only adds: staleness skipping, auto-installing the Rust
 * targets, and failing fast with an actionable error if Xcode/the Command
 * Line Tools aren't installed (or this isn't macOS at all).
 *
 * Reuses `scripts/lib-freshness.js`'s `newestMtimeMs` the same way
 * `ensure-native-built.js` does: the workspace-root `Cargo.lock` is an
 * extra source-freshness input alongside the crate root itself, since a
 * `cargo update` can change it without touching anything under the crate
 * root.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { newestMtimeMs } = require('./lib-freshness');

const MODULE_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(MODULE_ROOT, '..', '..', '..', '..');
const DEFAULT_CRATE_ROOT = path.join(
  REPO_ROOT,
  'packages',
  'quic-relay-client'
);
const DEFAULT_WORKSPACE_LOCKFILE = path.join(REPO_ROOT, 'Cargo.lock');
// Matches QuicRelayClient.podspec's `s.vendored_frameworks` and ubrn's own
// default framework naming (package name -> UpperCamelCase + "Framework").
const DEFAULT_XCFRAMEWORK_PATH = path.join(
  MODULE_ROOT,
  'QuicRelayClientFramework.xcframework'
);

// Device, Apple Silicon simulator, Intel simulator -- always all three
// regardless of the host Mac's own architecture, so the resulting
// xcframework works on both kinds of simulator.
const IOS_TARGETS = [
  'aarch64-apple-ios',
  'aarch64-apple-ios-sim',
  'x86_64-apple-ios',
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

  const known = candidates.filter(
    (value) => value !== null && value !== undefined
  );
  return known.length > 0 ? Math.max(...known) : null;
}

/**
 * True when the xcframework needs a (re)build: missing/empty, or older
 * than the crate's sources (crate root plus the workspace Cargo.lock).
 */
function isXcframeworkBuildStale(
  crateRoot,
  workspaceLockfile,
  xcframeworkPath
) {
  const outputNewest = newestMtimeMs(xcframeworkPath);
  if (outputNewest === null) {
    return true;
  }

  const srcNewest = sourceNewestMtimeMs(crateRoot, workspaceLockfile);
  if (srcNewest === null) {
    return false;
  }

  return srcNewest > outputNewest;
}

function xcodeMissingError() {
  return new Error(
    'Xcode (or the Xcode Command Line Tools) not found: `xcodebuild -version` failed. ' +
      'Building the quic-relay-client iOS native library requires Xcode -- install it from ' +
      'the App Store, or run `xcode-select --install` for just the Command Line Tools, then ' +
      're-run the iOS build. (This also covers the case of not running on macOS at all: iOS ' +
      'native builds require a Mac.)'
  );
}

/** Throws `xcodeMissingError()` unless `xcodebuild -version` succeeds. */
function ensureXcodeInstalled(runner) {
  const result = runner('xcodebuild', ['-version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw xcodeMissingError();
  }
}

function hasRustupTargetInstalled(runner, triple) {
  const result = runner('rustup', ['target', 'list', '--installed'], {
    encoding: 'utf8',
  });
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
  const result = runner('rustup', ['target', 'add', triple], {
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `\`rustup target add ${triple}\` failed: ${result.error || `exit code ${result.status}`}`
    );
  }
}

/**
 * Resolves the `ubrn` CLI binary via Node module resolution from
 * `moduleRoot`, the same way `ensure-built.js`'s `resolveBobBin()` resolves
 * `react-native-builder-bob` -- robust to npm's hoisting behavior, unlike a
 * literal `node_modules/.bin/ubrn` path, which isn't guaranteed to exist
 * directly under this module's own `node_modules/` in a monorepo install.
 */
function resolveUbrnBin(moduleRoot) {
  const pkgJsonPath = require.resolve(
    'uniffi-bindgen-react-native/package.json',
    {
      paths: [moduleRoot],
    }
  );
  const pkg = require(pkgJsonPath);
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.ubrn;
  return path.join(path.dirname(pkgJsonPath), binRel);
}

function runUbrnBuildIos(runner, ubrnBin, moduleRoot, targets) {
  const result = runner(
    ubrnBin,
    ['build', 'ios', '--and-generate', '-t', targets.join(',')],
    {
      cwd: moduleRoot,
      stdio: 'inherit',
    }
  );

  if (result.error || result.status !== 0) {
    throw new Error(
      `\`ubrn build ios\` failed: ${result.error || `exit code ${result.status}`}`
    );
  }
}

/**
 * Builds `QuicRelayClientFramework.xcframework` if it's stale relative to
 * the crate, auto-installing any missing Rust targets first. Throws
 * (without attempting any build) if Xcode/the Command Line Tools aren't
 * installed.
 *
 * Returns the list of target triples built (empty if the xcframework was
 * already fresh), for logging/tests.
 */
function ensureIosNativeBuilt({
  crateRoot = DEFAULT_CRATE_ROOT,
  workspaceLockfile = DEFAULT_WORKSPACE_LOCKFILE,
  xcframeworkPath = DEFAULT_XCFRAMEWORK_PATH,
  targets = IOS_TARGETS,
  moduleRoot = MODULE_ROOT,
  ubrnBin,
  runner = defaultRunner,
} = {}) {
  if (!isXcframeworkBuildStale(crateRoot, workspaceLockfile, xcframeworkPath)) {
    return [];
  }

  ensureXcodeInstalled(runner);

  for (const triple of targets) {
    ensureRustupTarget(runner, triple);
  }

  const bin = ubrnBin || resolveUbrnBin(moduleRoot);
  runUbrnBuildIos(runner, bin, moduleRoot, targets);

  return targets;
}

if (require.main === module) {
  try {
    const built = ensureIosNativeBuilt();
    if (built.length > 0) {
      console.log(
        `quic-relay-client: built iOS xcframework for ${built.join(', ')}`
      );
    }
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
}

module.exports = {
  IOS_TARGETS,
  ensureIosNativeBuilt,
  isXcframeworkBuildStale,
  resolveUbrnBin,
};
