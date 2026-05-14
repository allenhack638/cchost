'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const RESERVED_WIN = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

const MAX_NAME_LEN = 64;
const INVALID_CHARS_RE = /[\\/:*?"<>|\x00-\x1f]/;

const ALIAS_FILE = '.cc-alias.json';
const ALLOWED_ALIAS_KEYS = ['email', 'org', 'name'];
const OAUTH_FIELD_MAP = {
  email: 'emailAddress',
  org: 'organizationName',
  name: 'displayName',
};

function baseDir() {
  return path.join(os.homedir(), '.claude-profiles');
}

function sharedDir() {
  return path.join(os.homedir(), '.claude-shared');
}

function profileDir(name) {
  return path.join(baseDir(), name);
}

function usageError(msg) {
  const e = new Error(msg);
  e.exitCode = 2;
  return e;
}

function validateProfileName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw usageError('Profile name is required.');
  }
  if (name.length > MAX_NAME_LEN) {
    throw usageError(`Profile name must be ${MAX_NAME_LEN} characters or fewer.`);
  }
  if (/\s/.test(name)) {
    throw usageError('Profile name cannot contain whitespace.');
  }
  if (INVALID_CHARS_RE.test(name)) {
    throw usageError('Profile name contains disallowed characters (path separators, quotes, or control chars).');
  }
  if (name === '.' || name === '..' || name.startsWith('.')) {
    throw usageError('Profile name cannot start with a dot.');
  }
  if (name.startsWith('-')) {
    throw usageError(`Profile name cannot start with "-" (looks like a flag): ${name}`);
  }
  if (RESERVED_WIN.has(name.toUpperCase())) {
    throw usageError(`"${name}" is a reserved name on Windows.`);
  }
  return name;
}

function ensureBaseDir() {
  try {
    fs.mkdirSync(baseDir(), { recursive: true });
  } catch (err) {
    throw new Error(`Cannot create profile base directory ${baseDir()}: ${err.message}`);
  }
}

function ensureProfileDir(name) {
  validateProfileName(name);
  ensureBaseDir();
  const dir = profileDir(name);
  let created = false;
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      throw new Error(`Cannot create profile directory ${dir}: ${err.message}`);
    }
    created = true;
  }
  return { dir, created };
}

function aliasPath(dir) {
  return path.join(dir, ALIAS_FILE);
}

function readAlias(dir) {
  try {
    const raw = fs.readFileSync(aliasPath(dir), 'utf8');
    if (!raw.trim()) return {};
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return {};
    const out = {};
    for (const k of ALLOWED_ALIAS_KEYS) {
      if (typeof data[k] === 'string' && data[k].length > 0) out[k] = data[k];
    }
    return out;
  } catch {
    return {};
  }
}

function writeAlias(dir, data) {
  fs.writeFileSync(aliasPath(dir), JSON.stringify(data, null, 2));
}

function addProfile(name, aliasFlags) {
  validateProfileName(name);
  const dir = profileDir(name);
  if (fs.existsSync(dir)) {
    const e = new Error(`Profile "${name}" already exists at ${dir}.`);
    e.exitCode = 1;
    throw e;
  }
  const alias = {};
  for (const [k, v] of Object.entries(aliasFlags || {})) {
    if (!ALLOWED_ALIAS_KEYS.includes(k)) {
      throw usageError(`Unknown flag: --${k}. Allowed: --email, --org, --name.`);
    }
    if (typeof v !== 'string' || v.length === 0) {
      throw usageError(`Flag --${k} requires a non-empty value.`);
    }
    alias[k] = v;
  }
  ensureBaseDir();
  fs.mkdirSync(dir);
  if (Object.keys(alias).length > 0) {
    writeAlias(dir, alias);
  }
  return { dir, alias };
}

function applyAlias(dir) {
  const alias = readAlias(dir);
  if (Object.keys(alias).length === 0) return false;
  const claudeJsonPath = path.join(dir, '.claude.json');
  if (!fs.existsSync(claudeJsonPath)) return false;
  let data;
  try {
    const raw = fs.readFileSync(claudeJsonPath, 'utf8');
    if (!raw.trim()) return false;
    data = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!data || typeof data !== 'object') return false;
  if (!data.oauthAccount || typeof data.oauthAccount !== 'object') return false;
  let mutated = false;
  for (const [k, v] of Object.entries(alias)) {
    const oauthKey = OAUTH_FIELD_MAP[k];
    if (!oauthKey) continue;
    if (data.oauthAccount[oauthKey] !== v) {
      data.oauthAccount[oauthKey] = v;
      mutated = true;
    }
  }
  if (mutated) {
    try {
      fs.writeFileSync(claudeJsonPath, JSON.stringify(data, null, 2));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function readEmail(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, '.claude.json'), 'utf8');
    if (!raw.trim()) return '';
    const data = JSON.parse(raw);
    if (data && data.oauthAccount && typeof data.oauthAccount.emailAddress === 'string') {
      return data.oauthAccount.emailAddress;
    }
    return '';
  } catch {
    return '';
  }
}

function hasCredentials(dir) {
  try {
    return fs.existsSync(path.join(dir, '.credentials.json'));
  } catch {
    return false;
  }
}

function listProfiles() {
  const base = baseDir();
  if (!fs.existsSync(base)) return [];
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Cannot read ${base}: ${err.message}`);
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const name = ent.name;
    const dir = path.join(base, name);
    out.push({
      name,
      dir,
      loggedIn: hasCredentials(dir),
      email: readEmail(dir),
      alias: readAlias(dir),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

module.exports = {
  baseDir,
  sharedDir,
  profileDir,
  validateProfileName,
  ensureBaseDir,
  ensureProfileDir,
  readEmail,
  hasCredentials,
  listProfiles,
  addProfile,
  readAlias,
  writeAlias,
  applyAlias,
  ALLOWED_ALIAS_KEYS,
  OAUTH_FIELD_MAP,
};
