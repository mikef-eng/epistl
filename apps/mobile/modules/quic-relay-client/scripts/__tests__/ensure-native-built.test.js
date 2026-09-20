#!/usr/bin/env node
'use strict';

/**
 * Unit tests for scripts/ensure-native-built.js (issue #235).
 *
 * Covers:
 *   AC1 — isAbiBuildStale returns true when jniLibs/<abi>/ has only a .so
 *          (or any non-.a file) even if it is newer than crate sources.
 *   AC2 — buildAbi / ensureNativeBuilt copies libquic_relay_client.a from
 *          target/<triple>/release/ to jniLibs/<abi>/ after cargo ndk.
 *
 * Uses node:test + node:assert (Node 18+). No external test framework needed.
 * Run via:
 *   node --test scripts/__tests__/ensure-native-built.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  isAbiBuildStale,
  ensureNativeBuilt,
  resolveNdk,
  ABIS,
} = require('../ensure-native-built');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory tree for use in one test. */
function makeTmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `enb-test-${label}-`));
}

/** Write a file with optionally controlled mtime. */
function writeFile(filePath, content = 'x') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/** Touch a file to the given timestamp (milliseconds since epoch). */
function setMtime(filePath, mtimeMs) {
  const sec = mtimeMs / 1000;
  fs.utimesSync(filePath, sec, sec);
}

// ---------------------------------------------------------------------------
// AC1: isAbiBuildStale — .a presence check
// ---------------------------------------------------------------------------

describe('isAbiBuildStale — only .so present', () => {
  let tmp;
  beforeEach(() => {
    tmp = makeTmpDir('stale');
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('returns true when abiDir has only a .so file, even newer than sources', () => {
    const crateRoot = path.join(tmp, 'crate');
    const lockfile = path.join(tmp, 'Cargo.lock');
    const abiDir = path.join(tmp, 'jniLibs', 'arm64-v8a');

    // Write a crate source file with an old mtime
    writeFile(path.join(crateRoot, 'src', 'lib.rs'));
    writeFile(lockfile);
    const past = Date.now() - 60_000;
    setMtime(path.join(crateRoot, 'src', 'lib.rs'), past);
    setMtime(lockfile, past);

    // Write only a .so (no .a) with a mtime NEWER than sources
    writeFile(path.join(abiDir, 'libquic_relay_client.so'));
    // .so is newer than sources — old isAbiBuildStale would say "not stale"
    // New isAbiBuildStale must detect missing .a and say "stale"

    const stale = isAbiBuildStale(crateRoot, lockfile, abiDir);
    assert.equal(stale, true, 'should be stale when .a is absent even if .so is present and newer than sources');
  });

  test('returns false when .a is present and newer than sources', () => {
    const crateRoot = path.join(tmp, 'crate');
    const lockfile = path.join(tmp, 'Cargo.lock');
    const abiDir = path.join(tmp, 'jniLibs', 'arm64-v8a');

    // Write old source files
    writeFile(path.join(crateRoot, 'src', 'lib.rs'));
    writeFile(lockfile);
    const past = Date.now() - 60_000;
    setMtime(path.join(crateRoot, 'src', 'lib.rs'), past);
    setMtime(lockfile, past);

    // Write both .so and .a newer than sources
    writeFile(path.join(abiDir, 'libquic_relay_client.so'));
    writeFile(path.join(abiDir, 'libquic_relay_client.a'));

    const stale = isAbiBuildStale(crateRoot, lockfile, abiDir);
    assert.equal(stale, false, 'should NOT be stale when .a is present and newer than sources');
  });

  test('returns true when abiDir is empty (baseline)', () => {
    const crateRoot = path.join(tmp, 'crate');
    const lockfile = path.join(tmp, 'Cargo.lock');
    const abiDir = path.join(tmp, 'jniLibs', 'arm64-v8a');

    writeFile(path.join(crateRoot, 'src', 'lib.rs'));
    writeFile(lockfile);
    fs.mkdirSync(abiDir, { recursive: true });

    assert.equal(isAbiBuildStale(crateRoot, lockfile, abiDir), true);
  });

  test('returns true when abiDir does not exist (baseline)', () => {
    const crateRoot = path.join(tmp, 'crate');
    const lockfile = path.join(tmp, 'Cargo.lock');
    const abiDir = path.join(tmp, 'jniLibs', 'arm64-v8a');

    writeFile(path.join(crateRoot, 'src', 'lib.rs'));
    writeFile(lockfile);
    // abiDir intentionally not created

    assert.equal(isAbiBuildStale(crateRoot, lockfile, abiDir), true);
  });

  test('returns true when .a is present but older than sources', () => {
    const crateRoot = path.join(tmp, 'crate');
    const lockfile = path.join(tmp, 'Cargo.lock');
    const abiDir = path.join(tmp, 'jniLibs', 'arm64-v8a');

    writeFile(path.join(abiDir, 'libquic_relay_client.a'));
    const past = Date.now() - 60_000;
    setMtime(path.join(abiDir, 'libquic_relay_client.a'), past);

    // Sources are newer than the .a
    writeFile(path.join(crateRoot, 'src', 'lib.rs'));
    writeFile(lockfile);

    assert.equal(isAbiBuildStale(crateRoot, lockfile, abiDir), true);
  });
});

// ---------------------------------------------------------------------------
// AC2: ensureNativeBuilt copies .a after cargo ndk
// ---------------------------------------------------------------------------

describe('ensureNativeBuilt — copies .a from cargo target dir', () => {
  let tmp;
  beforeEach(() => {
    tmp = makeTmpDir('copy-a');
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('copies libquic_relay_client.a from target/<triple>/release/ to jniLibs/<abi>/', () => {
    const crateRoot = path.join(tmp, 'crate');
    const lockfile = path.join(tmp, 'Cargo.lock');
    const jniLibsRoot = path.join(tmp, 'jniLibs');

    // Only a missing abiDir triggers a build
    writeFile(path.join(crateRoot, 'src', 'lib.rs'));
    writeFile(lockfile);

    // Build a fake runner: simulates cargo ndk placing a .so (only) and
    // the .a living in the cargo target dir, as real cargo-ndk does.
    const calls = [];
    const fakeRunner = (cmd, args, opts) => {
      calls.push({ cmd, args });
      // rustup target list --installed
      if (cmd === 'rustup' && args.includes('--installed')) {
        return { status: 0, stdout: 'aarch64-linux-android\n', stderr: '' };
      }
      // cargo ndk --version (hasCargoNdk check)
      if (cmd === 'cargo' && args.includes('--version')) {
        return { status: 0, stdout: 'cargo-ndk 3.5.7\n', stderr: '' };
      }
      // cargo ndk build: simulate .so landing in jniLibs/<abi>/ and
      // .a being produced in target/<triple>/release/
      if (cmd === 'cargo' && args.includes('ndk')) {
        // Extract abi and triple from args
        const tIdx = args.indexOf('-t');
        const abi = tIdx !== -1 ? args[tIdx + 1] : 'arm64-v8a';
        const target = ABIS.find((a) => a.abi === abi) || { triple: 'aarch64-linux-android' };

        // cargo-ndk -o places .so
        const abiDir = path.join(jniLibsRoot, abi);
        fs.mkdirSync(abiDir, { recursive: true });
        writeFile(path.join(abiDir, 'libquic_relay_client.so'));

        // cargo build also produces .a in target/<triple>/release/ under repoRoot (tmp)
        const releaseDir = path.join(tmp, 'target', target.triple, 'release');
        fs.mkdirSync(releaseDir, { recursive: true });
        writeFile(path.join(releaseDir, 'libquic_relay_client.a'));

        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const ndkEnv = { ANDROID_NDK_HOME: '/fake/ndk' };

    const built = ensureNativeBuilt({
      crateRoot,
      workspaceLockfile: lockfile,
      jniLibsRoot,
      abis: [{ abi: 'arm64-v8a', triple: 'aarch64-linux-android' }],
      runner: fakeRunner,
      env: ndkEnv,
      // Pass the repo root so .a copy can find target/<triple>/release/
      repoRoot: tmp,
    });

    assert.deepEqual(built, ['arm64-v8a'], 'should report built ABI');

    // The .a must exist in jniLibs/<abi>/ after build
    const dotA = path.join(jniLibsRoot, 'arm64-v8a', 'libquic_relay_client.a');
    assert.equal(fs.existsSync(dotA), true, `libquic_relay_client.a must exist at ${dotA}`);
  });

  test('does not rebuild ABIs already fresh (has .a and newer than sources)', () => {
    const crateRoot = path.join(tmp, 'crate');
    const lockfile = path.join(tmp, 'Cargo.lock');
    const jniLibsRoot = path.join(tmp, 'jniLibs');

    // Old sources
    writeFile(path.join(crateRoot, 'src', 'lib.rs'));
    writeFile(lockfile);
    const past = Date.now() - 60_000;
    setMtime(path.join(crateRoot, 'src', 'lib.rs'), past);
    setMtime(lockfile, past);

    // Fresh .a for all ABIs
    for (const { abi } of ABIS) {
      writeFile(path.join(jniLibsRoot, abi, 'libquic_relay_client.a'));
    }

    const calls = [];
    const fakeRunner = (cmd, args, opts) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: '', stderr: '' };
    };

    const built = ensureNativeBuilt({
      crateRoot,
      workspaceLockfile: lockfile,
      jniLibsRoot,
      runner: fakeRunner,
      env: { ANDROID_NDK_HOME: '/fake/ndk' },
    });

    assert.deepEqual(built, [], 'should not rebuild when all ABIs are fresh');
    const cargoCalls = calls.filter((c) => c.cmd === 'cargo');
    assert.equal(cargoCalls.length, 0, 'should not invoke cargo when nothing is stale');
  });

  test('throws when NDK not resolvable and build is needed', () => {
    const crateRoot = path.join(tmp, 'crate');
    const lockfile = path.join(tmp, 'Cargo.lock');
    const jniLibsRoot = path.join(tmp, 'jniLibs');

    writeFile(path.join(crateRoot, 'src', 'lib.rs'));
    writeFile(lockfile);

    const fakeRunner = () => ({ status: 0, stdout: '', stderr: '' });

    assert.throws(
      () =>
        ensureNativeBuilt({
          crateRoot,
          workspaceLockfile: lockfile,
          jniLibsRoot,
          runner: fakeRunner,
          env: {}, // no NDK env vars
        }),
      /Android NDK not found/,
    );
  });
});

// ---------------------------------------------------------------------------
// resolveNdk
// ---------------------------------------------------------------------------

describe('resolveNdk', () => {
  test('returns ANDROID_NDK_HOME when set', () => {
    assert.equal(resolveNdk({ ANDROID_NDK_HOME: '/ndk' }), '/ndk');
  });

  test('returns ANDROID_NDK_ROOT as fallback', () => {
    assert.equal(resolveNdk({ ANDROID_NDK_ROOT: '/ndk2' }), '/ndk2');
  });

  test('returns null when nothing is set', () => {
    assert.equal(resolveNdk({}), null);
  });
});
