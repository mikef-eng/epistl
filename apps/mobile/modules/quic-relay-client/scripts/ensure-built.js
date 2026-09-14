#!/usr/bin/env node
'use strict';

/**
 * Wired as this package's `prepare` script (see package.json). Runs on
 * `npm install` from `apps/mobile` (npm always runs a local `file:`
 * dependency's `prepare` script) and rebuilds the compiled `lib/` output
 * via `bob build` only when it's missing or stale relative to `src/`
 * (issue #111) -- a no-op the rest of the time, so `npm install` stays fast
 * for unrelated changes rather than unconditionally rebuilding this module
 * on every install.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { isBuildStale } = require('./lib-freshness');

const moduleRoot = path.resolve(__dirname, '..');
const srcDir = path.join(moduleRoot, 'src');
const libDir = path.join(moduleRoot, 'lib');

function resolveBobBin() {
  const pkgJsonPath = require.resolve('react-native-builder-bob/package.json', {
    paths: [moduleRoot],
  });
  const pkg = require(pkgJsonPath);
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.bob;
  return path.join(path.dirname(pkgJsonPath), binRel);
}

if (!isBuildStale(srcDir, libDir)) {
  process.exit(0);
}

const result = spawnSync(process.execPath, [resolveBobBin(), 'build'], {
  cwd: moduleRoot,
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

process.exit(result.status === null ? 1 : result.status);
