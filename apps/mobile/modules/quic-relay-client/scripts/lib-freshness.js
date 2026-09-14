'use strict';

/**
 * Freshness check backing `scripts/ensure-built.js` (issue #111).
 *
 * `lib/` (bob-built, gitignored) is derived entirely from `src/` (hand
 * written plus `src/generated/` bindings from `uniffi-bindgen-react-native`).
 * On a fresh checkout `lib/` doesn't exist at all; after a `src/generated/`
 * change (e.g. a `git pull`) without a rebuild, `lib/` can be present but
 * stale. Both cases are detected the same way: compare the newest mtime
 * under `src/` against the newest mtime under `lib/`. `git` sets a
 * checked-out/merged file's mtime to "now", so this also catches the
 * "pulled a change, never rebuilt" case, not just the "lib/ missing
 * entirely" case.
 *
 * Kept dependency-free and side-effect-free (no filesystem writes, no
 * child processes) so it's cheap to run on every `npm install` and easy to
 * unit test with plain temp directories.
 */

const fs = require('fs');
const path = require('path');

/**
 * Returns the newest mtime (in ms since epoch) of any regular file nested
 * anywhere under `dir`, or `null` if `dir` doesn't exist or contains no
 * files.
 */
function newestMtimeMs(dir) {
  if (!fs.existsSync(dir)) {
    return null;
  }

  let newest = null;
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const { mtimeMs } = fs.statSync(full);
        if (newest === null || mtimeMs > newest) {
          newest = mtimeMs;
        }
      }
    }
  }

  return newest;
}

/**
 * True when `libDir` needs a rebuild from `srcDir`: missing entirely, or
 * containing no files, or older than the newest file under `srcDir`.
 */
function isBuildStale(srcDir, libDir) {
  const libNewest = newestMtimeMs(libDir);
  if (libNewest === null) {
    return true;
  }

  const srcNewest = newestMtimeMs(srcDir);
  if (srcNewest === null) {
    // No source files to build from; nothing to consider stale against.
    return false;
  }

  return srcNewest > libNewest;
}

module.exports = { newestMtimeMs, isBuildStale };
