'use strict';

// Per-profile custom API endpoints (`.cc-env.json`), set up by `cchost add --custom`.
// The file holds an API key: it is never migrated or linked, and is written user-only.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const errors = require('./errors');

const ENV_FILE = '.cc-env.json';

// Persisted fields, in canonical serialization order.
const FIELDS = ['base_url', 'auth_token', 'model', 'opus', 'sonnet', 'haiku', 'subagent'];
const TIER_FIELDS = ['opus', 'sonnet', 'haiku', 'subagent'];
// Must be strings if present; other non-string fields are treated as absent.
const STRICT_STRING_FIELDS = ['base_url', 'auth_token'];

// If inherited by a subscription profile, these silently override its OAuth login (and billing).
const AUTH_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

function authEnvConflicts(env = process.env) {
  return AUTH_ENV_VARS.filter((key) => env[key]);
}

// Endpoint profiles must not inherit the parent's auth or base URL.
const ENDPOINT_ENV_VARS = [...AUTH_ENV_VARS, 'ANTHROPIC_BASE_URL'];

function endpointEnvToStrip(profileEnv, env = process.env) {
  return ENDPOINT_ENV_VARS.filter((key) => env[key] && !profileEnv[key]);
}

// File field -> env var(s) injected into the spawned child.
const TIER_ENV = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  subagent: 'CLAUDE_CODE_SUBAGENT_MODEL',
};

// Order sets the review-screen number (1-based).
const WIZARD_FIELDS = [
  { key: 'base_url', label: 'Base URL', hidden: false, required: true },
  { key: 'auth_token', label: 'Auth token', hidden: true, required: true },
  { key: 'model', label: 'Main model', hidden: false, required: false },
  { key: 'opus', label: 'Opus tier', hidden: false, required: false, tier: true },
  { key: 'sonnet', label: 'Sonnet tier', hidden: false, required: false, tier: true },
  { key: 'haiku', label: 'Haiku tier', hidden: false, required: false, tier: true },
  { key: 'subagent', label: 'Subagent model', hidden: false, required: false, tier: true },
];

function envFilePath(profileDir) {
  return path.join(profileDir, ENV_FILE);
}

function hasEnvConfig(profileDir) {
  return fs.existsSync(envFilePath(profileDir));
}

// Returns the parsed object, or null if the file is missing.
// Throws with `.malformed` set if it is not a JSON object.
function readEnvConfig(profileDir) {
  const p = envFilePath(profileDir);
  if (!fs.existsSync(p)) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    const e = errors.refused(`${ENV_FILE} is malformed JSON: ${err.message}`);
    e.malformed = true;
    throw e;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    const e = errors.refused(`${ENV_FILE} is malformed: expected a JSON object.`);
    e.malformed = true;
    throw e;
  }
  for (const key of STRICT_STRING_FIELDS) {
    if (data[key] == null) continue;
    if (typeof data[key] !== 'string') {
      const e = errors.refused(`${ENV_FILE} is malformed: field "${key}" must be a string.`);
      e.malformed = true;
      throw e;
    }
  }
  // A hand-edited bad optional field must not break the profile.
  for (const key of FIELDS) {
    if (STRICT_STRING_FIELDS.includes(key)) continue;
    if (data[key] != null && typeof data[key] !== 'string') delete data[key];
  }
  return data;
}

// OAuth state means `.credentials.json` or an `oauthAccount` in `.claude.json`.
// Such a profile can never become an endpoint profile.
function hasOAuthState(profileDir) {
  if (fs.existsSync(path.join(profileDir, '.credentials.json'))) return true;
  try {
    const raw = fs.readFileSync(path.join(profileDir, '.claude.json'), 'utf8');
    if (raw.trim()) {
      const data = JSON.parse(raw);
      if (data && data.oauthAccount != null) return true;
    }
  } catch {
    // Missing or unreadable .claude.json is not OAuth state.
  }
  return false;
}

// User-only access, as Claude Code does for `.credentials.json`.
function secureFile(filePath) {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME;
    if (!user) return;
    // Use DOMAIN\user: a bare name that matches the computer name resolves to a
    // broken principal and locks the owner out.
    const domain = process.env.USERDOMAIN;
    const principal = domain ? `${domain}\\${user}` : user;
    spawnSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${principal}:F`], {
      stdio: 'ignore',
    });
  } else {
    fs.chmodSync(filePath, 0o600);
  }
}

// Atomic write (temp + rename). Only non-empty fields are persisted.
function writeEnvConfig(profileDir, config) {
  const out = {};
  for (const f of FIELDS) {
    if (config[f] != null && config[f] !== '') out[f] = config[f];
  }
  const target = envFilePath(profileDir);
  const tmp = path.join(profileDir, `${ENV_FILE}.tmp-${process.pid}`);
  // Fresh 0600 temp (O_EXCL) so the token never lands in a looser file.
  // ACLs are set after the rename: setting them first makes rename fail with EPERM on Windows.
  fs.rmSync(tmp, { force: true });
  try {
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
  } catch (err) {
    if (err.code !== 'EEXIST') {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // best effort cleanup
      }
    }
    throw err;
  }
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best effort cleanup
    }
    throw err;
  }
  secureFile(target);
  return out;
}

// Tier vars fall back to `model`; with neither set they are omitted so Claude
// Code uses its own defaults.
function buildEnvVars(config) {
  const env = {};
  if (config.base_url) env.ANTHROPIC_BASE_URL = config.base_url;
  if (config.auth_token) {
    // Different providers read different vars — set both.
    env.ANTHROPIC_AUTH_TOKEN = config.auth_token;
    env.ANTHROPIC_API_KEY = config.auth_token;
  }
  if (config.model) env.ANTHROPIC_MODEL = config.model;
  for (const tier of TIER_FIELDS) {
    const val = config[tier] || config.model;
    if (val) env[TIER_ENV[tier]] = val;
  }
  return env;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// Host, 'subscription' or '(invalid config)'. Never throws, so one bad profile
// cannot break `cchost list`.
function endpointSummary(profileDir) {
  let config;
  try {
    config = readEnvConfig(profileDir);
  } catch {
    return '(invalid config)';
  }
  if (!config) return 'subscription';
  if (!config.base_url) return '(invalid config)';
  return hostOf(config.base_url);
}

function maskToken(token) {
  const n = token.length;
  if (n <= 10) return `${'*'.repeat(n)} (${n} chars)`;
  return `${token.slice(0, 6)}...${token.slice(-4)} (${n} chars)`;
}

// Keeps the first char and TLD at the original width: allen@cyber.co.in → a*************.in
function maskEmail(email) {
  if (!email || typeof email !== 'string') return email;
  if (email.length < 2) return '***';
  const lastDot = email.lastIndexOf('.');
  const first = email[0];
  if (lastDot < 1 || lastDot === email.length - 1) {
    return first + '*'.repeat(email.length - 1);
  }
  const tld = email.slice(lastDot); // includes the leading dot
  const middleLen = lastDot - 1;
  return first + '*'.repeat(middleLen) + tld;
}

function validateBaseUrl(url, warn) {
  if (!/^https?:\/\/.+/.test(url)) {
    throw errors.usage(`Invalid base_url "${url}": must start with http:// or https://`);
  }
  let u = null;
  try {
    u = new URL(url);
  } catch {
    throw errors.usage(`Invalid base_url "${url}": not a parseable URL.`);
  }
  if (u.pathname.replace(/\/+$/, '').endsWith('/v1')) {
    warn('cchost: base_url ending in /v1 is unusual; most Anthropic-compatible endpoints end in / or /anthropic');
  }
  if (u.protocol === 'http:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
    warn('cchost: base_url uses http:// to a non-local host; the auth token will be sent unencrypted');
  }
}

function validateToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw errors.usage('Auth token must not be empty.');
  }
  if (token !== token.trim()) {
    throw errors.usage('Auth token must not have leading or trailing whitespace.');
  }
  if (/[\r\n]/.test(token)) {
    throw errors.usage('Auth token must not contain newlines.');
  }
}

function validateModelField(label, val) {
  if (typeof val !== 'string' || val.length === 0) {
    throw errors.usage(`${label} must not be empty if provided.`);
  }
}

// base_url warnings go through `warn`.
function validateField(key, value, warn) {
  if (key === 'base_url') validateBaseUrl(value, warn);
  else if (key === 'auth_token') validateToken(value);
  else validateModelField(key, value);
}

// `readHidden` suppresses echo so the token never appears on screen.
function defaultWizardIo() {
  return {
    write: (s) => process.stdout.write(s),
    readLine: (q) =>
      new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(q, (a) => {
          rl.close();
          resolve(a);
        });
      }),
    readHidden: (q) =>
      new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        let muted = false;
        rl._writeToOutput = (s) => {
          if (!muted) rl.output.write(s);
        };
        rl.question(q, (a) => {
          rl.close();
          process.stdout.write('\n');
          resolve(a);
        });
        // Mute only after the prompt has been written.
        muted = true;
      }),
  };
}

function reviewValue(field, config) {
  if (field.key === 'auth_token') {
    return config.auth_token ? maskToken(config.auth_token) : '-';
  }
  if (field.tier) {
    return config[field.key] || config.model || '-';
  }
  return config[field.key] || '-';
}

function renderReview(config, io) {
  io.write('\nReview:\n');
  WIZARD_FIELDS.forEach((field, i) => {
    const label = `${field.label}:`.padEnd(16);
    io.write(`  ${i + 1}. ${label}${reviewValue(field, config)}\n`);
  });
}

// Loops until valid. Empty input keeps the current value; an unset required field re-prompts.
async function promptOne(field, config, io, isEdit) {
  for (;;) {
    let placeholder = '';
    let promptText;
    if (field.hidden) {
      promptText = `${field.label}${isEdit && config[field.key] ? ' [keep current]' : ''}: `;
    } else {
      if (field.tier) placeholder = config[field.key] || config.model || '';
      else placeholder = config[field.key] || '';
      promptText = `${field.label} [${placeholder}]: `;
    }

    const raw = field.hidden
      ? await io.readHidden(promptText)
      : await io.readLine(promptText);
    const value = raw.trim();

    if (value === '') {
      if (field.required && !config[field.key]) {
        io.write(`${field.label} is required.\n`);
        continue;
      }
      return;
    }

    try {
      validateField(field.key, value, (m) => io.write(m + '\n'));
    } catch (err) {
      io.write(err.message + '\n');
      continue;
    }
    config[field.key] = value;
    return;
  }
}

// Returns the config on submit, or null if cancelled. Never writes the file.
async function runWizard(name, existing, io) {
  const isEdit = !!existing;
  const config = {};
  if (existing) {
    for (const f of FIELDS) {
      if (existing[f] != null) config[f] = existing[f];
    }
  }

  io.write(`\ncchost endpoint configuration for profile '${name}'${isEdit ? ' (editing)' : ''}\n\n`);
  for (const field of WIZARD_FIELDS) {
    await promptOne(field, config, io, isEdit);
  }

  for (;;) {
    renderReview(config, io);
    const ans = (await io.readLine('\n[s]ubmit, [e]dit N, [c]ancel: ')).trim().toLowerCase();
    if (ans === 's') return config;
    if (ans === 'c') return null;
    const m = /^e\s+([1-7])$/.exec(ans);
    if (m) {
      await promptOne(WIZARD_FIELDS[Number(m[1]) - 1], config, io, isEdit);
    }
  }
}

// `provided` holds flag values. Returns { code, written }: written is false only
// when the wizard was cancelled, so the caller can clean up a new profile.
async function runConfigure(name, profileDir, provided, opts = {}) {
  if (!fs.existsSync(profileDir)) {
    throw errors.refused(`Profile "${name}" does not exist. Create it with: cchost add ${name}`);
  }
  if (hasOAuthState(profileDir)) {
    throw errors.refused(`Profile '${name}' has OAuth credentials and cannot be converted to a custom endpoint.\n` +
        'A profile is born subscription or endpoint and stays that way.\n' +
        'Create a fresh endpoint profile instead:\n' +
        '  cchost add <new-name> --custom');
  }

  const existing = readEnvConfig(profileDir); // throws on malformed file
  const editing = existing != null;
  const nonInteractive = Object.keys(provided).length > 0;

  if (nonInteractive) {
    const warn = (m) => process.stderr.write(m + '\n');
    if (!editing) {
      const merged = { ...provided };
      if (!merged.base_url) {
        throw errors.usage('Creating an endpoint profile requires --base-url.');
      }
    }
    for (const [key, value] of Object.entries(provided)) {
      validateField(key, value, warn);
    }
    const merged = { ...(existing || {}), ...provided };
    writeEnvConfig(profileDir, merged);
    console.log(
      `${editing ? 'Updated' : 'Created'} endpoint config for profile '${name}' → ${hostOf(merged.base_url)}.`,
    );
    if (!merged.auth_token) console.log(`Token not set yet. Set it (input hidden): cchost token ${name}`);
    return { code: 0, written: true };
  }

  let io = opts.io;
  if (!io) {
    const isTTY = opts.isTTY != null ? opts.isTTY : process.stdin.isTTY;
    if (!isTTY) {
      throw errors.usage('cchost add --custom requires either endpoint flags or an interactive terminal.');
    }
    io = defaultWizardIo();
  }

  const result = await runWizard(name, existing, io);
  if (result == null) {
    return { code: 0, written: false };
  }
  writeEnvConfig(profileDir, result);
  console.log(
    `${editing ? 'Updated' : 'Created'} endpoint config for profile '${name}' → ${hostOf(result.base_url)}.`,
  );
  return { code: 0, written: true };
}

// Asks for a new endpoint in the terminal; null when the person cancels.
async function askEndpoint(name, io) {
  if (!io) {
    if (!process.stdin.isTTY) throw errors.usage('cchost add --custom requires either endpoint flags or an interactive terminal.');
    io = defaultWizardIo();
  }
  return runWizard(name, null, io);
}

module.exports = {
  FIELDS,
  authEnvConflicts,
  endpointEnvToStrip,
  hasEnvConfig,
  readEnvConfig,
  hasOAuthState,
  writeEnvConfig,
  buildEnvVars,
  hostOf,
  endpointSummary,
  maskToken,
  maskEmail,
  validateBaseUrl,
  validateToken,
  validateField,
  runConfigure,
  askEndpoint,
  defaultWizardIo,
};
