'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const profiles = require('./profiles');

// sessions/ is transient per-process state — intentionally not migrated.
// plugins/ carries auth tokens — excluded until an explicit opt-in flag is added.
const SUBDIRS = ['projects', 'skills', 'agents', 'commands'];

// Single files copied only when src=default and dest=<profile>.
// Not copied to shared: these carry per-profile config / auth tokens.
const SINGLE_FILES = ['mcp.json', 'settings.json', 'CLAUDE.md'];

// .cc-env.json carries a third-party API key — same security category as
// .credentials.json. It must NEVER be copied to a shared pool or another
// profile, so it is excluded explicitly here (it also lives at the profile
// root, outside SUBDIRS, but this guards against any future copy path).
const EXCLUDED_FILES = new Set(['.credentials.json', '.claude.json', '.cc-env.json']);

function defaultClaudeDir() {
  // Single source of truth lives in lib/profiles.js since v0.4 — kept here as
  // a thin re-export so older import sites continue to work.
  return profiles.defaultClaudeDir();
}

function usageError(msg) {
  const e = new Error(msg);
  e.exitCode = 2;
  return e;
}

// 'shared' was a migrate src/dest in v0.2 and v0.3 when the pool lived at
// ~/.claude-shared/. In v0.4 the pool IS ~/.claude/, reached via per-profile
// symlinks created on `cc add`. Migration between two locations that are now
// one no longer makes sense, so the keyword is rejected with a hint.
function rejectSharedKeyword(role) {
  return usageError(
    `'shared' is not a valid migrate ${role} in v0.4. ` +
      "The shared pool is now ~/.claude/ itself, reached via per-profile " +
      "symlinks. Use `cc link <profile>` / `cc unlink <profile> --tools|--projects` " +
      "to manage which artifacts are shared.",
  );
}

function resolveSource(src) {
  if (src === 'default') return { kind: 'default', dir: defaultClaudeDir() };
  if (src === 'shared') throw rejectSharedKeyword('source');
  throw usageError(`Invalid migrate source "${src}". Allowed: default.`);
}

function resolveDest(dest) {
  if (dest === 'shared') throw rejectSharedKeyword('destination');
  if (dest === 'default') {
    throw usageError('Cannot migrate into "default". Allowed destination: <profile>.');
  }
  profiles.validateProfileName(dest);
  return { kind: 'profile', name: dest, dir: profiles.profileDir(dest) };
}

function copyTreeSkipCollisions(srcRoot, dstRoot, { force = false } = {}) {
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

// Returns 'copied', 'skipped', or 'absent'.
function copySingleFile(srcDir, dstDir, fileName, { force = false } = {}) {
  const from = path.join(srcDir, fileName);
  if (!fs.existsSync(from)) return 'absent';
  const to = path.join(dstDir, fileName);
  if (fs.existsSync(to)) {
    if (force) {
      fs.rmSync(to, { recursive: true, force: true });
    } else {
      return 'skipped';
    }
  }
  fs.copyFileSync(from, to);
  return 'copied';
}

function migrate(srcArg, destArg, { force = false } = {}) {
  const src = resolveSource(srcArg);
  const dest = resolveDest(destArg);

  if (path.resolve(src.dir) === path.resolve(dest.dir)) {
    throw usageError(`Source and destination resolve to the same directory (${src.dir}).`);
  }

  if (dest.kind === 'profile') {
    profiles.ensureProfileDir(dest.name);
  } else {
    fs.mkdirSync(dest.dir, { recursive: true });
  }

  if (!fs.existsSync(src.dir)) {
    console.log(`Source ${src.dir} does not exist. Nothing to migrate.`);
    return { copied: 0, skipped: 0, files: {} };
  }

  let totalCopied = 0;
  let totalSkipped = 0;
  for (const sub of SUBDIRS) {
    const srcSub = path.join(src.dir, sub);
    const dstSub = path.join(dest.dir, sub);
    if (!fs.existsSync(srcSub)) continue;

    // v0.4: a profile's subdirs may be symlinks that already resolve to the
    // source. Copying through such a symlink would write the source onto
    // itself. Detect and skip with a clear message.
    let dstStat;
    try {
      dstStat = fs.lstatSync(dstSub);
    } catch {
      dstStat = null;
    }
    if (dstStat && dstStat.isSymbolicLink()) {
      const linkTarget = path.resolve(path.dirname(dstSub), fs.readlinkSync(dstSub));
      if (linkTarget === path.resolve(srcSub)) {
        console.log(`  ${sub}: already shared via symlink (no copy needed)`);
        continue;
      }
    }

    const { copied, skipped } = copyTreeSkipCollisions(srcSub, dstSub, { force });
    console.log(`  ${sub}: copied ${copied}, skipped ${skipped}`);
    totalCopied += copied;
    totalSkipped += skipped;
  }

  // Single config files: only when migrating from default into a profile.
  const fileResults = {};
  if (src.kind === 'default' && dest.kind === 'profile') {
    for (const f of SINGLE_FILES) {
      const result = copySingleFile(src.dir, dest.dir, f, { force });
      fileResults[f] = result;
      const label = result === 'absent' ? 'not present at source' : result;
      console.log(`  ${f}: ${label}`);
      if (result === 'copied') totalCopied += 1;
      else if (result === 'skipped') totalSkipped += 1;
    }
  }

  console.log(`Done. Total copied: ${totalCopied}, total skipped (already present): ${totalSkipped}.`);
  return { copied: totalCopied, skipped: totalSkipped, files: fileResults };
}

module.exports = {
  migrate,
  defaultClaudeDir,
  resolveSource,
  resolveDest,
  copyTreeSkipCollisions,
  copySingleFile,
  SUBDIRS,
  SINGLE_FILES,
  EXCLUDED_FILES,
};
