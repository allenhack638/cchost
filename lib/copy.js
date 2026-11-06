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

const EXCLUDED_FILES = new Set(['.credentials.json', '.claude.json', '.cc-env.json']);

function defaultClaudeDir() {
  return profiles.defaultClaudeDir();
}

function usageError(msg) {
  const e = new Error(msg);
  e.exitCode = 2;
  return e;
}

function rejectSharedKeyword(role) {
  return usageError(
    `'shared' is not a valid copy ${role} in v0.4. ` +
      "The shared pool is now ~/.claude/ itself, reached via per-profile " +
      "symlinks. Use `cchost link <profile>` / `cchost unlink <profile>` to manage " +
      "which resources are shared.",
  );
}

function resolveSource(src) {
  if (src === 'default') return { kind: 'default', dir: defaultClaudeDir() };
  if (src === 'shared') throw rejectSharedKeyword('source');
  throw usageError(`Invalid copy source "${src}". Allowed: default.`);
}

function resolveDest(dest) {
  if (dest === 'shared') throw rejectSharedKeyword('destination');
  if (dest === 'default') {
    throw usageError('Cannot copy into "default". Allowed destination: <profile>.');
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
// overwrite (force). Returns { copied, skipped }.
function copyDirContents(srcRoot, dstRoot, { force = false } = {}) {
  if (!fs.existsSync(srcRoot)) return { copied: 0, skipped: 0 };
  fs.mkdirSync(dstRoot, { recursive: true });
  let copied = 0;
  let skipped = 0;
  for (const ent of fs.readdirSync(srcRoot, { withFileTypes: true })) {
    if (EXCLUDED_FILES.has(ent.name)) continue;
    const from = path.join(srcRoot, ent.name);
    const to = path.join(dstRoot, ent.name);
    if (fs.existsSync(to)) {
      if (force) {
        fs.rmSync(to, { recursive: true, force: true });
      } else {
        skipped += 1;
        continue;
      }
    }
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    copied += 1;
  }
  return { copied, skipped };
}

// Copy a single file. Returns 'copied' | 'skipped' | 'absent'.
function copySingleFile(srcPath, dstPath, { force = false } = {}) {
  if (!fs.existsSync(srcPath)) return 'absent';
  if (fs.existsSync(dstPath)) {
    if (force) {
      fs.rmSync(dstPath, { recursive: true, force: true });
    } else {
      return 'skipped';
    }
  }
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  fs.copyFileSync(srcPath, dstPath);
  return 'copied';
}

function formatResourceLabel(resource) {
  return share.isFileResource(resource) ? resource : `${resource}/`;
}

// Main entry: copy each of the 7 shared resources from src → dest, honoring
// the v0.4 symlink semantics. Logs per-resource progress and a closing
// summary line. Returns a structured result for tests.
function copy(srcArg, destArg, { force = false } = {}) {
  const src = resolveSource(srcArg);
  const dest = resolveDest(destArg);

  if (path.resolve(src.dir) === path.resolve(dest.dir)) {
    throw usageError(`Source and destination resolve to the same directory (${src.dir}).`);
  }

  profiles.ensureProfileDir(dest.name);
  if (!fs.existsSync(src.dir)) {
    console.log(`Source ${src.dir} does not exist. Nothing to copy.`);
    return { copied: 0, skipped: 0, shared: 0, results: [] };
  }

  let totalCopied = 0;
  let totalSkipped = 0;
  let totalShared = 0;
  const results = [];

  // Compute the column width so the per-line output aligns.
  const maxLabel = share.SHARED_RESOURCES.reduce(
    (m, r) => Math.max(m, formatResourceLabel(r).length),
    0,
  );

  for (const resource of share.SHARED_RESOURCES) {
    const label = formatResourceLabel(resource).padEnd(maxLabel + 1);
    const srcPath = path.join(src.dir, resource);
    const dstPath = path.join(dest.dir, resource);
    const isFile = share.isFileResource(resource);

    // Already-shared check: same on-disk target via symlink or hard link.
    if (fs.existsSync(dstPath) && fs.existsSync(srcPath) && sameOnDisk(srcPath, dstPath)) {
      console.log(`  ${label} shared via symlink — skipped`);
      results.push({ resource, status: 'shared' });
      totalShared += 1;
      continue;
    }

    if (!fs.existsSync(srcPath)) {
      console.log(`  ${label} not present at source`);
      results.push({ resource, status: 'absent' });
      continue;
    }

    if (isFile) {
      const r = copySingleFile(srcPath, dstPath, { force });
      if (r === 'copied') {
        console.log(`  ${label} copied`);
        totalCopied += 1;
      } else if (r === 'skipped') {
        console.log(`  ${label} skipped (already present — pass --force to overwrite)`);
        totalSkipped += 1;
      } else {
        console.log(`  ${label} not present at source`);
      }
      results.push({ resource, status: r });
      continue;
    }

    const { copied, skipped } = copyDirContents(srcPath, dstPath, { force });
    if (copied === 0 && skipped === 0) {
      console.log(`  ${label} empty at source`);
    } else if (copied > 0) {
      const more = skipped > 0 ? `, skipped ${skipped} (already present)` : '';
      console.log(`  ${label} copied ${copied} item(s)${more}`);
    } else {
      console.log(
        `  ${label} skipped ${skipped} item(s) (all already present — pass --force to overwrite)`,
      );
    }
    totalCopied += copied;
    totalSkipped += skipped;
    results.push({ resource, status: 'dir', copied, skipped });
  }

  console.log('');
  if (totalCopied === 0 && totalShared === share.SHARED_RESOURCES.length) {
    console.log(
      `Nothing to copy — all ${share.SHARED_RESOURCES.length} resources are already shared via symlinks.`,
    );
    console.log(
      `Tip: run \`cchost unlink ${dest.name}\` first if you want private copies in this profile.`,
    );
  } else if (totalCopied === 0) {
    console.log(
      `Nothing copied. ${totalShared} shared via symlink, ${totalSkipped} skipped (already present).`,
    );
  } else {
    console.log(
      `Done. Copied ${totalCopied} item(s), ${totalShared} already shared via symlinks` +
        (totalSkipped > 0 ? `, ${totalSkipped} skipped (already present)` : '') +
        '.',
    );
  }

  return { copied: totalCopied, skipped: totalSkipped, shared: totalShared, results };
}

module.exports = {
  copy,
  defaultClaudeDir,
  resolveSource,
  resolveDest,
  copyDirContents,
  copySingleFile,
  EXCLUDED_FILES,
};
