'use strict';

/**
 * Issue #156: `apps/mobile/modules/quic-relay-client/scripts/ensure-native-built.js`
 * cross-compiles the Rust crate per Android ABI via `cargo-ndk`, wired into
 * a Gradle task rather than into npm's `prepare` lifecycle (see that
 * script's header comment for why). This exercises it entirely through an
 * injectable/mockable command runner -- no real Rust toolchain, cargo-ndk,
 * or Android NDK required to run these tests (matching
 * `quicRelayClientLibFreshness.test.js`'s pattern, and CI's `mobile` job,
 * which has none of those installed).
 *
 * Plain `.js` (not `.ts`) on purpose, same reasoning as
 * `quicRelayClientLibFreshness.test.js`: a build-script helper, not app
 * code, kept out of `tsc --noEmit`'s project.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ABIS,
  ensureNativeBuilt,
  isAbiBuildStale,
} = require('../modules/quic-relay-client/scripts/ensure-native-built');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'quic-relay-client-ensure-native-built-'));
}

function writeFileWithMtime(filePath, contents, mtimeMs) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  const seconds = mtimeMs / 1000;
  fs.utimesSync(filePath, seconds, seconds);
}

/**
 * A fake command runner: `responses` maps a `"<command> <args.join(' ')>"`
 * key (or a prefix of it) to a canned `{ status, stdout }` result. Every
 * invocation is recorded in `calls` for assertions. Unmatched commands
 * default to a successful, empty result so unrelated calls don't need to be
 * stubbed explicitly.
 */
function makeFakeRunner(responses = {}) {
  const calls = [];
  const runner = (command, args) => {
    const key = [command, ...args].join(' ');
    calls.push({ command, args, key });

    const match = Object.keys(responses).find((prefix) => key.startsWith(prefix));
    if (match) {
      return responses[match];
    }
    return { status: 0, stdout: '' };
  };
  return { runner, calls };
}

const ARM64 = ABIS.find((target) => target.abi === 'arm64-v8a');

describe('quic-relay-client ensure-native-built ABI staleness (issue #156)', () => {
  let tempDir;
  let crateRoot;
  let workspaceLockfile;

  beforeEach(() => {
    tempDir = makeTempDir();
    crateRoot = path.join(tempDir, 'crate');
    workspaceLockfile = path.join(tempDir, 'Cargo.lock');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('treats a missing ABI output directory as stale', () => {
    writeFileWithMtime(path.join(crateRoot, 'src', 'lib.rs'), 'fn main() {}', Date.now());
    const abiDir = path.join(tempDir, 'jniLibs', 'arm64-v8a');

    expect(fs.existsSync(abiDir)).toBe(false);
    expect(isAbiBuildStale(crateRoot, workspaceLockfile, abiDir)).toBe(true);
  });

  it('is not stale when the ABI output is newer than the crate sources and lockfile', () => {
    const now = Date.now();
    writeFileWithMtime(path.join(crateRoot, 'src', 'lib.rs'), 'fn main() {}', now);
    writeFileWithMtime(workspaceLockfile, 'lockfile', now);
    writeFileWithMtime(
      path.join(tempDir, 'jniLibs', 'arm64-v8a', 'libquic_relay_client.a'),
      'built',
      now + 60_000
    );

    expect(
      isAbiBuildStale(crateRoot, workspaceLockfile, path.join(tempDir, 'jniLibs', 'arm64-v8a'))
    ).toBe(false);
  });

  it('is stale when the workspace Cargo.lock changes after the last build (e.g. `cargo update`)', () => {
    const now = Date.now();
    writeFileWithMtime(path.join(crateRoot, 'src', 'lib.rs'), 'fn main() {}', now);
    writeFileWithMtime(workspaceLockfile, 'old lock', now);
    const abiDir = path.join(tempDir, 'jniLibs', 'arm64-v8a');
    writeFileWithMtime(path.join(abiDir, 'libquic_relay_client.a'), 'built', now + 60_000);

    // A `cargo update` can change the workspace-root Cargo.lock without
    // touching anything under the crate root itself.
    writeFileWithMtime(workspaceLockfile, 'new lock', now + 120_000);

    expect(isAbiBuildStale(crateRoot, workspaceLockfile, abiDir)).toBe(true);
  });
});

describe('quic-relay-client ensure-native-built build orchestration (issue #156)', () => {
  let tempDir;
  let crateRoot;
  let workspaceLockfile;
  let jniLibsRoot;

  beforeEach(() => {
    tempDir = makeTempDir();
    crateRoot = path.join(tempDir, 'crate');
    workspaceLockfile = path.join(tempDir, 'Cargo.lock');
    jniLibsRoot = path.join(tempDir, 'jniLibs');

    writeFileWithMtime(path.join(crateRoot, 'src', 'lib.rs'), 'fn main() {}', Date.now());
    writeFileWithMtime(workspaceLockfile, 'lockfile', Date.now());
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Marks every ABI except `except` as already fresh, so a run only touches `except`. */
  function makeAllFreshExcept(except) {
    const future = Date.now() + 60 * 60 * 1000;
    for (const target of ABIS) {
      if (target.abi === except) {
        continue;
      }
      writeFileWithMtime(
        path.join(jniLibsRoot, target.abi, 'libquic_relay_client.a'),
        'built',
        future
      );
    }
  }

  it('skips an ABI whose output is already fresh (no commands run for it)', () => {
    makeAllFreshExcept(null); // every ABI is fresh
    const { runner, calls } = makeFakeRunner();
    const env = { ANDROID_NDK_HOME: '/opt/fake-ndk' };

    const built = ensureNativeBuilt({
      crateRoot,
      workspaceLockfile,
      jniLibsRoot,
      runner,
      env,
    });

    expect(built).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('runs `rustup target add` when the target is not already installed', () => {
    makeAllFreshExcept('arm64-v8a');
    const { runner, calls } = makeFakeRunner({
      'rustup target list --installed': { status: 0, stdout: 'x86_64-linux-android\n' },
    });
    const env = { ANDROID_NDK_HOME: '/opt/fake-ndk' };

    const built = ensureNativeBuilt({
      crateRoot,
      workspaceLockfile,
      jniLibsRoot,
      abis: [ARM64],
      runner,
      env,
    });

    expect(built).toEqual(['arm64-v8a']);
    expect(calls).toContainEqual(
      expect.objectContaining({ command: 'rustup', args: ['target', 'add', 'aarch64-linux-android'] })
    );
  });

  it('does not run `rustup target add` when the target is already installed', () => {
    makeAllFreshExcept('arm64-v8a');
    const { runner, calls } = makeFakeRunner({
      'rustup target list --installed': {
        status: 0,
        stdout: 'aarch64-linux-android\nx86_64-linux-android\n',
      },
    });
    const env = { ANDROID_NDK_HOME: '/opt/fake-ndk' };

    ensureNativeBuilt({ crateRoot, workspaceLockfile, jniLibsRoot, abis: [ARM64], runner, env });

    expect(calls.some((call) => call.command === 'rustup' && call.args[1] === 'add')).toBe(false);
  });

  it('runs `cargo install cargo-ndk` when cargo-ndk is not already installed', () => {
    makeAllFreshExcept('arm64-v8a');
    const { runner, calls } = makeFakeRunner({
      'rustup target list --installed': { status: 0, stdout: 'aarch64-linux-android\n' },
      'cargo ndk --version': { status: 1, stdout: '' },
    });
    const env = { ANDROID_NDK_HOME: '/opt/fake-ndk' };

    const built = ensureNativeBuilt({
      crateRoot,
      workspaceLockfile,
      jniLibsRoot,
      abis: [ARM64],
      runner,
      env,
    });

    expect(built).toEqual(['arm64-v8a']);
    expect(calls).toContainEqual(
      expect.objectContaining({ command: 'cargo', args: ['install', 'cargo-ndk'] })
    );
  });

  it('does not run `cargo install cargo-ndk` when it is already installed', () => {
    makeAllFreshExcept('arm64-v8a');
    const { runner, calls } = makeFakeRunner({
      'rustup target list --installed': { status: 0, stdout: 'aarch64-linux-android\n' },
      'cargo ndk --version': { status: 0, stdout: 'cargo-ndk 3.5.4\n' },
    });
    const env = { ANDROID_NDK_HOME: '/opt/fake-ndk' };

    ensureNativeBuilt({ crateRoot, workspaceLockfile, jniLibsRoot, abis: [ARM64], runner, env });

    expect(calls.some((call) => call.command === 'cargo' && call.args[0] === 'install')).toBe(
      false
    );
  });

  it('runs the actual `cargo ndk` build with the right ABI and manifest path', () => {
    makeAllFreshExcept('arm64-v8a');
    const { runner, calls } = makeFakeRunner({
      'rustup target list --installed': { status: 0, stdout: 'aarch64-linux-android\n' },
      'cargo ndk --version': { status: 0, stdout: 'cargo-ndk 3.5.4\n' },
    });
    const env = { ANDROID_NDK_HOME: '/opt/fake-ndk' };

    ensureNativeBuilt({ crateRoot, workspaceLockfile, jniLibsRoot, abis: [ARM64], runner, env });

    expect(calls).toContainEqual(
      expect.objectContaining({
        command: 'cargo',
        args: [
          'ndk',
          '-t',
          'arm64-v8a',
          '-o',
          jniLibsRoot,
          'build',
          '--release',
          '--manifest-path',
          path.join(crateRoot, 'Cargo.toml'),
        ],
      })
    );
  });

  it('fails fast with an actionable error and non-zero-worthy throw when the NDK is missing, without attempting a cargo ndk build', () => {
    makeAllFreshExcept('arm64-v8a');
    const { runner, calls } = makeFakeRunner({
      'rustup target list --installed': { status: 0, stdout: 'aarch64-linux-android\n' },
      'cargo ndk --version': { status: 0, stdout: 'cargo-ndk 3.5.4\n' },
    });
    const env = {}; // no ANDROID_NDK_HOME/ANDROID_NDK_ROOT/ANDROID_HOME/ANDROID_SDK_ROOT

    expect(() =>
      ensureNativeBuilt({ crateRoot, workspaceLockfile, jniLibsRoot, abis: [ARM64], runner, env })
    ).toThrow(/ANDROID_NDK_HOME/);

    expect(calls.some((call) => call.command === 'cargo' && call.args[0] === 'ndk')).toBe(false);
    expect(
      calls.some((call) => call.command === 'rustup' || call.command === 'cargo')
    ).toBe(false);
  });

  it('resolves the NDK from an `ndk/` directory under ANDROID_HOME when no explicit NDK env var is set', () => {
    makeAllFreshExcept('arm64-v8a');
    const sdkRoot = path.join(tempDir, 'sdk');
    fs.mkdirSync(path.join(sdkRoot, 'ndk'), { recursive: true });
    const { runner } = makeFakeRunner({
      'rustup target list --installed': { status: 0, stdout: 'aarch64-linux-android\n' },
      'cargo ndk --version': { status: 0, stdout: 'cargo-ndk 3.5.4\n' },
    });
    const env = { ANDROID_HOME: sdkRoot };

    const built = ensureNativeBuilt({
      crateRoot,
      workspaceLockfile,
      jniLibsRoot,
      abis: [ARM64],
      runner,
      env,
    });

    expect(built).toEqual(['arm64-v8a']);
  });
});
