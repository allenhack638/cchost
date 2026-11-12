'use strict';

// Every JSON edit cchost makes goes through a transaction: the first touch of
// a file copies it into ~/.cchost-backups/<id>/, then the edit is written
// atomically with mode 0600. `cchost restore <id>` puts the copies back.

const fs = require('fs');
const os = require('os');
const path = require('path');

const KEEP = 30;
const ID_RE = /^\d{8}-\d{6}-\d{3}-[a-z0-9-]+$/;

function root() {
  return path.join(os.homedir(), '.cchost-backups');
}

function stamp(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${p(now.getMilliseconds(), 3)}`;
}

function stateError(msg, code) {
  const e = new Error(msg);
  e.exitCode = 1;
  if (code) e.code = code;
  return e;
}

// Places cchost is allowed to write JSON into.
function allowedRoots() {
  const home = os.homedir();
  return [path.join(home, '.claude'), path.join(home, '.claude-profiles'), path.join(home, '.claude.json')];
}

function inside(p, rootPath) {
  const rel = path.relative(rootPath, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realTarget(file) {
  let real = file;
  try {
    real = fs.realpathSync(file);
  } catch {
    try {
      real = path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
    } catch { /* parent missing: keep as is */ }
  }
  const roots = allowedRoots().map((r) => {
    try { return fs.realpathSync(r); } catch { return r; }
  });
  if (!roots.some((r) => inside(real, r))) {
    throw stateError(`Refusing to write ${file}: it resolves outside ~/.claude, ~/.claude-profiles and ~/.claude.json.`, 'outside-root');
  }
  return real;
}

function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  if (!raw.trim()) return {};
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw stateError(`${file} is not valid JSON; not changing it.`, 'invalid-json');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw stateError(`${file} does not hold a JSON object; not changing it.`, 'invalid-json');
  }
  return data;
}

function writeAtomic(file, text) {
  const tmp = `${file}.cchost-tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
    throw err;
  }
}

function prune() {
  const ids = listIds();
  for (const id of ids.slice(KEEP)) {
    fs.rmSync(path.join(root(), id), { recursive: true, force: true });
  }
}

function listIds() {
  try {
    return fs.readdirSync(root()).filter((n) => ID_RE.test(n)).sort().reverse();
  } catch {
    return [];
  }
}

function begin(op) {
  const slug = String(op).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'change';
  const id = `${stamp()}-${slug}`;
  const dir = path.join(root(), id);
  const manifest = { id, op, createdAt: new Date().toISOString(), files: [] };
  const seen = new Map();

  function saveManifest() {
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  }

  function touch(file) {
    const real = realTarget(file);
    if (seen.has(real)) return real;
    if (!manifest.files.length) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const entry = { path: real, stored: null, existed: fs.existsSync(real) };
    if (entry.existed) {
      entry.stored = `${manifest.files.length}-${path.basename(real)}`;
      fs.copyFileSync(real, path.join(dir, entry.stored));
      fs.chmodSync(path.join(dir, entry.stored), 0o600);
    }
    manifest.files.push(entry);
    seen.set(real, entry);
    saveManifest();
    return real;
  }

  return {
    id,
    get used() { return manifest.files.length > 0; },
    touch,
    writeJson(file, mutate) {
      const real = touch(file);
      const data = readJson(real);
      const next = mutate(data) || data;
      writeAtomic(real, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    },
    remove(file) {
      const real = touch(file);
      fs.rmSync(real, { force: true });
    },
    done() {
      if (manifest.files.length) prune();
      return manifest.files.length ? id : null;
    },
  };
}

function readManifest(id) {
  if (!ID_RE.test(id)) throw stateError(`Unknown backup "${id}". See: cchost backups`);
  try {
    return JSON.parse(fs.readFileSync(path.join(root(), id, 'manifest.json'), 'utf8'));
  } catch {
    throw stateError(`Unknown backup "${id}". See: cchost backups`);
  }
}

function list() {
  const out = [];
  for (const id of listIds()) {
    try {
      const m = readManifest(id);
      out.push({ id, op: m.op, createdAt: m.createdAt, files: m.files.map((f) => f.path) });
    } catch { /* skip broken */ }
  }
  return out;
}

// Puts every file of a backup back as it was. The current state is backed up
// first, so a restore can itself be undone.
function restore(id, { dryRun = false } = {}) {
  const m = readManifest(id);
  const plan = m.files.map((f) => ({ path: f.path, action: f.existed ? 'restore' : 'delete' }));
  if (dryRun) return { plan, backup: null };
  const tx = begin(`restore-${id.slice(0, 15)}`);
  for (const f of m.files) {
    const real = realTarget(f.path);
    if (f.existed) {
      tx.touch(real);
      const text = fs.readFileSync(path.join(root(), id, f.stored), 'utf8');
      writeAtomic(real, text);
    } else if (fs.existsSync(real)) {
      tx.remove(real);
    }
  }
  return { plan, backup: tx.done() };
}

// ~/... for display, also when the stored path is the home's real path.
function shortPath(p) {
  const homes = [os.homedir()];
  try { homes.push(fs.realpathSync(os.homedir())); } catch { /* keep one */ }
  for (const h of homes) {
    if (p === h) return '~';
    if (p.startsWith(h + path.sep)) return `~${p.slice(h.length)}`;
  }
  return p;
}

module.exports = { begin, list, restore, readJson, root, stamp, shortPath, KEEP };
