'use strict';

const fs = require('fs');
const path = require('path');

const profiles = require('./profiles');

// Artifact directories shared across profiles via symlink to ~/.claude/.
// Split into two groups so callers can target either set without affecting the
// other. Both groups together form SHARED_SUBDIRS (kept for backward compat —
// cli code reads it for the cc list "Shared" column).
//
// TOOL_SUBDIRS are user-authored or installed tooling: one set, used by every
// profile. PROJECT_SUBDIRS hold conversation transcripts; in v0.4 they share
// by default too, but a user can opt out per profile with
// `cc unlink <profile> --projects` if they want per-account history.
//
// sessions/ is transient per-process state — never shared.
// plugins/ carries auth tokens — never shared.
const TOOL_SUBDIRS = ['skills', 'agents', 'commands'];
const PROJECT_SUBDIRS = ['projects'];
const SHARED_SUBDIRS = [...PROJECT_SUBDIRS, ...TOOL_SUBDIRS];

function symlinkType() {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// Windows junctions are removed via rmdir, not unlink. POSIX symlinks via
// unlink. Both leave the target intact — only the link is removed.
function removeLink(p) {
  try {
    fs.unlinkSync(p);
    return;
  } catch (err) {
    if (process.platform !== 'win32') throw err;
  }
  fs.rmdirSync(p);
}

function copyRecursive(src, dst) {
  fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
}

// Resolve which subset of subdirs to operate on. Default (no flags) = all 4.
function resolveSubset({ tools, projects } = {}) {
  if (tools && !projects) return TOOL_SUBDIRS.slice();
  if (projects && !tools) return PROJECT_SUBDIRS.slice();
  return SHARED_SUBDIRS.slice();
}

function poolDir() {
  return profiles.defaultClaudeDir();
}

function ensurePoolDirs(subset = SHARED_SUBDIRS) {
  const base = poolDir();
  try {
    fs.mkdirSync(base, { recursive: true });
  } catch (err) {
    throw new Error(`Cannot create ${base}: ${err.message}`);
  }
  for (const sub of subset) {
    try {
      fs.mkdirSync(path.join(base, sub), { recursive: true });
    } catch (err) {
      throw new Error(`Cannot create ${path.join(base, sub)}: ${err.message}`);
    }
  }
  return base;
}

// Move every entry from `src` into `target`, renaming on collision so existing
// pool content is never overwritten. Used when a profile already has real
// content in a subdir that we want to fold into the shared pool.
function migrateIntoPool(profileName, src, target) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(target, { recursive: true });
  let moved = 0;
  for (const ent of fs.readdirSync(src)) {
    const from = path.join(src, ent);
    let to = path.join(target, ent);
    if (fs.existsSync(to)) {
      to = path.join(target, `${ent}__${profileName}`);
      let i = 2;
      while (fs.existsSync(to)) {
        to = path.join(target, `${ent}__${profileName}_${i}`);
        i += 1;
      }
    }
    fs.renameSync(from, to);
    moved += 1;
  }
  fs.rmdirSync(src);
  return moved;
}

// Link each requested subdir of a profile into the shared pool (~/.claude/).
// Each subdir is attempted independently; one failure doesn't abort the rest.
// Returns [{ sub, status, moved?, message? }]; status ∈
//   'linked' | 'already-linked' | 'failed'
//
// Also handles the legacy case: if a subdir is already a symlink but points at
// the old ~/.claude-shared/ location, it is relinked to ~/.claude/.
function shareLink(profileName, opts = {}) {
  profiles.validateProfileName(profileName);
  const pdir = profiles.profileDir(profileName);
  if (!fs.existsSync(pdir)) {
    const err = new Error(`Profile "${profileName}" does not exist. Create it with \`cc add ${profileName}\` first.`);
    err.exitCode = 1;
    throw err;
  }
  const subset = resolveSubset(opts);
  ensurePoolDirs(subset);
  const pool = poolDir();
  const legacyPool = profiles.sharedDir();
  const results = [];
  for (const sub of subset) {
    const target = path.join(pool, sub);
    const link = path.join(pdir, sub);
    try {
      if (isLink(link)) {
        // Already a link — check whether it points at the current pool
        // (~/.claude/<sub>) or the legacy pool (~/.claude-shared/<sub>).
        // The latter is upgraded silently.
        const current = fs.readlinkSync(link);
        const resolved = path.resolve(pdir, current);
        if (resolved === target) {
          results.push({ sub, status: 'already-linked' });
          continue;
        }
        if (resolved === path.join(legacyPool, sub)) {
          removeLink(link);
          fs.symlinkSync(target, link, symlinkType());
          results.push({ sub, status: 'linked', relinkedFromLegacy: true });
          continue;
        }
        // Points somewhere unexpected — treat as already-linked, don't touch.
        results.push({ sub, status: 'already-linked' });
        continue;
      }
      let moved = 0;
      if (fs.existsSync(link)) {
        moved = migrateIntoPool(profileName, link, target);
      }
      fs.symlinkSync(target, link, symlinkType());
      results.push({ sub, status: 'linked', moved });
    } catch (err) {
      results.push({ sub, status: 'failed', message: err.message });
    }
  }
  return results;
}

// Mirror of shareLink: each requested subdir is restored to a private real
// directory. Content is copied back from the pool so the profile keeps its
// own view of what was there.
// Returns [{ sub, status, message? }]; status ∈
//   'unlinked' | 'not-linked' | 'failed'
function shareUnlink(profileName, opts = {}) {
  profiles.validateProfileName(profileName);
  const pdir = profiles.profileDir(profileName);
  if (!fs.existsSync(pdir)) {
    const err = new Error(`Profile "${profileName}" does not exist.`);
    err.exitCode = 1;
    throw err;
  }
  const subset = resolveSubset(opts);
  const pool = poolDir();
  const results = [];
  for (const sub of subset) {
    const link = path.join(pdir, sub);
    const target = path.join(pool, sub);
    try {
      if (!isLink(link)) {
        results.push({ sub, status: 'not-linked' });
        continue;
      }
      removeLink(link);
      fs.mkdirSync(link, { recursive: true });
      if (fs.existsSync(target)) {
        for (const ent of fs.readdirSync(target)) {
          copyRecursive(path.join(target, ent), path.join(link, ent));
        }
      }
      results.push({ sub, status: 'unlinked' });
    } catch (err) {
      results.push({ sub, status: 'failed', message: err.message });
    }
  }
  return results;
}

// One-time migration from the v0.2/v0.3 legacy pool at ~/.claude-shared/ to
// the v0.4 pool at ~/.claude/. Idempotent: a second call is a no-op once the
// legacy dir is gone. Non-destructive: existing entries in ~/.claude/ survive
// via the `__legacy` collision rename used here.
//
// Returns { migrated, moves: [...], relinked: [...], failures: [...] }
//   migrated: true if the legacy pool existed and we did work.
//   moves:    files moved from legacy → new pool.
//   relinked: profile symlinks repointed from legacy → new pool.
//   failures: per-item issues; non-fatal, the caller decides how to report.
function migrateLegacyPool({ log = () => {} } = {}) {
  const legacy = profiles.sharedDir();
  if (!fs.existsSync(legacy)) {
    return { migrated: false, moves: [], relinked: [], failures: [] };
  }
  const pool = poolDir();
  const moves = [];
  const relinked = [];
  const failures = [];

  // Step 1: move legacy pool contents into the new pool, with collision rename.
  for (const sub of SHARED_SUBDIRS) {
    const legacySub = path.join(legacy, sub);
    if (!fs.existsSync(legacySub)) continue;
    try {
      fs.mkdirSync(path.join(pool, sub), { recursive: true });
    } catch (err) {
      failures.push({ kind: 'mkdir', sub, message: err.message });
      continue;
    }
    let entries;
    try {
      entries = fs.readdirSync(legacySub);
    } catch (err) {
      failures.push({ kind: 'readdir', sub, message: err.message });
      continue;
    }
    for (const ent of entries) {
      const from = path.join(legacySub, ent);
      let to = path.join(pool, sub, ent);
      if (fs.existsSync(to)) {
        to = path.join(pool, sub, `${ent}__legacy`);
        let i = 2;
        while (fs.existsSync(to)) {
          to = path.join(pool, sub, `${ent}__legacy_${i}`);
          i += 1;
        }
      }
      try {
        fs.renameSync(from, to);
        moves.push({ sub, name: ent, to });
        log(`  ${sub}/${ent} → ${to}`);
      } catch (err) {
        failures.push({ kind: 'move', sub, name: ent, message: err.message });
      }
    }
    try {
      if (fs.readdirSync(legacySub).length === 0) fs.rmdirSync(legacySub);
    } catch {
      // best-effort — the dir may still hold items we failed to move
    }
  }

  // Step 2: re-point any existing profile symlinks from legacy/<sub> to pool/<sub>.
  let allProfiles;
  try {
    allProfiles = profiles.listProfiles();
  } catch {
    allProfiles = [];
  }
  for (const p of allProfiles) {
    for (const sub of SHARED_SUBDIRS) {
      const link = path.join(p.dir, sub);
      if (!isLink(link)) continue;
      let resolved;
      try {
        resolved = path.resolve(p.dir, fs.readlinkSync(link));
      } catch {
        continue;
      }
      if (resolved !== path.join(legacy, sub)) continue;
      try {
        removeLink(link);
        fs.symlinkSync(path.join(pool, sub), link, symlinkType());
        relinked.push({ profile: p.name, sub });
        log(`  ${p.name}/${sub}: relinked → ~/.claude/${sub}/`);
      } catch (err) {
        failures.push({ kind: 'relink', profile: p.name, sub, message: err.message });
      }
    }
  }

  // Step 3: remove the legacy pool dir if it ended up empty.
  try {
    if (fs.existsSync(legacy) && fs.readdirSync(legacy).length === 0) {
      fs.rmdirSync(legacy);
      log('  removed empty ~/.claude-shared/');
    }
  } catch {
    // best-effort
  }

  return { migrated: true, moves, relinked, failures };
}

module.exports = {
  SHARED_SUBDIRS,
  TOOL_SUBDIRS,
  PROJECT_SUBDIRS,
  isLink,
  removeLink,
  shareLink,
  shareUnlink,
  resolveSubset,
  poolDir,
  ensurePoolDirs,
  migrateLegacyPool,
};
