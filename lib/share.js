'use strict';

const fs = require('fs');
const path = require('path');

const profiles = require('./profiles');
const errors = require('./errors');

// Profiles share these with ~/.claude/ (the pool) via symlinks.
// Never shared: sessions/ (per-process), plugins/ (auth tokens) and the
// identity files .credentials.json, .claude.json, .cc-env.json.
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

// True if the resource is linked to the pool by symlink, or by hard link
// (Windows fallback).
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
  // Windows hard-link fallback: compare inodes.
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

// Windows junctions need rmdir, not unlink. The link target is untouched.
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

// No flags means all resources.
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

// Missing pool files get an empty placeholder so the symlink has a target.
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

// Windows without Developer Mode can't make file symlinks, so fall back to a
// hard link. It breaks if an editor replaces the file instead of editing it.
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

// Resources made private on purpose, so `doctor --fix` won't re-share an
// empty or absent one. Never shared.
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

// 'shared' | 'private' | 'empty' | 'missing' | 'foreign-link'. A resource
// marked in .cc-private.json is 'private' even when empty or absent.
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

// Status per resource: linked | already-linked | foreign-link | failed |
// refused (private content is never moved; opts.backup renames it aside).
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
      if (isLink(link)) {
        const current = fs.readlinkSync(link);
        const resolved = path.resolve(pdir, current);
        if (resolved === target) {
          results.push({ resource, status: 'already-linked' });
          continue;
        }
        if (resolved === path.join(legacyPool, resource)) {
          // Points at the old ~/.claude-shared/ pool: relink.
          if (dryRun) {
            results.push({ resource, status: 'linked', relinkedFromLegacy: true });
            continue;
          }
          removeLink(link);
          const r = createResourceLink(target, link, resource);
          results.push({ resource, status: 'linked', relinkedFromLegacy: true, kind: r.kind });
          continue;
        }
        // Points elsewhere: leave it, and don't report it as shared.
        results.push({
          resource,
          status: 'foreign-link',
          message: `symlink points to ${resolved}, not ${target} — left untouched`,
        });
        continue;
      }

      // Windows hard-link fallback.
      if (isSharedResource(pdir, resource)) {
        results.push({ resource, status: 'already-linked' });
        continue;
      }

      if (fs.existsSync(link)) {
        const hasContent = isFileResource(resource)
          ? true
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
        // Empty dir: safe to replace with the link.
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

// Replace each link with a private copy of the pool content.
// Status: unlinked | not-linked | failed. dryRun dir results carry `items`.
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

      // Read before removing the link, so a read failure leaves the link intact.
      if (isFileResource(resource)) {
        let buf = null;
        if (fs.existsSync(target)) {
          try { buf = fs.readFileSync(target); } catch { buf = null; }
        }
        // Removing a symlink or hard link leaves the pool file intact.
        removeLink(link);
        if (buf != null) {
          fs.writeFileSync(link, buf);
        } else {
          fs.writeFileSync(link, '');
        }
        results.push({ resource, status: 'unlinked' });
        continue;
      }

      removeLink(link);
      fs.mkdirSync(link, { recursive: true });
      if (fs.existsSync(target)) {
        for (const ent of fs.readdirSync(target)) {
          const from = path.join(target, ent);
          const to = path.join(link, ent);
          if (fs.existsSync(to)) continue;
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
