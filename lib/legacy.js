'use strict';

// One-time repairs for layouts older cchost versions left behind: the
// ~/.claude-shared/ pool, `__legacy` project folders and damaged session
// filenames. Run from `cchost migrate` and `cchost doctor --fix`.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const profiles = require('./profiles');
const { SHARED_DIRS, PROJECT_SUBDIRS, isLink, removeLink, poolDir, symlinkType } = require('./share');

// `claude --resume` only reads sessions named <uuid>.jsonl (plus a <uuid>/ dir).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.jsonl)$/i;

function uuidStemOf(name) {
  if (UUID_RE.test(name)) return name;
  const m = name.match(UUID_FILE_RE);
  return m ? m[1] : null;
}

// Merge src/ into dst/: a projects/ folder name encodes the cwd that `--resume`
// filters by, so it can't be renamed. Colliding sessions get a fresh UUID
// (file and dir together); other names get a harmless `__legacy` suffix.
function mergeFolderInto(src, dst, { log = () => {} } = {}) {
  fs.mkdirSync(dst, { recursive: true });
  let moved = 0;
  const failures = [];
  const entries = fs.readdirSync(src);

  // Group <uuid>.jsonl with its <uuid>/ dir so both get the same new UUID.
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

// Move ~/.claude-shared/ into ~/.claude/; idempotent. Colliding entries get a
// `__legacy` suffix, except projects/ folders, which are merged (see mergeFolderInto).
function migrateLegacyPool({ log = () => {} } = {}) {
  const legacy = profiles.sharedDir();
  if (!fs.existsSync(legacy)) {
    return { migrated: false, moves: [], relinked: [], failures: [] };
  }
  const pool = poolDir();
  // If ~/.claude/<sub> is a junction into ~/.claude-shared/, migrating would
  // move files onto themselves and suffix every entry. Bail out.
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

  // The legacy pool only held dirs, never config files.
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

// Peel every __legacy / __legacy_N suffix; repeated migrations can stack them.
function stripLegacySuffix(name) {
  let s = name;
  while (true) {
    const m = s.match(/^(.+?)__legacy(?:_\d+)?$/);
    if (!m) return s;
    s = m[1];
  }
}

// Exact match, else case-insensitive on Windows (NTFS ignores case).
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

// projects/<base>__legacy* folders are invisible to `--resume`: merge each into
// projects/<base> if it exists, else rename it back.
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

// Rename `<uuid>__legacy*` sessions, which `--resume` can't read, back to a valid
// <uuid>.jsonl (fresh UUID if taken). memory/ and sessions-index.json only if free.
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

  // <uuid> + one or more __legacy suffixes + optional .jsonl.
  const damaged = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:__legacy(?:_\d+)?)+(\.jsonl)?$/i;

  for (const folder of folders) {
    const folderPath = path.join(projectsDir, folder);
    let st;
    try { st = fs.statSync(folderPath); } catch { continue; }
    if (!st.isDirectory()) continue;
    let children;
    try { children = fs.readdirSync(folderPath); } catch { continue; }

    // Pair by full damaged name: `<u>__legacy` and `<u>__legacy_2` are
    // different sessions and need distinct UUIDs.
    const pairs = new Map(); // key -> { stem, dir?, file? }
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
