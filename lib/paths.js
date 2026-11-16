'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function expandHome(p) {
  return typeof p === 'string' && (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) ? path.join(os.homedir(), p.slice(1)) : p;
}

function realpath(p) {
  p = expandHome(p);
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

// Every spelling of a folder Claude Code may have recorded: as given, the
// JS realpath (keeps Windows 8.3 short names) and the native one (long names).
function spellings(p) {
  const out = new Set([path.resolve(expandHome(p))]);
  for (const fn of [fs.realpathSync, fs.realpathSync.native]) {
    try {
      out.add(fn(expandHome(p)));
    } catch { /* missing */ }
  }
  return [...out];
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

// isUnder, also when one side was recorded through a link or a short name.
function isUnderReal(child, parent) {
  if (isUnder(child, parent)) return true;
  const parents = spellings(parent);
  return spellings(child).some((c) => parents.some((p) => isUnder(c, p)));
}

function shortPath(p) {
  if (typeof p !== 'string') return p;
  for (const home of new Set([os.homedir(), realpath(os.homedir())])) {
    if (isUnder(p, home)) return `~${p.slice(home.length)}`;
  }
  return p;
}

module.exports = { CASE_INSENSITIVE, realpath, spellings, keyOf, isUnder, isUnderReal, shortPath };
