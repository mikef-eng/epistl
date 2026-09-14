'use strict';

/**
 * Issue #111: `apps/mobile/modules/quic-relay-client/lib/` (bob-built,
 * gitignored) must be rebuilt whenever it's missing or stale relative to
 * `src/`, and left alone (fast no-op) otherwise -- see
 * `modules/quic-relay-client/scripts/lib-freshness.js`.
 *
 * Plain `.js` (not `.ts`) on purpose: this only exercises a small
 * filesystem-timestamp helper used by a build script, not app code, and
 * staying untyped keeps it out of `tsc --noEmit`'s project entirely.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  isBuildStale,
  newestMtimeMs,
} = require('../modules/quic-relay-client/scripts/lib-freshness');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'quic-relay-client-lib-freshness-'));
}

function writeFileWithMtime(filePath, contents, mtimeMs) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  const seconds = mtimeMs / 1000;
  fs.utimesSync(filePath, seconds, seconds);
}

describe('quic-relay-client lib/ freshness check (issue #111)', () => {
  let tempDir;
  let srcDir;
  let libDir;

  beforeEach(() => {
    tempDir = makeTempDir();
    srcDir = path.join(tempDir, 'src');
    libDir = path.join(tempDir, 'lib');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('treats a missing lib/ as stale (fresh checkout)', () => {
    writeFileWithMtime(path.join(srcDir, 'index.tsx'), 'export {};', Date.now());

    expect(fs.existsSync(libDir)).toBe(false);
    expect(isBuildStale(srcDir, libDir)).toBe(true);
  });

  it('treats an empty lib/ directory as stale', () => {
    writeFileWithMtime(path.join(srcDir, 'index.tsx'), 'export {};', Date.now());
    fs.mkdirSync(libDir, { recursive: true });

    expect(isBuildStale(srcDir, libDir)).toBe(true);
  });

  it('is not stale when lib/ is newer than every src/ file', () => {
    const now = Date.now();
    writeFileWithMtime(path.join(srcDir, 'generated', 'quic_relay_client.ts'), 'x', now);
    writeFileWithMtime(path.join(libDir, 'module', 'index.js'), 'x', now + 60_000);

    expect(isBuildStale(srcDir, libDir)).toBe(false);
  });

  it('is stale when a src/generated/ file changes after the last build (e.g. a git pull)', () => {
    const now = Date.now();
    writeFileWithMtime(path.join(srcDir, 'generated', 'quic_relay_client.ts'), 'old', now);
    writeFileWithMtime(path.join(libDir, 'module', 'generated', 'quic_relay_client.js'), 'old', now + 60_000);

    // Simulate `git pull` landing a new binding (e.g. issue #75's
    // QuicConnection/AuthFailed) without a rebuild: the src file's mtime
    // moves to "now" (past the existing, stale lib/ build).
    writeFileWithMtime(
      path.join(srcDir, 'generated', 'quic_relay_client.ts'),
      'new',
      now + 120_000
    );

    expect(isBuildStale(srcDir, libDir)).toBe(true);
  });

  it('newestMtimeMs returns null for a directory that does not exist', () => {
    expect(newestMtimeMs(path.join(tempDir, 'does-not-exist'))).toBeNull();
  });

  it('newestMtimeMs finds the newest file across nested subdirectories', () => {
    writeFileWithMtime(path.join(srcDir, 'a.ts'), 'a', 1_000_000);
    writeFileWithMtime(path.join(srcDir, 'generated', 'b.ts'), 'b', 3_000_000);
    writeFileWithMtime(path.join(srcDir, 'nested', 'deep', 'c.ts'), 'c', 2_000_000);

    expect(newestMtimeMs(srcDir)).toBe(3_000_000);
  });
});

describe('quic-relay-client lib/ freshness against the real module (issue #111)', () => {
  const moduleRoot = path.resolve(__dirname, '..', 'modules', 'quic-relay-client');
  const realSrcDir = path.join(moduleRoot, 'src');
  const realLibDir = path.join(moduleRoot, 'lib');
  const ensureBuiltScript = path.join(moduleRoot, 'scripts', 'ensure-built.js');

  it('rebuilds a deleted lib/ via the same script npm install runs as `prepare`, matching src/generated/', () => {
    // This is the end-to-end regression for the acceptance criterion:
    // "deliberately stale/delete lib/, run the normal apps/mobile setup
    // step ... confirm typecheck passes without any extra manual command."
    // `npm install` itself is exercised manually (documented in the PR);
    // this runs the exact script that `prepare` invokes, which is the part
    // under this repo's control (npm's own file: dependency lifecycle
    // behavior is not).
    const { execFileSync } = require('child_process');

    expect(fs.existsSync(realSrcDir)).toBe(true);

    fs.rmSync(realLibDir, { recursive: true, force: true });
    expect(isBuildStale(realSrcDir, realLibDir)).toBe(true);

    execFileSync(process.execPath, [ensureBuiltScript], {
      cwd: moduleRoot,
      stdio: 'pipe',
    });

    expect(fs.existsSync(realLibDir)).toBe(true);
    expect(isBuildStale(realSrcDir, realLibDir)).toBe(false);

    const generatedOutput = fs.readFileSync(
      path.join(realLibDir, 'module', 'generated', 'quic_relay_client.js'),
      'utf8'
    );
    // Matches issue #75's bindings (QuicConnection/AuthFailed), so this
    // also guards against a rebuild that silently produces an empty/wrong
    // output.
    expect(generatedOutput).toContain('QuicConnection');
    expect(generatedOutput).toContain('AuthFailed');
  }, 30_000);

  it('is a fast no-op when lib/ is already up to date', () => {
    const { execFileSync } = require('child_process');

    // Ensure a fresh, current build exists first.
    execFileSync(process.execPath, [ensureBuiltScript], { cwd: moduleRoot, stdio: 'pipe' });
    const before = newestMtimeMs(realLibDir);

    execFileSync(process.execPath, [ensureBuiltScript], { cwd: moduleRoot, stdio: 'pipe' });
    const after = newestMtimeMs(realLibDir);

    expect(after).toBe(before);
  }, 30_000);
});
