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

function baseDir() {
  return path.join(os.homedir(), '.claude-profiles');
}

// ~/.claude/ — Claude Code's own default config dir. Since v0.4 this is also
// the shared artifact pool: every profile's projects/skills/agents/commands
// symlink back here, so one set of tools is visible to every profile.
function defaultClaudeDir() {
  return path.join(os.homedir(), '.claude');
}

// ~/.claude-shared/ — legacy pool from v0.2/0.3. Kept for migration detection
// only; new symlinks go to defaultClaudeDir(). Removed once migration runs.
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

function addProfile(name) {
  validateProfileName(name);
  const dir = profileDir(name);
  if (fs.existsSync(dir)) {
    const e = new Error(`Profile "${name}" already exists at ${dir}.`);
    e.exitCode = 1;
    throw e;
  }
  if (isAlias(name)) {
    const e = new Error(`"${name}" is already the name of your existing account (~/.claude).`);
    e.exitCode = 1;
    throw e;
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

function readEmail(dir) {
  return emailFromClaude(readClaudeJson(dir));
}

function hasCredentials(dir) {
  try {
    return fs.existsSync(path.join(dir, '.credentials.json'));
  } catch {
    return false;
  }
}

// Where this profile's Claude Code credentials live:
//   'file'     — .credentials.json in the profile (Windows/Linux)
//   'keychain' — inferred from .claude.json on macOS; the token is in a
//                Keychain entry namespaced by the profile's exact path
//   'none'     — no sign of a login
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
  const e = new Error(`Profile "${name}" does not exist. Create it with: cchost add ${name}`);
  e.exitCode = 1;
  e.status = 404;
  throw e;
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
  ensureBaseDir,
  ensureProfileDir,
  readEmail,
  hasCredentials,
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
