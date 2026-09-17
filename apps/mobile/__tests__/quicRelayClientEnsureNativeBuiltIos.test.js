'use strict';

/**
 * Issue #161 (iOS companion to #156):
 * `apps/mobile/modules/quic-relay-client/scripts/ensure-native-built-ios.js`
 * wraps `ubrn build ios --and-generate` to produce
 * `QuicRelayClientFramework.xcframework`, wired into `QuicRelayClient.podspec`'s
 * `s.script_phase` rather than this package's `prepare` npm lifecycle script
 * (see that script's header comment for why). This exercises it entirely
 * through an injectable/mockable command runner -- no real Xcode, Rust iOS
 * targets, or `ubrn` toolchain required to run these tests (matching
 * `quicRelayClientEnsureNativeBuilt.test.js`'s pattern for Android, and
 * CI's `mobile` job, which has none of those installed).
 *
 * Plain `.js` (not `.ts`) on purpose, same reasoning as the Android test:
 * a build-script helper, not app code, kept out of `tsc --noEmit`'s project.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  IOS_TARGETS,
  ensureIosNativeBuilt,
  isXcframeworkBuildStale,
} = require('../modules/quic-relay-client/scripts/ensure-native-built-ios');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'quic-relay-client-ensure-native-built-ios-'));
}

function writeFileWithMtime(filePath, contents, mtimeMs) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  const seconds = mtimeMs / 1000;
  fs.utimesSync(filePath, seconds, seconds);
}

/**
 * A fake command runner: `responses` maps a `"<command> <args.join(' ')>"`
 * key (or a prefix of it) to a canned `{ status, stdout, error }` result.
 * Every invocation is recorded in `calls` for assertions. Unmatched
 * commands default to a successful, empty result so unrelated calls don't
 * need to be stubbed explicitly.
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

describe('quic-relay-client ensure-native-built-ios xcframework staleness (issue #161)', () => {
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

  it('treats a missing xcframework as stale', () => {
    writeFileWithMtime(path.join(crateRoot, 'src', 'lib.rs'), 'fn main() {}', Date.now());
    const xcframeworkPath = path.join(tempDir, 'QuicRelayClientFramework.xcframework');

    expect(fs.existsSync(xcframeworkPath)).toBe(false);
    expect(isXcframeworkBuildStale(crateRoot, workspaceLockfile, xcframeworkPath)).toBe(true);
  });

  it('is not stale when the xcframework is newer than the crate sources and lockfile', () => {
    const now = Date.now();
    writeFileWithMtime(path.join(crateRoot, 'src', 'lib.rs'), 'fn main() {}', now);
    writeFileWithMtime(workspaceLockfile, 'lockfile', now);
    const xcframeworkPath = path.join(tempDir, 'QuicRelayClientFramework.xcframework');
    writeFileWithMtime(path.join(xcframeworkPath, 'Info.plist'), 'built', now + 60_000);

    expect(isXcframeworkBuildStale(crateRoot, workspaceLockfile, xcframeworkPath)).toBe(false);
  });

  it('is stale when the workspace Cargo.lock changes after the last build (e.g. `cargo update`)', () => {
    const now = Date.now();
    writeFileWithMtime(path.join(crateRoot, 'src', 'lib.rs'), 'fn main() {}', now);
    writeFileWithMtime(workspaceLockfile, 'old lock', now);
    const xcframeworkPath = path.join(tempDir, 'QuicRelayClientFramework.xcframework');
    writeFileWithMtime(path.join(xcframeworkPath, 'Info.plist'), 'built', now + 60_000);

    // A `cargo update` can change the workspace-root Cargo.lock without
    // touching anything under the crate root itself.
    writeFileWithMtime(workspaceLockfile, 'new lock', now + 120_000);

    expect(isXcframeworkBuildStale(crateRoot, workspaceLockfile, xcframeworkPath)).toBe(true);
  });
});

describe('quic-relay-client ensure-native-built-ios build orchestration (issue #161)', () => {
  let tempDir;
  let crateRoot;
  let workspaceLockfile;
  let xcframeworkPath;
  let moduleRoot;

  beforeEach(() => {
    tempDir = makeTempDir();
    crateRoot = path.join(tempDir, 'crate');
    workspaceLockfile = path.join(tempDir, 'Cargo.lock');
    xcframeworkPath = path.join(tempDir, 'QuicRelayClientFramework.xcframework');
    moduleRoot = path.join(tempDir, 'module');

    writeFileWithMtime(path.join(crateRoot, 'src', 'lib.rs'), 'fn main() {}', Date.now());
    writeFileWithMtime(workspaceLockfile, 'lockfile', Date.now());
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeFresh() {
    writeFileWithMtime(
      path.join(xcframeworkPath, 'Info.plist'),
      'built',
      Date.now() + 60 * 60 * 1000
    );
  }

  it('skips the build when the xcframework is already fresh (no commands run)', () => {
    makeFresh();
    const { runner, calls } = makeFakeRunner();

    const built = ensureIosNativeBuilt({
      crateRoot,
      workspaceLockfile,
      xcframeworkPath,
      moduleRoot,
      ubrnBin: '/fake/ubrn',
      runner,
    });

    expect(built).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('checks Xcode is installed before doing anything else, and runs the ubrn build when everything succeeds', () => {
    const { runner, calls } = makeFakeRunner({
      'xcodebuild -version': { status: 0, stdout: 'Xcode 16.0\n' },
      'rustup target list --installed': {
        status: 0,
        stdout: 'aarch64-apple-ios\naarch64-apple-ios-sim\nx86_64-apple-ios\n',
      },
    });

    const built = ensureIosNativeBuilt({
      crateRoot,
      workspaceLockfile,
      xcframeworkPath,
      moduleRoot,
      ubrnBin: '/fake/ubrn',
      runner,
    });

    expect(built).toEqual(IOS_TARGETS);
    expect(calls[0]).toEqual(expect.objectContaining({ command: 'xcodebuild', args: ['-version'] }));
    expect(calls).toContainEqual(
      expect.objectContaining({
        command: '/fake/ubrn',
        args: ['build', 'ios', '--and-generate', '-t', IOS_TARGETS.join(',')],
      })
    );
  });

  it('runs `rustup target add` for each missing iOS target', () => {
    const { runner, calls } = makeFakeRunner({
      'xcodebuild -version': { status: 0, stdout: 'Xcode 16.0\n' },
      'rustup target list --installed': { status: 0, stdout: 'aarch64-apple-ios\n' },
    });

    ensureIosNativeBuilt({
      crateRoot,
      workspaceLockfile,
      xcframeworkPath,
      moduleRoot,
      ubrnBin: '/fake/ubrn',
      runner,
    });

    expect(calls).toContainEqual(
      expect.objectContaining({
        command: 'rustup',
        args: ['target', 'add', 'aarch64-apple-ios-sim'],
      })
    );
    expect(calls).toContainEqual(
      expect.objectContaining({ command: 'rustup', args: ['target', 'add', 'x86_64-apple-ios'] })
    );
    expect(calls).not.toContainEqual(
      expect.objectContaining({ command: 'rustup', args: ['target', 'add', 'aarch64-apple-ios'] })
    );
  });

  it('does not run `rustup target add` when every iOS target is already installed', () => {
    const { runner, calls } = makeFakeRunner({
      'xcodebuild -version': { status: 0, stdout: 'Xcode 16.0\n' },
      'rustup target list --installed': {
        status: 0,
        stdout: 'aarch64-apple-ios\naarch64-apple-ios-sim\nx86_64-apple-ios\n',
      },
    });

    ensureIosNativeBuilt({
      crateRoot,
      workspaceLockfile,
      xcframeworkPath,
      moduleRoot,
      ubrnBin: '/fake/ubrn',
      runner,
    });

    expect(calls.some((call) => call.command === 'rustup' && call.args[1] === 'add')).toBe(false);
  });

  it('fails fast with an actionable Xcode error and does not attempt rustup or ubrn when xcodebuild is missing', () => {
    const { runner, calls } = makeFakeRunner({
      // Simulates both "Xcode not installed" and "not running on macOS at
      // all" -- both surface as `xcodebuild -version` failing.
      'xcodebuild -version': { status: 127, stdout: '', error: new Error('ENOENT') },
    });

    expect(() =>
      ensureIosNativeBuilt({
        crateRoot,
        workspaceLockfile,
        xcframeworkPath,
        moduleRoot,
        ubrnBin: '/fake/ubrn',
        runner,
      })
    ).toThrow(/Xcode/);

    expect(calls).toEqual([expect.objectContaining({ command: 'xcodebuild', args: ['-version'] })]);
    expect(calls.some((call) => call.command === 'rustup')).toBe(false);
    expect(calls.some((call) => call.command === '/fake/ubrn')).toBe(false);
  });

  it('mentions `xcode-select --install` in the actionable Xcode error', () => {
    const { runner } = makeFakeRunner({
      'xcodebuild -version': { status: 1, stdout: '' },
    });

    expect(() =>
      ensureIosNativeBuilt({
        crateRoot,
        workspaceLockfile,
        xcframeworkPath,
        moduleRoot,
        ubrnBin: '/fake/ubrn',
        runner,
      })
    ).toThrow(/xcode-select --install/);
  });
});
