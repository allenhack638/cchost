'use strict';

// One-time repairs for layouts older cchost versions left behind: the
// ~/.claude-shared/ pool (v0.2–v0.3), `__legacy` project folders and damaged
// session filenames. Run from `cchost migrate` and `cchost doctor --fix`.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const profiles = require('./profiles');
const { SHARED_DIRS, PROJECT_SUBDIRS, isLink, removeLink, poolDir, symlinkType } = require('./share');

// Strict UUID v4-ish pattern. Used to identify session files / sub-uuid dirs
// in projects/<X>/ so we can preserve a Claude-`--resume`-readable filename
// when merging two folders that hold the same session UUID.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.jsonl)$/i;

function uuidStemOf(name) {
  if (UUID_RE.test(name)) return name;
  const m = name.match(UUID_FILE_RE);
  return m ? m[1] : null;
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

module.exports = { migrateLegacyPool, healProjectsLegacy, repairProjectFilenames };
