'use strict';

// Per-profile custom API endpoints (v0.3).
//
// A profile may carry a `.cc-env.json` file that routes Claude Code through an
// Anthropic-compatible third-party provider (Moonshot/Kimi, OpenRouter, vLLM,
// corporate proxies) instead of Anthropic's subscription OAuth. The file holds
// an API key and is treated with the same care as `.credentials.json`: it is
// never migrated, never linked, and written with user-only file permissions.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const ENV_FILE = '.cc-env.json';

// Persisted fields, in canonical serialization order.
const FIELDS = ['base_url', 'auth_token', 'model', 'opus', 'sonnet', 'haiku', 'subagent'];
const TIER_FIELDS = ['opus', 'sonnet', 'haiku', 'subagent'];

// File field -> env var(s) injected into the spawned child.
const TIER_ENV = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  subagent: 'CLAUDE_CODE_SUBAGENT_MODEL',
};

// Wizard layout: the index here is the review-screen number (1-based).
const WIZARD_FIELDS = [
  { key: 'base_url', label: 'Base URL', hidden: false, required: true },
  { key: 'auth_token', label: 'Auth token', hidden: true, required: true },
  { key: 'model', label: 'Main model', hidden: false, required: false },
  { key: 'opus', label: 'Opus tier', hidden: false, required: false, tier: true },
  { key: 'sonnet', label: 'Sonnet tier', hidden: false, required: false, tier: true },
  { key: 'haiku', label: 'Haiku tier', hidden: false, required: false, tier: true },
  { key: 'subagent', label: 'Subagent model', hidden: false, required: false, tier: true },
];

function usageError(msg) {
  const e = new Error(msg);
  e.exitCode = 2;
  return e;
}

function stateError(msg) {
  const e = new Error(msg);
  e.exitCode = 1;
  return e;
}

function envFilePath(profileDir) {
  return path.join(profileDir, ENV_FILE);
}

function hasEnvConfig(profileDir) {
  return fs.existsSync(envFilePath(profileDir));
}

// Reads and parses `.cc-env.json`. Returns the parsed object, or null if the
// file does not exist. Throws (exitCode 1, `.malformed` set) if the file is
// present but is not a JSON object.
function readEnvConfig(profileDir) {
  const p = envFilePath(profileDir);
  if (!fs.existsSync(p)) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    const e = stateError(`${ENV_FILE} is malformed JSON: ${err.message}`);
    e.malformed = true;
    throw e;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    const e = stateError(`${ENV_FILE} is malformed: expected a JSON object.`);
    e.malformed = true;
    throw e;
  }
  return data;
}

// True if the profile shows any prior OAuth (subscription) state — either a
// `.credentials.json` file, or a `.claude.json` with a non-null `oauthAccount`.
// Such a profile can never be converted to an endpoint profile (Rule 1).
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

// Locks a file down to the current user only. Mirrors how Claude Code itself
// protects `.credentials.json`.
function secureFile(filePath) {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME;
    if (!user) return;
    // Qualify the principal as DOMAIN\user. A bare username that collides with
    // the computer name (common on workgroup machines) resolves to a broken
    // principal, which would lock the file's own owner out — verified.
    const domain = process.env.USERDOMAIN;
    const principal = domain ? `${domain}\\${user}` : user;
    spawnSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${principal}:F`], {
      stdio: 'ignore',
    });
  } else {
    fs.chmodSync(filePath, 0o600);
  }
}

// Writes `.cc-env.json` atomically (temp file + rename) so a cancel or crash
// never leaves a partial file. Only defined, non-empty fields are persisted.
function writeEnvConfig(profileDir, config) {
  const out = {};
  for (const f of FIELDS) {
    if (config[f] != null && config[f] !== '') out[f] = config[f];
  }
  const target = envFilePath(profileDir);
  const tmp = path.join(profileDir, `${ENV_FILE}.tmp-${process.pid}`);
  // Write to a temp file then rename, so a crash never leaves a partial file.
  // Permissions are locked down after the rename: restricting the temp file's
  // ACL first makes the subsequent rename fail with EPERM on Windows.
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
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

// Maps a config object to the ANTHROPIC_*/CLAUDE_CODE_* env vars injected into
// the spawned child. Per-tier model vars fall back to `model`; if `model` is
// also missing, the var is omitted so Claude Code uses its built-in defaults.
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

// Endpoint summary for `cc list`. Returns the base-url host, 'subscription'
// (no endpoint config), or '(invalid config)' for a malformed file — never
// throws, so a single bad profile cannot break the whole table.
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

function validateBaseUrl(url, warn) {
  if (!/^https?:\/\/.+/.test(url)) {
    throw usageError(`Invalid base_url "${url}": must start with http:// or https://`);
  }
  let u = null;
  try {
    u = new URL(url);
  } catch {
    throw usageError(`Invalid base_url "${url}": not a parseable URL.`);
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
    throw usageError('Auth token must not be empty.');
  }
  if (token !== token.trim()) {
    throw usageError('Auth token must not have leading or trailing whitespace.');
  }
  if (/[\r\n]/.test(token)) {
    throw usageError('Auth token must not contain newlines.');
  }
}

function validateModelField(label, val) {
  if (typeof val !== 'string' || val.length === 0) {
    throw usageError(`${label} must not be empty if provided.`);
  }
}

// Validates one provided field by key. base_url warnings go through `warn`.
function validateField(key, value, warn) {
  if (key === 'base_url') validateBaseUrl(value, warn);
  else if (key === 'auth_token') validateToken(value);
  else validateModelField(key, value);
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

// Default terminal IO for the wizard. `readHidden` writes the prompt, then
// suppresses echo of typed characters so the token never appears on screen.
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
        // The prompt was written above (still unmuted); from here, suppress
        // the echo of whatever the user types.
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

// Prompts for one field, looping until the input is valid. An empty input
// keeps the current value; a required field with no current value re-prompts.
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
      // Keep the current value. base_url/auth_token must end up set.
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

// Runs the interactive wizard. Returns the collected config on submit, or
// null if the user cancelled. Never writes the file itself.
async function runWizard(name, existing, io) {
  const isEdit = !!existing;
  const config = {};
  if (existing) {
    for (const f of FIELDS) {
      if (existing[f] != null) config[f] = existing[f];
    }
  }

  io.write(`\ncchost endpoint configuration for profile '${name}'\n\n`);
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
    // Anything else: silently re-display the review.
  }
}

// ---------------------------------------------------------------------------
// Command orchestration (called from cli.js)
// ---------------------------------------------------------------------------

// `cc env <profile>` and `cc env <profile> --flags`.
// `provided` is a partial config of fields supplied via flags.
// `opts.io` injects wizard IO (tests); `opts.isTTY` overrides TTY detection.
async function runConfigure(name, profileDir, provided, opts = {}) {
  if (!fs.existsSync(profileDir)) {
    throw stateError(`Profile "${name}" does not exist. Create it with: cc add ${name}`);
  }
  if (hasOAuthState(profileDir)) {
    throw stateError(
      `Profile '${name}' has OAuth credentials.\n` +
        'Endpoint profiles must be created on a fresh profile.\n' +
        'Run:\n' +
        '  cc add <new-name>\n' +
        '  cc env <new-name>',
    );
  }

  const existing = readEnvConfig(profileDir); // throws on malformed file
  const editing = existing != null;
  const nonInteractive = Object.keys(provided).length > 0;

  if (nonInteractive) {
    const warn = (m) => process.stderr.write(m + '\n');
    // Creating: base_url and auth_token are mandatory.
    if (!editing) {
      const merged = { ...provided };
      if (!merged.base_url || !merged.auth_token) {
        throw usageError(
          'Creating an endpoint profile requires both --base-url and --token.',
        );
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
    return 0;
  }

  // Interactive wizard.
  let io = opts.io;
  if (!io) {
    const isTTY = opts.isTTY != null ? opts.isTTY : process.stdin.isTTY;
    if (!isTTY) {
      throw usageError('cc env requires either flags or an interactive terminal.');
    }
    io = defaultWizardIo();
  }

  const result = await runWizard(name, existing, io);
  if (result == null) {
    console.log('Cancelled. No changes written.');
    return 0;
  }
  writeEnvConfig(profileDir, result);
  console.log(
    `${editing ? 'Updated' : 'Created'} endpoint config for profile '${name}' → ${hostOf(result.base_url)}.`,
  );
  return 0;
}

// `cc env <profile> show [--reveal]`.
function runShow(name, profileDir, { reveal = false, write } = {}) {
  const w = write || ((s) => process.stdout.write(s + '\n'));
  if (!fs.existsSync(profileDir)) {
    throw stateError(`Profile "${name}" does not exist.`);
  }
  const config = readEnvConfig(profileDir); // throws on malformed file
  if (config == null) {
    throw stateError(`Profile '${name}' is not an endpoint profile (no ${ENV_FILE}).`);
  }

  w(`Endpoint configuration for profile '${name}':`);
  w(`  Base URL:   ${config.base_url || '-'}`);
  if (reveal) {
    w(`  Token:      ${config.auth_token || '-'}`);
  } else {
    w(`  Token:      ${config.auth_token ? maskToken(config.auth_token) : '-'}`);
  }
  w(`  Main model: ${config.model || '-'}`);
  w(`  Opus:       ${config.opus || config.model || '-'}`);
  w(`  Sonnet:     ${config.sonnet || config.model || '-'}`);
  w(`  Haiku:      ${config.haiku || config.model || '-'}`);
  w(`  Subagent:   ${config.subagent || config.model || '-'}`);
  if (reveal) {
    w('');
    w('WARNING: the full API key is printed above. Do not paste this output');
    w('into chats, issues, screenshots, or logs.');
  }
  return 0;
}

module.exports = {
  ENV_FILE,
  FIELDS,
  TIER_FIELDS,
  envFilePath,
  hasEnvConfig,
  readEnvConfig,
  hasOAuthState,
  secureFile,
  writeEnvConfig,
  buildEnvVars,
  hostOf,
  endpointSummary,
  maskToken,
  validateBaseUrl,
  validateToken,
  validateField,
  runWizard,
  runConfigure,
  runShow,
  defaultWizardIo,
};
