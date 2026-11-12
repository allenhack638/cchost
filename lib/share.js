'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const profiles = require('./profiles');

// Strict UUID v4-ish pattern. Used to identify session files / sub-uuid dirs
// in projects/<X>/ so we can preserve a Claude-`--resume`-readable filename
// when merging two folders that hold the same session UUID.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.jsonl)$/i;

function isUuidName(name) {
  return UUID_RE.test(name);
}
function uuidStemOf(name) {
  if (UUID_RE.test(name)) return name;
  const m = name.match(UUID_FILE_RE);
  return m ? m[1] : null;
}

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
    const err = new Error(
      `Profile "${profileName}" does not exist. Create it with \`cchost add ${profileName}\` first.`,
    );
    err.exitCode = 1;
    throw err;
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

// Merge children of src/ into dst/ in place. Used for `projects/` subfolder
// collisions, where the folder name encodes the cwd and renaming the *folder*
// would orphan its sessions from `claude --resume`.
//
// Collision strategy:
//   - For UUID-keyed session files (`<uuid>.jsonl`) and their paired
//     sub-uuid dirs: generate a fresh UUID v4 on collision so the file stays
//     a valid Claude session filename. Pair the file and dir under the same
//     new UUID so they travel together.
//   - For other names (`memory/`, `sessions-index.json`, anything custom):
//     fall back to a `__legacy[_i]` suffix on the file name. These aren't
//     parsed by `--resume`, so the suffix is harmless.
function mergeFolderInto(src, dst, { log = () => {} } = {}) {
  fs.mkdirSync(dst, { recursive: true });
  let moved = 0;
  const failures = [];
  const entries = fs.readdirSync(src);

  // First pass: group UUID-keyed entries by their stem so the .jsonl file
  // and its paired sub-uuid dir can be renamed under the same new UUID on
  // collision.
  const groups = new Map(); // stem -> { dir?: name, file?: name }
  const passthrough = [];
  for (const ent of entries) {
    const stem = uuidStemOf(ent);
    if (!stem) { passthrough.push(ent); continue; }
    if (!groups.has(stem)) groups.set(stem, {});
    const g = groups.get(stem);
    if (UUID_RE.test(ent)) g.dir = ent;
    else g.file = ent;
  }

  for (const [stem, g] of groups) {
    const dirCollides = g.dir && fs.existsSync(path.join(dst, g.dir));
    const fileCollides = g.file && fs.existsSync(path.join(dst, g.file));
    let newStem = stem;
    if (dirCollides || fileCollides) {
      newStem = crypto.randomUUID();
      log(`    ${stem} collides — reissuing as ${newStem}`);
    }
    if (g.dir) {
      const from = path.join(src, g.dir);
      const to = path.join(dst, newStem);
      try {
        fs.renameSync(from, to);
        moved += 1;
        log(`    ${g.dir} → ${path.basename(to)}`);
      } catch (err) {
        failures.push({ name: g.dir, message: err.message });
      }
    }
    if (g.file) {
      const from = path.join(src, g.file);
      const to = path.join(dst, `${newStem}.jsonl`);
      try {
        fs.renameSync(from, to);
        moved += 1;
        log(`    ${g.file} → ${path.basename(to)}`);
      } catch (err) {
        failures.push({ name: g.file, message: err.message });
      }
    }
  }

  for (const ent of passthrough) {
    const from = path.join(src, ent);
    let to = path.join(dst, ent);
    if (fs.existsSync(to)) {
      const dot = ent.lastIndexOf('.');
      const stem = dot > 0 ? ent.slice(0, dot) : ent;
      const ext = dot > 0 ? ent.slice(dot) : '';
      to = path.join(dst, `${stem}__legacy${ext}`);
      let i = 2;
      while (fs.existsSync(to)) {
        to = path.join(dst, `${stem}__legacy_${i}${ext}`);
        i += 1;
      }
    }
    try {
      fs.renameSync(from, to);
      moved += 1;
      log(`    ${ent} → ${path.basename(to)}`);
    } catch (err) {
      failures.push({ name: ent, message: err.message });
    }
  }
  return { moved, failures };
}

// One-time migration from the v0.2/v0.3 legacy pool at ~/.claude-shared/ to
// the v0.4 pool at ~/.claude/. Idempotent: a second call is a no-op once the
// legacy dir is gone.
//
// Collision strategy differs by sub:
//   - skills/, agents/, commands/: named artifacts — rename the incoming
//     folder with a `__legacy` suffix so both versions survive for the user
//     to inspect.
//   - projects/: opaque cwd-keyed buckets of *.jsonl sessions. Renaming the
//     folder would make `claude --resume` invisible to the renamed sessions
//     (it filters by cwd-encoded folder name). Merge children into the
//     existing folder instead. UUID-keyed session-file collisions (rare —
//     happens when the same session UUID was checkpointed across pool
//     migrations) reissue a fresh UUID so the file stays a valid Claude
//     session filename.
//
// Returns { migrated, moves: [...], relinked: [...], failures: [...] }
function migrateLegacyPool({ log = () => {} } = {}) {
  const legacy = profiles.sharedDir();
  if (!fs.existsSync(legacy)) {
    return { migrated: false, moves: [], relinked: [], failures: [] };
  }
  const pool = poolDir();
  // Self-referencing setup: a pre-v0.4 install may have created
  // `~/.claude/projects/` as a junction/symlink pointing into
  // `~/.claude-shared/projects/`. Treating that as a "migration" would move
  // files onto themselves and (worse) trigger merge-collision suffixing on
  // every entry. Detect and abort cleanly.
  for (const sub of SHARED_DIRS) {
    const poolSub = path.join(pool, sub);
    const legacySub = path.join(legacy, sub);
    try {
      if (fs.existsSync(poolSub) && fs.realpathSync(poolSub) === fs.realpathSync(legacySub)) {
        log(`  ${sub}/ in ~/.claude/ is a junction into ~/.claude-shared/ — nothing to migrate.`);
        return { migrated: false, moves: [], relinked: [], failures: [], selfReferencing: true };
      }
    } catch { /* fall through and try the move */ }
  }
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
    const isProjects = PROJECT_SUBDIRS.includes(sub);
    for (const ent of entries) {
      const from = path.join(legacySub, ent);
      const canonical = path.join(pool, sub, ent);

      if (isProjects && fs.existsSync(canonical)) {
        try {
          const r = mergeFolderInto(from, canonical, { log });
          moves.push({ sub, name: ent, to: canonical, merged: true, items: r.moved });
          log(`  ${sub}/${ent} → merged into existing (${r.moved} item${r.moved === 1 ? '' : 's'})`);
          for (const f of r.failures) {
            failures.push({ kind: 'move', sub, name: `${ent}/${f.name}`, message: f.message });
          }
          try {
            if (fs.readdirSync(from).length === 0) fs.rmdirSync(from);
          } catch { /* best-effort */ }
        } catch (err) {
          failures.push({ kind: 'merge', sub, name: ent, message: err.message });
        }
        continue;
      }

      let to = canonical;
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
    allProfiles = profiles.listProfiles().filter((p) => !p.alias);
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

// Strip the __legacy / __legacy_N suffix(es) added by the v0.4 migration's
// collision handler. Repeated migrations could compound suffixes (e.g.
// `foo__legacy__legacy`, `foo__legacy_2`), so peel until stable.
function stripLegacySuffix(name) {
  let s = name;
  while (true) {
    const m = s.match(/^(.+?)__legacy(?:_\d+)?$/);
    if (!m) return s;
    s = m[1];
  }
}

// Find an entry in `entries` whose name matches `target` — exact match first,
// case-insensitive fallback on Windows (NTFS is case-insensitive by default).
function findSibling(entries, target) {
  if (entries.includes(target)) return target;
  if (process.platform === 'win32') {
    const lower = target.toLowerCase();
    for (const e of entries) {
      if (e.toLowerCase() === lower) return e;
    }
  }
  return null;
}

// Heal projects/<base>__legacy* folders left by older migrations. These were
// created when the v0.4 migration collision-renamed a `projects/<base>`
// folder, which orphans its sessions from `claude --resume` (filters by
// cwd-encoded folder name).
//
// For each `projects/<base>__legacy*`:
//   - if a canonical sibling `projects/<base>` exists, merge .jsonl files and
//     sub-uuid dirs into it (per-file __legacy suffix on rare collisions);
//   - otherwise, rename the legacy folder to its canonical name in place.
//
// Returns { healed: [{ from, to, items, renamed }], failures: [...] }
function healProjectsLegacy({ log = () => {} } = {}) {
  const projectsDir = path.join(poolDir(), 'projects');
  if (!fs.existsSync(projectsDir)) {
    return { healed: [], failures: [] };
  }
  let entries;
  try {
    entries = fs.readdirSync(projectsDir);
  } catch (err) {
    return { healed: [], failures: [{ kind: 'readdir', message: err.message }] };
  }
  const legacyEntries = entries.filter((e) => /__legacy(?:_\d+)?$/.test(e));
  const healed = [];
  const failures = [];

  for (const ent of legacyEntries) {
    const base = stripLegacySuffix(ent);
    const from = path.join(projectsDir, ent);
    if (!fs.statSync(from).isDirectory()) continue;
    const canonical = findSibling(entries, base);
    if (canonical) {
      const to = path.join(projectsDir, canonical);
      try {
        const r = mergeFolderInto(from, to, { log });
        for (const f of r.failures) {
          failures.push({ kind: 'move', name: `${ent}/${f.name}`, message: f.message });
        }
        try {
          if (fs.readdirSync(from).length === 0) {
            fs.rmdirSync(from);
            log(`  removed empty ${ent}`);
          }
        } catch { /* best-effort */ }
        healed.push({ from: ent, to: canonical, items: r.moved, renamed: false });
        log(`  ${ent} → merged into ${canonical} (${r.moved} item${r.moved === 1 ? '' : 's'})`);
      } catch (err) {
        failures.push({ kind: 'merge', name: ent, message: err.message });
      }
    } else {
      const to = path.join(projectsDir, base);
      try {
        fs.renameSync(from, to);
        entries.push(base);
        healed.push({ from: ent, to: base, items: null, renamed: true });
        log(`  ${ent} → renamed to ${base}`);
      } catch (err) {
        failures.push({ kind: 'rename', name: ent, message: err.message });
      }
    }
  }
  return { healed, failures };
}

// Repair pass for pools already damaged by the v0.4.2-and-earlier heal
// behavior, which appended `__legacy` to UUID-keyed filenames on collision
// and made them invisible to `claude --resume`. Walks every projects/<X>/
// folder and, for each `<uuid>__legacy*.jsonl` file (and paired `<uuid>__legacy*`
// sub-uuid dir), restores a valid `<uuid>.jsonl` filename:
//   - if the canonical `<uuid>.jsonl` is free, strip the suffix;
//   - else reissue a fresh UUID v4.
//
// `memory__legacy` and `sessions-index__legacy.json` are also restored when
// the canonical name is free; otherwise left as-is (they're not parsed by
// `--resume`, so the harm is cosmetic).
//
// Returns { repaired: [{ folder, from, to }], failures: [...] }
function repairProjectFilenames({ log = () => {} } = {}) {
  const projectsDir = path.join(poolDir(), 'projects');
  if (!fs.existsSync(projectsDir)) {
    return { repaired: [], failures: [] };
  }
  const repaired = [];
  const failures = [];
  let folders;
  try {
    folders = fs.readdirSync(projectsDir);
  } catch (err) {
    return { repaired: [], failures: [{ kind: 'readdir', message: err.message }] };
  }

  // Match a UUID stem optionally followed by `__legacy(_N)?` suffix(es),
  // optionally followed by `.jsonl`. Captures the UUID stem and whether it's
  // a .jsonl file.
  const damaged = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:__legacy(?:_\d+)?)+(\.jsonl)?$/i;

  for (const folder of folders) {
    const folderPath = path.join(projectsDir, folder);
    let st;
    try { st = fs.statSync(folderPath); } catch { continue; }
    if (!st.isDirectory()) continue;
    let children;
    try { children = fs.readdirSync(folderPath); } catch { continue; }

    // Pair damaged file/dir by their exact damaged name (minus `.jsonl`).
    // Different damaged names sharing the same UUID stem are *different*
    // sessions that collided during the prior heal — each needs its own
    // unique restored name. e.g. `<u>__legacy.jsonl` and `<u>__legacy_2.jsonl`
    // both restore to *some* `<uuid>.jsonl`, but not the same one.
    const pairs = new Map(); // damaged-key-without-.jsonl -> { stem, dir?: name, file?: name }
    for (const ent of children) {
      const m = ent.match(damaged);
      if (!m) continue;
      const stem = m[1];
      const isFile = !!m[2];
      const key = isFile ? ent.slice(0, -'.jsonl'.length) : ent;
      if (!pairs.has(key)) pairs.set(key, { stem });
      const p = pairs.get(key);
      if (isFile) p.file = ent; else p.dir = ent;
    }

    const childSet = new Set(children);
    for (const [, p] of pairs) {
      const canonicalFile = `${p.stem}.jsonl`;
      const dirFree = !childSet.has(p.stem);
      const fileFree = !childSet.has(canonicalFile);
      let newStem = p.stem;
      if (!dirFree || !fileFree) {
        newStem = crypto.randomUUID();
        log(`  ${folder}/${p.stem} occupied — reissuing as ${newStem}`);
      }
      if (p.dir) {
        const from = path.join(folderPath, p.dir);
        const to = path.join(folderPath, newStem);
        try {
          fs.renameSync(from, to);
          childSet.delete(p.dir);
          childSet.add(newStem);
          repaired.push({ folder, from: p.dir, to: newStem });
          log(`  ${folder}/${p.dir} → ${newStem}`);
        } catch (err) {
          failures.push({ kind: 'rename', folder, name: p.dir, message: err.message });
        }
      }
      if (p.file) {
        const from = path.join(folderPath, p.file);
        const to = path.join(folderPath, `${newStem}.jsonl`);
        try {
          fs.renameSync(from, to);
          childSet.delete(p.file);
          childSet.add(`${newStem}.jsonl`);
          repaired.push({ folder, from: p.file, to: `${newStem}.jsonl` });
          log(`  ${folder}/${p.file} → ${newStem}.jsonl`);
        } catch (err) {
          failures.push({ kind: 'rename', folder, name: p.file, message: err.message });
        }
      }
    }

    // Restore memory/ and sessions-index.json names if the canonical is free.
    for (const [damagedName, canonical] of [
      ['memory__legacy', 'memory'],
      ['sessions-index__legacy.json', 'sessions-index.json'],
    ]) {
      if (childSet.has(damagedName) && !childSet.has(canonical)) {
        try {
          fs.renameSync(path.join(folderPath, damagedName), path.join(folderPath, canonical));
          childSet.delete(damagedName);
          childSet.add(canonical);
          repaired.push({ folder, from: damagedName, to: canonical });
          log(`  ${folder}/${damagedName} → ${canonical}`);
        } catch (err) {
          failures.push({ kind: 'rename', folder, name: damagedName, message: err.message });
        }
      }
    }
  }
  return { repaired, failures };
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
  resourceState,
  PRIVATE_FILE,
  markPrivate,
  unmarkPrivate,
  isMarkedPrivate,
  removeLink,
  shareLink,
  shareUnlink,
  resolveSubset,
  poolDir,
  ensurePoolResources,
  migrateLegacyPool,
  healProjectsLegacy,
  repairProjectFilenames,
};
