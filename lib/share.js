'use strict';

const fs = require('fs');
const path = require('path');

const profiles = require('./profiles');
const errors = require('./errors');

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

// <profile>/.cc-private.json records resources the user made private on
// purpose (`cchost add --private`, `cchost unlink`), so an empty or absent
// private resource is not mistaken for a missing link and re-shared by
// `cchost doctor --fix`. `cchost link` removes entries. Never shared.
const PRIVATE_FILE = '.cc-private.json';

function readPrivate(profileDir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(profileDir, PRIVATE_FILE), 'utf8'));
    const list = data && Array.isArray(data.private) ? data.private : [];
    return new Set(list.filter((r) => SHARED_RESOURCES.includes(r)));
  } catch {
    return new Set();
  }
}

function writePrivate(profileDir, set) {
  const p = path.join(profileDir, PRIVATE_FILE);
  const list = SHARED_RESOURCES.filter((r) => set.has(r));
  if (list.length === 0) {
    fs.rmSync(p, { force: true });
    return;
  }
  fs.writeFileSync(p, JSON.stringify({ private: list }, null, 2) + '\n');
}

function markPrivate(profileDir, resources) {
  const set = readPrivate(profileDir);
  const before = set.size;
  for (const r of resources) set.add(r);
  if (set.size !== before) writePrivate(profileDir, set);
}

function unmarkPrivate(profileDir, resources) {
  const set = readPrivate(profileDir);
  let changed = false;
  for (const r of resources) changed = set.delete(r) || changed;
  if (changed) writePrivate(profileDir, set);
}

function isMarkedPrivate(profileDir, resource) {
  return readPrivate(profileDir).has(resource);
}

// Where one resource of a profile currently stands. Returns one of:
//   'shared'       — linked to ~/.claude/ (symlink, junction, or hard link)
//   'private'      — a real file/dir with content, or one recorded as private
//                    on purpose in .cc-private.json (even if empty or absent)
//   'empty'        — a real but empty file/dir (link would replace it)
//   'missing'      — nothing at the path
//   'foreign-link' — a symlink pointing somewhere other than ~/.claude/
function resourceState(profileDir, resource) {
  const p = path.join(profileDir, resource);
  if (isSharedResource(profileDir, resource)) return 'shared';
  if (isLink(p)) return 'foreign-link';
  if (isMarkedPrivate(profileDir, resource)) return 'private';
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return 'missing';
  }
  try {
    const hasContent = st.isDirectory() ? fs.readdirSync(p).length > 0 : st.size > 0;
    return hasContent ? 'private' : 'empty';
  } catch {
    return 'private';
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
//
// opts.dryRun reports the same statuses without touching the filesystem.
// opts.backup renames private content to <resource>.cchost-backup-<stamp>
// instead of refusing. A private copy identical to the pool is replaced.
function backupName(resource, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${resource}.cchost-backup-${stamp}`;
}

function sameContent(a, b, budget = { bytes: 20 * 1024 * 1024 }) {
  let sa, sb;
  try { sa = fs.lstatSync(a); sb = fs.lstatSync(b); } catch { return false; }
  if (sa.isFile() && sb.isFile()) {
    if (sa.size !== sb.size) return false;
    budget.bytes -= sa.size;
    if (budget.bytes < 0) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  }
  if (sa.isDirectory() && sb.isDirectory()) {
    const ea = fs.readdirSync(a).sort();
    const eb = fs.readdirSync(b).sort();
    if (ea.length !== eb.length || ea.some((n, i) => n !== eb[i])) return false;
    return ea.every((n) => sameContent(path.join(a, n), path.join(b, n), budget));
  }
  return false;
}

function shareLink(profileName, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const backup = Boolean(opts.backup);
  profiles.validateProfileName(profileName);
  const pdir = profiles.profileDir(profileName);
  if (!fs.existsSync(pdir)) {
    throw errors.refused(`Profile "${profileName}" does not exist. Create it with \`cchost add ${profileName}\` first.`);
  }
  const subset = resolveSubset(opts);
  if (!dryRun) ensurePoolResources(subset);
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
          if (dryRun) {
            results.push({ resource, status: 'linked', relinkedFromLegacy: true });
            continue;
          }
          removeLink(link);
          const r = createResourceLink(target, link, resource);
          results.push({ resource, status: 'linked', relinkedFromLegacy: true, kind: r.kind });
          continue;
        }
        // Points somewhere unexpected — don't touch it, but report it as not
        // shared so callers don't claim the resource is linked.
        results.push({
          resource,
          status: 'foreign-link',
          message: `symlink points to ${resolved}, not ${target} — left untouched`,
        });
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
        if (hasContent && sameContent(link, target)) {
          if (dryRun) {
            results.push({ resource, status: 'linked', identical: true });
            continue;
          }
          fs.rmSync(link, { recursive: true, force: true });
          const r = createResourceLink(target, link, resource);
          results.push({ resource, status: 'linked', kind: r.kind, identical: true });
          continue;
        }
        if (hasContent && backup) {
          let name = backupName(resource);
          for (let i = 2; fs.existsSync(path.join(pdir, name)); i++) name = `${backupName(resource)}-${i}`;
          if (dryRun) {
            results.push({ resource, status: 'linked', backup: name });
            continue;
          }
          fs.renameSync(link, path.join(pdir, name));
          const r = createResourceLink(target, link, resource);
          results.push({ resource, status: 'linked', kind: r.kind, backup: name });
          continue;
        }
        if (hasContent) {
          results.push({
            resource,
            status: 'refused',
            message:
              `private content exists at ${link} — move or remove it manually, ` +
              `then re-run \`cchost link ${profileName}\``,
          });
          continue;
        }
        // Empty private dir — safe to remove and replace with a symlink.
        if (!dryRun) {
          try { fs.rmdirSync(link); } catch { /* fall through; create will fail clearly */ }
        }
      }

      if (dryRun) {
        results.push({ resource, status: 'linked' });
        continue;
      }
      const r = createResourceLink(target, link, resource);
      results.push({ resource, status: 'linked', kind: r.kind });
    } catch (err) {
      results.push({ resource, status: 'failed', message: err.message });
    }
  }
  if (!dryRun) {
    unmarkPrivate(
      pdir,
      results
        .filter((r) => r.status === 'linked' || r.status === 'already-linked')
        .map((r) => r.resource),
    );
  }
  return results;
}

// Mirror of shareLink: each requested resource is restored to a private real
// directory or file. Content is copied from the pool (skip same-name
// collisions, defensive) so the profile keeps its current view.
// Returns [{ resource, status, ... }]; status ∈
//   'unlinked' | 'not-linked' | 'failed'
//
// opts.dryRun reports the same statuses without touching the filesystem; dir
// results then carry `items`, the number of top-level entries that would be
// copied into the profile.
function shareUnlink(profileName, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  profiles.validateProfileName(profileName);
  const pdir = profiles.profileDir(profileName);
  if (!fs.existsSync(pdir)) {
    throw errors.refused(`Profile "${profileName}" does not exist.`);
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

      if (dryRun) {
        const r = { resource, status: 'unlinked' };
        if (!isFileResource(resource)) {
          try { r.items = fs.readdirSync(target).length; } catch { r.items = 0; }
        }
        results.push(r);
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
  if (!dryRun) {
    markPrivate(pdir, results.filter((r) => r.status === 'unlinked').map((r) => r.resource));
  }
  return results;
}

module.exports = {
  SHARED_RESOURCES,
  SHARED_DIRS,
  TOOL_SUBDIRS,
  PROJECT_SUBDIRS,
  CONFIG_FILES,
  isFileResource,
  isLink,
  isSharedResource,
  resourceState,
  markPrivate,
  isMarkedPrivate,
  removeLink,
  poolDir,
  symlinkType,
  shareLink,
  shareUnlink,
  resolveSubset,
};
