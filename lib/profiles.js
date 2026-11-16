'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const errors = require('./errors');

const RESERVED_WIN = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

const MAX_NAME_LEN = 64;
const INVALID_CHARS_RE = /[\\/:*?"<>|\x00-\x1f]/;

function baseDir() {
  return path.join(os.homedir(), '.claude-profiles');
}

// Claude Code's default dir, which is also the pool every profile links into.
function defaultClaudeDir() {
  return path.join(os.homedir(), '.claude');
}

// The old pool; used only to detect and run migration.
function sharedDir() {
  return path.join(os.homedir(), '.claude-shared');
}

function profileDir(name) {
  return path.join(baseDir(), name);
}

function validateProfileName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw errors.usage('Profile name is required.');
  }
  if (name.length > MAX_NAME_LEN) {
    throw errors.usage(`Profile name must be ${MAX_NAME_LEN} characters or fewer.`);
  }
  if (/\s/.test(name)) {
    throw errors.usage('Profile name cannot contain whitespace.');
  }
  if (INVALID_CHARS_RE.test(name)) {
    throw errors.usage('Profile name contains disallowed characters (path separators, quotes, or control chars).');
  }
  if (name === '.' || name === '..' || name.startsWith('.')) {
    throw errors.usage('Profile name cannot start with a dot.');
  }
  if (name.startsWith('-')) {
    throw errors.usage(`Profile name cannot start with "-" (looks like a flag): ${name}`);
  }
  if (RESERVED_WIN.has(name.toUpperCase())) {
    throw errors.usage(`"${name}" is a reserved name on Windows.`);
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

function addProfile(name) {
  validateProfileName(name);
  const dir = profileDir(name);
  if (fs.existsSync(dir)) {
    throw errors.refused(`Profile "${name}" already exists at ${dir}.`);
  }
  if (isAlias(name)) {
    throw errors.refused(`"${name}" is already the name of your existing account (~/.claude).`);
  }
  ensureBaseDir();
  fs.mkdirSync(dir);
  return { dir };
}

// Single read/parse of a profile's .claude.json. Missing or malformed JSON is
// treated as absent state so one bad profile cannot break `cchost list`.
function readClaudeJson(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, '.claude.json'), 'utf8');
    if (!raw.trim()) return null;
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function emailFromClaude(data) {
  if (data && data.oauthAccount && typeof data.oauthAccount.emailAddress === 'string') {
    return data.oauthAccount.emailAddress;
  }
  return '';
}

function hasCredentials(dir) {
  try {
    return fs.existsSync(path.join(dir, '.credentials.json'));
  } catch {
    return false;
  }
}

// 'file' (.credentials.json), 'keychain' (macOS: inferred from .claude.json;
// the entry is keyed by the profile's path) or 'none'.
function credentialSourceFrom(hasFile, data, platform) {
  if (hasFile) return 'file';
  if (platform === 'darwin' && data && data.oauthAccount != null) return 'keychain';
  return 'none';
}

function credentialSource(dir, platform = process.platform) {
  return credentialSourceFrom(hasCredentials(dir), readClaudeJson(dir), platform);
}

// Everything `cchost list` needs about one profile, read from one parse.
function readProfile(dir, platform = process.platform) {
  const data = readClaudeJson(dir);
  const credentialSource = credentialSourceFrom(hasCredentials(dir), data, platform);
  return {
    loggedIn: credentialSource !== 'none',
    credentialSource,
    email: emailFromClaude(data),
  };
}

function registryFile() {
  return path.join(baseDir(), '.cchost.json');
}

function readRegistry() {
  try {
    const data = JSON.parse(fs.readFileSync(registryFile(), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function writeRegistry(data) {
  ensureBaseDir();
  const file = registryFile();
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// The name given to the account that lives in ~/.claude (plain `claude`).
function getAlias() {
  const name = readRegistry().defaultAlias;
  if (typeof name !== 'string') return null;
  try {
    validateProfileName(name);
  } catch {
    return null;
  }
  return name;
}

function isAlias(name) {
  return typeof name === 'string' && name.length > 0 && getAlias() === name;
}

function setAlias(name) {
  const data = readRegistry();
  if (name) data.defaultAlias = name;
  else delete data.defaultAlias;
  writeRegistry(data);
}

// Plain `claude` keeps its state in ~/.claude.json, outside ~/.claude.
function defaultClaudeJson() {
  return path.join(os.homedir(), '.claude.json');
}

function readJsonObject(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return null;
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function readDefaultAccount(platform = process.platform) {
  const data = readJsonObject(defaultClaudeJson());
  const credentialSource = credentialSourceFrom(hasCredentials(defaultClaudeDir()), data, platform);
  return { loggedIn: credentialSource !== 'none', credentialSource, email: emailFromClaude(data) };
}

function aliasEntry(name, platform) {
  return {
    name,
    dir: defaultClaudeDir(),
    claudeJson: defaultClaudeJson(),
    alias: true,
    ...readDefaultAccount(platform),
  };
}

// A profile folder or the named existing account. Throws when neither exists.
function resolveProfile(name, platform = process.platform) {
  validateProfileName(name);
  const dir = profileDir(name);
  if (fs.existsSync(dir)) return { name, dir, claudeJson: path.join(dir, '.claude.json'), alias: false, ...readProfile(dir, platform) };
  if (isAlias(name)) return aliasEntry(name, platform);
  throw errors.notFound(`Profile "${name}" does not exist. Create it with: cchost add ${name}`);
}

function listProfiles(platform = process.platform) {
  const base = baseDir();
  const out = [];
  let entries = [];
  if (fs.existsSync(base)) {
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch (err) {
      throw new Error(`Cannot read ${base}: ${err.message}`);
    }
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const name = ent.name;
    const dir = path.join(base, name);
    out.push({ name, dir, claudeJson: path.join(dir, '.claude.json'), alias: false, ...readProfile(dir, platform) });
  }
  const alias = getAlias();
  if (alias && !out.some((p) => p.name === alias)) out.push(aliasEntry(alias, platform));
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

module.exports = {
  baseDir,
  sharedDir,
  defaultClaudeDir,
  profileDir,
  validateProfileName,
  ensureProfileDir,
  credentialSource,
  readProfile,
  listProfiles,
  addProfile,
  getAlias,
  isAlias,
  setAlias,
  resolveProfile,
  defaultClaudeJson,
  readDefaultAccount,
  readJsonObject,
  readRegistry,
  writeRegistry,
};
