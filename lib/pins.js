'use strict';

// Folder → profile pins. The registry (~/.claude-profiles/.cchost.json) is the
// source of truth. A `.cchost` file in a folder is only a suggestion: it can
// narrow what `find` sees right away, but never picks an account until the
// person confirms it once (then it becomes a registry pin).

const fs = require('fs');
const os = require('os');
const path = require('path');

const profiles = require('./profiles');

const FILE = '.cchost';
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function pinError(message, code = 1) {
  const e = new Error(message);
  e.exitCode = code;
  e.status = code === 2 ? 400 : 409;
  return e;
}

function realpath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function keyOf(p) {
  const n = path.resolve(p).replace(/[\\/]+$/, '');
  return CASE_INSENSITIVE ? n.toLowerCase() : n;
}

function isUnder(child, parent) {
  const c = keyOf(child);
  const p = keyOf(parent);
  return c === p || c.startsWith(p + path.sep);
}

function shortPath(p) {
  const home = os.homedir();
  return isUnder(p, home) ? `~${p.slice(home.length)}` : p;
}

function readPins() {
  const pins = profiles.readRegistry().pins;
  if (!pins || typeof pins !== 'object' || Array.isArray(pins)) return {};
  const out = {};
  for (const [dir, profile] of Object.entries(pins)) {
    if (typeof profile !== 'string' || !path.isAbsolute(dir)) continue;
    try {
      profiles.validateProfileName(profile);
    } catch {
      continue;
    }
    out[dir] = profile;
  }
  return out;
}

function ignoredFiles() {
  const list = profiles.readRegistry().ignoredPinFiles;
  return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
}

function writePins(pins, ignored) {
  const data = profiles.readRegistry();
  if (Object.keys(pins).length) data.pins = pins;
  else delete data.pins;
  if (ignored && ignored.length) data.ignoredPinFiles = ignored;
  else delete data.ignoredPinFiles;
  profiles.writeRegistry(data);
}

function findPin(dir) {
  const k = keyOf(dir);
  for (const [p, profile] of Object.entries(readPins())) {
    if (keyOf(p) === k) return { dir: p, profile };
  }
  return null;
}

function readPinFile(dir) {
  const file = path.join(dir, FILE);
  let raw;
  try {
    if (!fs.statSync(file).isFile()) return null;
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (lines.length === 0) return null;
  if (lines.length > 1) return { file, profile: null, error: `${FILE} must hold exactly one profile name` };
  try {
    profiles.validateProfileName(lines[0]);
  } catch (err) {
    return { file, profile: null, error: `${FILE}: ${err.message}` };
  }
  return { file, profile: lines[0], error: null };
}

function ancestors(start) {
  const out = [];
  let cur = realpath(start);
  for (;;) {
    out.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out;
}

// The deepest pin or suggestion at or above `cwd`. A registry pin beats a
// file in the same folder. Suggestions the person declined are skipped.
function resolve(cwd = process.cwd()) {
  const ignored = new Set(ignoredFiles().map(keyOf));
  for (const dir of ancestors(cwd)) {
    const pin = findPin(dir);
    if (pin) return { kind: 'pin', dir, profile: pin.profile, confirmed: true };
    const sug = readPinFile(dir);
    if (!sug || ignored.has(keyOf(dir))) continue;
    if (!sug.profile) return { kind: 'file', dir, profile: null, confirmed: false, error: sug.error, file: sug.file };
    return { kind: 'file', dir, profile: sug.profile, confirmed: false, file: sug.file };
  }
  return null;
}

function profileExists(name) {
  return fs.existsSync(profiles.profileDir(name)) || profiles.isAlias(name);
}

function pin(profile, dir, { dryRun = false } = {}) {
  if (typeof profile !== 'string') throw pinError('profile is required', 2);
  profiles.validateProfileName(profile);
  if (!profileExists(profile)) throw pinError(`Profile "${profile}" does not exist. Create it with: cchost add ${profile}`);
  const target = realpath(dir || process.cwd());
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw pinError(`${target} is not a folder`, 2);
  if (isRootLike(target)) throw pinError(`Refusing to pin ${shortPath(target)}: pin a project folder, not your home or a filesystem root.`);
  const existing = findPin(target);
  if (existing && existing.profile === profile) return { changed: false, dir: target, profile };
  if (!dryRun) {
    const pins = readPins();
    if (existing) delete pins[existing.dir];
    pins[target] = profile;
    const ignored = ignoredFiles().filter((p) => keyOf(p) !== keyOf(target));
    writePins(pins, ignored);
  }
  return { changed: true, dir: target, profile, previous: existing ? existing.profile : null };
}

function unpin(dir, { dryRun = false } = {}) {
  const target = realpath(dir || process.cwd());
  const existing = findPin(target);
  if (!existing) return { changed: false, dir: target, profile: null };
  if (!dryRun) {
    const pins = readPins();
    delete pins[existing.dir];
    writePins(pins, ignoredFiles());
  }
  return { changed: true, dir: existing.dir, profile: existing.profile };
}

function ignoreFile(dir) {
  const target = realpath(dir);
  const ignored = ignoredFiles();
  if (!ignored.some((p) => keyOf(p) === keyOf(target))) writePins(readPins(), [...ignored, target]);
}

function removeProfilePins(profile, { dryRun = false } = {}) {
  const pins = readPins();
  const gone = Object.entries(pins).filter(([, p]) => p === profile).map(([d]) => d);
  if (gone.length && !dryRun) {
    for (const d of gone) delete pins[d];
    writePins(pins, ignoredFiles());
  }
  return gone;
}

function list() {
  return Object.entries(readPins())
    .map(([dir, profile]) => ({ dir, profile, exists: fs.existsSync(dir), profileExists: profileExists(profile) }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

function isRootLike(dir) {
  const home = realpath(os.homedir());
  const d = realpath(dir);
  return path.dirname(d) === d || isUnder(home, d);
}

// What `find` may see from `cwd`: a folder subtree and the accounts allowed
// in it. Pins and suggestions bound both; a plain project folder bounds the
// folder only. Home, its ancestors and filesystem roots have no scope.
function scope(cwd = process.cwd()) {
  const hit = resolve(cwd);
  if (hit) {
    return {
      root: hit.dir,
      profiles: hit.profile ? [hit.profile] : [],
      source: hit.kind === 'pin' ? 'pin' : 'file',
      confirmed: hit.confirmed,
    };
  }
  const dir = realpath(cwd);
  if (isRootLike(dir)) {
    throw pinError(`No search scope in ${shortPath(dir)}: run it inside a project folder, or use --global (terminal only) or --project=PATH with --global.`);
  }
  return { root: dir, profiles: null, source: 'cwd', confirmed: true };
}

module.exports = {
  FILE,
  realpath,
  keyOf,
  isUnder,
  shortPath,
  readPins,
  readPinFile,
  resolve,
  pin,
  unpin,
  ignoreFile,
  removeProfilePins,
  list,
  scope,
  isRootLike,
  pinError,
};
