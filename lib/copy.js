'use strict';

// `cchost copy` — copy mcp.json / settings.json / CLAUDE.md / artifact dirs from
// ~/.claude/ (default) into a profile. Renamed from `cchost migrate` in v0.4.1;
// `cchost migrate` still works as a deprecation alias.
//
// Only direction supported: default → <profile>. The reverse and profile→
// profile were considered and dropped — they're rare enough that a manual
// `cp -r` is fine and keeps the surface small.
//
// Most v0.4 profiles have all 7 resources symlinked into the pool, so
// `cchost copy default foo` is usually a no-op (every resource resolves to the
// same path as the source). The command is meaningful only when a resource
// has been unlinked via `cchost unlink`.

const fs = require('fs');
const path = require('path');

const profiles = require('./profiles');
const share = require('./share');
const errors = require('./errors');

const EXCLUDED_FILES = new Set(['.credentials.json', '.claude.json', '.cc-env.json']);

function defaultClaudeDir() {
  return profiles.defaultClaudeDir();
}

function rejectSharedKeyword(role) {
  return errors.usage(`'shared' is not a valid copy ${role} in v0.4. ` +
      "The shared pool is now ~/.claude/ itself, reached via per-profile " +
      "symlinks. Use `cchost link <profile>` / `cchost unlink <profile>` to manage " +
      "which resources are shared.");
}

function resolveSource(src) {
  if (src === 'default') return { kind: 'default', dir: defaultClaudeDir() };
  if (src === 'shared') throw rejectSharedKeyword('source');
  throw errors.usage(`Invalid copy source "${src}". Allowed: default.`);
}

function resolveDest(dest) {
  if (dest === 'shared') throw rejectSharedKeyword('destination');
  if (dest === 'default') {
    throw errors.usage('Cannot copy into "default". Allowed destination: <profile>.');
  }
  profiles.validateProfileName(dest);
  return { kind: 'profile', name: dest, dir: profiles.profileDir(dest) };
}

// Return resolved real paths, or null if a path can't be realpath'd. Used to
// detect "src and dst are the same file/dir under symlinks/hardlinks".
function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

// Compare two existing paths for "are these the same on-disk object?". Honors
// symlinks (via realpath) and hard links (via inode comparison for files).
function sameOnDisk(a, b) {
  const ra = realOrNull(a);
  const rb = realOrNull(b);
  if (ra && rb && ra === rb) return true;
  // Inode comparison — covers Windows hard links where realpath does not
  // resolve to the same string but the files share an inode.
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (sa.isFile() && sb.isFile() && sa.ino !== 0 && sa.ino === sb.ino && sa.dev === sb.dev) {
      return true;
    }
  } catch {
    // either side missing — not the same
  }
  return false;
}

// Copy directory contents item-by-item with skip-on-collision (default) or
// overwrite (force). Returns { copied, skipped }. With dryRun the counts are
// what a real run would produce, and nothing is written.
function copyDirContents(srcRoot, dstRoot, { force = false, dryRun = false } = {}) {
  if (!fs.existsSync(srcRoot)) return { copied: 0, skipped: 0 };
  if (!dryRun) fs.mkdirSync(dstRoot, { recursive: true });
  let copied = 0;
  let skipped = 0;
  for (const ent of fs.readdirSync(srcRoot, { withFileTypes: true })) {
    if (EXCLUDED_FILES.has(ent.name)) continue;
    const from = path.join(srcRoot, ent.name);
    const to = path.join(dstRoot, ent.name);
    if (fs.existsSync(to)) {
      if (!force) {
        skipped += 1;
        continue;
      }
      if (!dryRun) fs.rmSync(to, { recursive: true, force: true });
    }
    if (!dryRun) fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    copied += 1;
  }
  return { copied, skipped };
}

// Copy a single file. Returns 'copied' | 'skipped' | 'absent'.
function copySingleFile(srcPath, dstPath, { force = false, dryRun = false } = {}) {
  if (!fs.existsSync(srcPath)) return 'absent';
  if (fs.existsSync(dstPath)) {
    if (!force) return 'skipped';
    if (!dryRun) fs.rmSync(dstPath, { recursive: true, force: true });
  }
  if (dryRun) return 'copied';
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  fs.copyFileSync(srcPath, dstPath);
  return 'copied';
}


// Main entry: copy each of the 7 shared resources from src → dest, honoring
// the v0.4 symlink semantics. Logs per-resource progress and a closing
// summary line. Returns a structured result for tests. With dryRun the same
// report is printed in the conditional ("would copy") and nothing is written.
function copy(srcArg, destArg, { force = false, dryRun = false } = {}) {
  const src = resolveSource(srcArg);
  const dest = resolveDest(destArg);
  if (path.resolve(src.dir) === path.resolve(dest.dir)) {
    throw errors.usage(`Source and destination resolve to the same directory (${src.dir}).`);
  }
  if (!dryRun) profiles.ensureProfileDir(dest.name);
  if (!fs.existsSync(src.dir)) return { copied: 0, skipped: 0, shared: 0, results: [] };

  const results = [];
  for (const resource of share.SHARED_RESOURCES) {
    const srcPath = path.join(src.dir, resource);
    const dstPath = path.join(dest.dir, resource);
    if (fs.existsSync(dstPath) && fs.existsSync(srcPath) && sameOnDisk(srcPath, dstPath)) {
      results.push({ resource, status: 'shared' });
    } else if (!fs.existsSync(srcPath)) {
      results.push({ resource, status: 'absent' });
    } else if (share.isFileResource(resource)) {
      results.push({ resource, status: copySingleFile(srcPath, dstPath, { force, dryRun }) });
    } else {
      results.push({ resource, status: 'dir', ...copyDirContents(srcPath, dstPath, { force, dryRun }) });
    }
  }
  const count = (fn) => results.reduce((n, r) => n + fn(r), 0);
  return {
    copied: count((r) => (r.status === 'dir' ? r.copied : Number(r.status === 'copied'))),
    skipped: count((r) => (r.status === 'dir' ? r.skipped : Number(r.status === 'skipped'))),
    shared: count((r) => Number(r.status === 'shared')),
    results,
  };
}

module.exports = { copy, defaultClaudeDir, EXCLUDED_FILES };
