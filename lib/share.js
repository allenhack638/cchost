'use strict';

const fs = require('fs');
const path = require('path');

const profiles = require('./profiles');

// v0.4.1: every profile shares 7 resources with ~/.claude/ (the pool).
//   - 4 directories: projects/, skills/, agents/, commands/
//   - 3 single files: mcp.json, settings.json, CLAUDE.md
// Each resource is a symlink (junction on Windows for dirs; file symlink for
// files — Developer Mode required on Windows or it's skipped with a warning).
//
// Resources are grouped into 3 buckets so callers can target a subset:
//   --projects → projects/
//   --tools    → skills/, agents/, commands/
//   --config   → mcp.json, settings.json, CLAUDE.md
//
// sessions/ is transient per-process state — never shared.
// plugins/ carries auth tokens — never shared.
// .credentials.json, .claude.json, .cc-env.json stay per-profile (identity).
const PROJECT_SUBDIRS = ['projects'];
const TOOL_SUBDIRS = ['skills', 'agents', 'commands'];
const CONFIG_FILES = ['mcp.json', 'settings.json', 'CLAUDE.md'];

const SHARED_DIRS = [...PROJECT_SUBDIRS, ...TOOL_SUBDIRS];
const SHARED_RESOURCES = [...SHARED_DIRS, ...CONFIG_FILES];

// Legacy alias — older callers / tests expect the name SHARED_SUBDIRS for the
// 4-dir set. Kept exported so we don't break them.
const SHARED_SUBDIRS = SHARED_DIRS;

function isFileResource(name) {
  return CONFIG_FILES.includes(name);
}

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

// True if `linkPath` is currently sharing `targetPath` — either via a symlink
// that resolves to it, or (Windows fallback only) via a hard link to the same
// inode. Used for "Shared: N/7" counting and for the doctor check.
function isSharedResource(profileDir, resource) {
  const linkPath = path.join(profileDir, resource);
  const targetPath = path.join(poolDir(), resource);
  let lstat;
  try {
    lstat = fs.lstatSync(linkPath);
  } catch {
    return false;
  }
  if (lstat.isSymbolicLink()) {
    try {
      return fs.realpathSync(linkPath) === fs.realpathSync(targetPath);
    } catch {
      return false;
    }
  }
  // Hard link fallback: a file resource may have been hard-linked on Windows
  // when symlink creation failed. Compare inodes.
  if (lstat.isFile() && isFileResource(resource)) {
    try {
      const targetStat = fs.statSync(targetPath);
      return (
        lstat.ino !== 0 &&
        lstat.ino === targetStat.ino &&
        lstat.dev === targetStat.dev
      );
    } catch {
      return false;
    }
  }
  return false;
}

// Windows junctions are removed via rmdir, not unlink. POSIX symlinks via
// unlink. File symlinks via unlink on both platforms. removeLink tries unlink
// first and falls back to rmdir on Windows. The link target is untouched.
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

// Resolve which resources to operate on. Default (no flags) = all 7.
function resolveSubset({ tools, projects, config } = {}) {
  const any = tools || projects || config;
  if (!any) return SHARED_RESOURCES.slice();
  const out = [];
  if (projects) out.push(...PROJECT_SUBDIRS);
  if (tools) out.push(...TOOL_SUBDIRS);
  if (config) out.push(...CONFIG_FILES);
  return out;
}

function poolDir() {
  return profiles.defaultClaudeDir();
}

// Make sure the pool side of each requested resource exists. Dirs are mkdir'd;
// files get an empty placeholder if missing so the symlink has something to
// point at.
function ensurePoolResources(subset = SHARED_RESOURCES) {
  const base = poolDir();
  try {
    fs.mkdirSync(base, { recursive: true });
  } catch (err) {
    throw new Error(`Cannot create ${base}: ${err.message}`);
  }
  for (const resource of subset) {
    const target = path.join(base, resource);
    try {
      if (isFileResource(resource)) {
        if (!fs.existsSync(target)) fs.writeFileSync(target, '');
      } else {
        fs.mkdirSync(target, { recursive: true });
      }
    } catch (err) {
      throw new Error(`Cannot create ${target}: ${err.message}`);
    }
  }
  return base;
}

// Create the symlink for one resource. For dirs uses junction (Windows) or dir
// symlink (POSIX). For files attempts a file symlink first; on Windows without
// Developer Mode this fails with EPERM/UNKNOWN and we fall back to a hard
// link, which works without elevation and behaves identically for normal
// edit-in-place flows (the leak: `rm + create` breaks the link).
function createResourceLink(target, link, resource) {
  if (!isFileResource(resource)) {
    fs.symlinkSync(target, link, symlinkType());
    return { kind: 'symlink' };
  }
  try {
    fs.symlinkSync(target, link, 'file');
    return { kind: 'symlink' };
  } catch (err) {
    if (
      process.platform === 'win32' &&
      (err.code === 'EPERM' || err.code === 'UNKNOWN' || err.code === 'EACCES')
    ) {
      fs.linkSync(target, link);
      return { kind: 'hardlink' };
    }
    throw err;
  }
}

// Link each requested resource of a profile into the shared pool (~/.claude/).
// Each resource is attempted independently — one failure doesn't abort the
// rest. Returns [{ resource, status, ... }]; status ∈
//   'linked' | 'already-linked' | 'refused' | 'failed'
//
// 'refused' is the v0.4.1 behavior when the profile holds private content at
// the resource path: we do NOT auto-move it into the pool (was the v0.4.0
// behavior for dirs). The user must move/remove it manually.
function shareLink(profileName, opts = {}) {
  profiles.validateProfileName(profileName);
  const pdir = profiles.profileDir(profileName);
  if (!fs.existsSync(pdir)) {
    const err = new Error(
      `Profile "${profileName}" does not exist. Create it with \`cc add ${profileName}\` first.`,
    );
    err.exitCode = 1;
    throw err;
  }
  const subset = resolveSubset(opts);
  ensurePoolResources(subset);
  const pool = poolDir();
  const legacyPool = profiles.sharedDir();
  const results = [];
  for (const resource of subset) {
    const target = path.join(pool, resource);
    const link = path.join(pdir, resource);
    try {
      // Case 1: already a symlink.
      if (isLink(link)) {
        const current = fs.readlinkSync(link);
        const resolved = path.resolve(pdir, current);
        if (resolved === target) {
          results.push({ resource, status: 'already-linked' });
          continue;
        }
        if (resolved === path.join(legacyPool, resource)) {
          // Legacy v0.3 pointer — silently relink to the new pool location.
          removeLink(link);
          const r = createResourceLink(target, link, resource);
          results.push({ resource, status: 'linked', relinkedFromLegacy: true, kind: r.kind });
          continue;
        }
        // Points somewhere unexpected — don't touch it.
        results.push({ resource, status: 'already-linked' });
        continue;
      }

      // Case 2: already linked via hard link (Windows file fallback).
      if (isSharedResource(pdir, resource)) {
        results.push({ resource, status: 'already-linked' });
        continue;
      }

      // Case 3: a real path exists at the link location — private content.
      if (fs.existsSync(link)) {
        const hasContent = isFileResource(resource)
          ? true // any private file counts as content
          : (() => {
              try { return fs.readdirSync(link).length > 0; } catch { return false; }
            })();
        if (hasContent) {
          results.push({
            resource,
            status: 'refused',
            message:
              `private content exists at ${link} — move or remove it manually, ` +
              `then re-run \`cc link ${profileName}\``,
          });
          continue;
        }
        // Empty private dir — safe to remove and replace with a symlink.
        try { fs.rmdirSync(link); } catch { /* fall through; create will fail clearly */ }
      }

      const r = createResourceLink(target, link, resource);
      results.push({ resource, status: 'linked', kind: r.kind });
    } catch (err) {
      results.push({ resource, status: 'failed', message: err.message });
    }
  }
  return results;
}

// Mirror of shareLink: each requested resource is restored to a private real
// directory or file. Content is copied from the pool (skip same-name
// collisions, defensive) so the profile keeps its current view.
// Returns [{ resource, status, ... }]; status ∈
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
  for (const resource of subset) {
    const link = path.join(pdir, resource);
    const target = path.join(pool, resource);
    try {
      const symLinked = isLink(link);
      const hardLinked = !symLinked && isSharedResource(pdir, resource);
      if (!symLinked && !hardLinked) {
        results.push({ resource, status: 'not-linked' });
        continue;
      }

      // Read pool content BEFORE removing the link (in case the link is the
      // only path to it... well, not really — target is reachable directly —
      // but reading first means we can fail without leaving a deleted link).
      if (isFileResource(resource)) {
        // Files: read current content, then replace link with a real file.
        let buf = null;
        if (fs.existsSync(target)) {
          try { buf = fs.readFileSync(target); } catch { buf = null; }
        }
        // For a hard link, unlink decrements ref count — target file in pool
        // survives. For a symlink, unlink removes the link only.
        removeLink(link);
        if (buf != null) {
          fs.writeFileSync(link, buf);
        } else {
          fs.writeFileSync(link, '');
        }
        results.push({ resource, status: 'unlinked' });
        continue;
      }

      // Dirs: replace symlink with a real dir, then copy contents (skip
      // same-name collisions — defensive, dir is fresh so collisions
      // shouldn't happen).
      removeLink(link);
      fs.mkdirSync(link, { recursive: true });
      if (fs.existsSync(target)) {
        for (const ent of fs.readdirSync(target)) {
          const from = path.join(target, ent);
          const to = path.join(link, ent);
          if (fs.existsSync(to)) continue; // skip same-name
          copyRecursive(from, to);
        }
      }
      results.push({ resource, status: 'unlinked' });
    } catch (err) {
      results.push({ resource, status: 'failed', message: err.message });
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
function migrateLegacyPool({ log = () => {} } = {}) {
  const legacy = profiles.sharedDir();
  if (!fs.existsSync(legacy)) {
    return { migrated: false, moves: [], relinked: [], failures: [] };
  }
  const pool = poolDir();
  const moves = [];
  const relinked = [];
  const failures = [];

  // Legacy pool only ever held the 4 dirs — config files are new in v0.4.1.
  for (const sub of SHARED_DIRS) {
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
      // best-effort
    }
  }

  // Re-point any existing profile symlinks from legacy/<sub> to pool/<sub>.
  let allProfiles;
  try {
    allProfiles = profiles.listProfiles();
  } catch {
    allProfiles = [];
  }
  for (const p of allProfiles) {
    for (const sub of SHARED_DIRS) {
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

  // Remove the legacy pool dir if it ended up empty.
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
  SHARED_RESOURCES,
  SHARED_DIRS,
  SHARED_SUBDIRS, // legacy alias for SHARED_DIRS
  TOOL_SUBDIRS,
  PROJECT_SUBDIRS,
  CONFIG_FILES,
  isFileResource,
  isLink,
  isSharedResource,
  removeLink,
  shareLink,
  shareUnlink,
  resolveSubset,
  poolDir,
  ensurePoolResources,
  migrateLegacyPool,
};
