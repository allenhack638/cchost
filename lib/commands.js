'use strict';

// Commands added in 0.7: status, mcp, backups, restore, agent, skill, token.
// They, and the --json forms of the older commands, run through
// lib/actions.js, the same code the web view uses.

const fs = require('fs');
const os = require('os');

const actions = require('./actions');
const profiles = require('./profiles');
const share = require('./share');
const envLib = require('./env');
const mcpLib = require('./mcp');
const backupLib = require('./backup');
const agentLib = require('./agent');
const updateLib = require('./update');
const color = require('./color');

function usageError(msg) {
  const e = new Error(msg);
  e.exitCode = 2;
  return e;
}

// --flag and --key=value parsing with a fixed vocabulary.
function parseArgs(args, { flags = [], values = [] } = {}) {
  const set = new Set();
  const vals = {};
  const positional = [];
  for (const a of args) {
    if (!a.startsWith('-')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    if (values.includes(name)) {
      if (eq === -1 || eq === a.length - 1) throw usageError(`${name} needs a value: ${name}=VALUE`);
      vals[name] = a.slice(eq + 1);
    } else if (flags.includes(name) && eq === -1) {
      set.add(name);
    } else {
      throw usageError(`Unknown flag: ${name}`);
    }
  }
  return { flags: set, values: vals, positional };
}

const SYMBOL = { change: '+', same: '·', warn: '!', error: '✗', info: 'i' };

function paint(kind, text) {
  if (kind === 'warn') return color.stdout.yellow(text);
  if (kind === 'error') return color.stdout.red(text);
  if (kind === 'change') return color.stdout.green(text);
  return text;
}

function printLines(lines) {
  const width = Math.min(16, Math.max(0, ...lines.map((l) => (l.label || '').length)));
  for (const l of lines) {
    const label = (l.label || '').padEnd(width);
    process.stdout.write(`  ${paint(l.kind, SYMBOL[l.kind] || ' ')} ${label}  ${l.text}\n`);
  }
}

function linesOk(lines) {
  return !lines.some((l) => l.kind === 'error' || (l.kind === 'warn' && l.code));
}

// Runs one registry action and prints it as text or JSON. Exit: 0 ok,
// 1 something was refused or failed, 2 bad input.
async function runAction(name, params, { dryRun = false, json = false } = {}) {
  let lines;
  try {
    lines = await actions.ACTIONS[name](params, { dryRun });
  } catch (err) {
    const code = err.exitCode || (err.status === 400 ? 2 : 1);
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: false, dryRun, error: err.message })}\n`);
      return code;
    }
    throw Object.assign(err, { exitCode: code });
  }
  const ok = linesOk(lines);
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok, dryRun, lines }, null, 2)}\n`);
  } else {
    if (dryRun) process.stdout.write('Dry run — nothing will be changed.\n');
    printLines(lines);
  }
  return ok ? 0 : 1;
}

// --- status ------------------------------------------------------------------

function claudeInfo() {
  const spawn = require('./spawn');
  const bin = spawn.findClaude();
  if (!bin) return { found: false, path: null, version: null, ok: false };
  const v = spawn.cachedClaudeVersion ? spawn.cachedClaudeVersion(bin) : spawn.getClaudeVersion(bin);
  const ok = Boolean(v) && spawn.compareVersion(v, spawn.MIN_VERSION) >= 0;
  return { found: true, path: bin, version: v ? v.raw : null, ok };
}

function userServerNames(name) {
  try {
    return mcpLib.readServers(mcpLib.resolveTarget(name)).filter((s) => s.scope === 'user').map((s) => s.name);
  } catch {
    return [];
  }
}

function existingServerNames() {
  const t = { kind: 'profile', name: 'existing', file: profiles.defaultClaudeJson(), configDir: profiles.defaultClaudeDir(), alias: true };
  return mcpLib.readServers(t).filter((s) => s.scope === 'user').map((s) => s.name);
}

function needsToken(p) {
  if (p.alias) return false;
  try {
    const cfg = envLib.readEnvConfig(p.dir);
    return Boolean(cfg && !cfg.auth_token);
  } catch {
    return false;
  }
}

function status({ doctor = true } = {}) {
  const version = require('../package.json').version;
  const cache = updateLib.readCache();
  const claude = claudeInfo();
  const alias = profiles.getAlias();
  const existingFound = fs.existsSync(profiles.defaultClaudeJson()) || fs.existsSync(profiles.defaultClaudeDir());
  const acct = profiles.readDefaultAccount();
  const list = profiles.listProfiles();
  const skills = agentLib.skillStatus();
  const drift = mcpLib.drift();

  const out = {
    cchost: { version, latest: cache.latest || null, updateAvailable: Boolean(updateLib.available()) },
    claude,
    existing: {
      found: existingFound,
      loggedIn: acct.loggedIn,
      email: acct.email ? envLib.maskEmail(acct.email) : '',
      name: alias,
      mcp: existingFound ? existingServerNames() : [],
    },
    profiles: list.map((p) => {
      const kind = !p.alias && envLib.hasEnvConfig(p.dir) ? 'endpoint' : 'subscription';
      const shared = p.alias ? share.SHARED_RESOURCES.length : share.SHARED_RESOURCES.filter((r) => share.isSharedResource(p.dir, r)).length;
      return {
        name: p.name,
        existingAccount: Boolean(p.alias),
        kind,
        endpoint: p.alias ? 'Anthropic' : envLib.endpointSummary(p.dir),
        loggedIn: kind === 'endpoint' ? !needsToken(p) : p.loggedIn,
        needsToken: needsToken(p),
        email: p.email ? envLib.maskEmail(p.email) : '',
        shared: `${shared}/${share.SHARED_RESOURCES.length}`,
        sharesMcp: p.alias || share.isSharedResource(p.dir, 'mcp.json'),
        mcp: userServerNames(p.name),
      };
    }),
    pool: { mcp: mcpLib.readServers(mcpLib.resolveTarget('pool')).map((s) => s.name), mcpDrift: drift },
    skills: { installed: skills.installed, current: skills.current },
    issues: [],
    next: [],
  };

  if (doctor) {
    try {
      out.issues = actions.doctorChecks().filter((c) => c.status !== 'ok')
        .map((c) => ({ status: c.status, check: c.name, message: c.message, fix: c.cmd || c.fix }));
    } catch { /* doctor is best effort here */ }
  }

  const next = out.next;
  if (!claude.found) next.push('Install Claude Code: curl -fsSL https://claude.ai/install.sh | bash');
  else if (!claude.ok) next.push('Update Claude Code: claude update');
  if (out.cchost.updateAvailable) next.push('Update cchost: npm install -g cchost@latest');
  if (existingFound && !alias && acct.loggedIn) next.push('Name the existing account: cchost add <name> --existing');
  for (const p of out.profiles) {
    if (p.needsToken) next.push(`Ask the user to set the token (hidden input): cchost token ${p.name}`);
    else if (!p.loggedIn && p.kind === 'subscription') next.push(`Ask the user to log in: run \`cchost use ${p.name}\`, then type /login`);
  }
  if (drift.length) next.push('Sync pool MCP servers: cchost mcp sync');
  if (!skills.installed) next.push('Install the agent skills: cchost skill install');
  else if (!skills.current) next.push('Update the agent skills: cchost skill install');
  if (out.issues.some((i) => i.status === 'error')) next.push('Review problems: cchost doctor');
  return out;
}

function printStatus(s) {
  const w = (t) => process.stdout.write(`${t}\n`);
  w(`cchost ${s.cchost.version}${s.cchost.updateAvailable ? color.stdout.yellow(` (update available: ${s.cchost.latest})`) : ''}`);
  w(`Claude Code: ${s.claude.found ? `${s.claude.version || 'unknown version'} at ${s.claude.path}` : color.stdout.red('not found')}`);
  if (s.existing.found) {
    const who = s.existing.loggedIn ? (s.existing.email || 'logged in') : 'not logged in';
    w(`Existing account (~/.claude): ${who}${s.existing.name ? ` — named "${s.existing.name}"` : ' — not named yet'}`);
  }
  w(`Profiles: ${s.profiles.length ? '' : 'none'}`);
  for (const p of s.profiles) {
    const login = p.needsToken ? color.stdout.yellow('needs token') : p.loggedIn ? 'logged in' : color.stdout.yellow('not logged in');
    const mcp = p.mcp.length ? `  mcp: ${p.mcp.join(', ')}` : '';
    w(`  ${p.name}${p.existingAccount ? ' (existing account)' : ''}  ${p.endpoint}  ${login}  shared ${p.shared}${mcp}`);
  }
  w(`Pool MCP servers: ${s.pool.mcp.length ? s.pool.mcp.join(', ') : 'none'}`);
  w(`Agent skills: ${s.skills.installed ? (s.skills.current ? 'installed' : 'outdated') : 'not installed'}`);
  if (s.issues.length) w(`Doctor: ${s.issues.length} issue(s) — cchost doctor`);
  if (s.next.length) {
    w('Next:');
    for (const n of s.next) w(`  - ${n}`);
  }
}

async function cmdStatus(rest) {
  const { flags } = parseArgs(rest, { flags: ['--json'] });
  const s = status();
  if (flags.has('--json')) process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
  else printStatus(s);
  return 0;
}

// --- mcp ---------------------------------------------------------------------

const MCP_USAGE = `Usage:
  cchost mcp list [<profile>|pool] [--json]
  cchost mcp copy <from> <to>... [--server=a,b] [--scope=user|local|all] [--project=PATH] [--force] [--dry-run] [--json]
  cchost mcp remove <profile>|pool <server> [--scope=user|local|all] [--project=PATH] [--dry-run] [--json]
  cchost mcp sync [<profile>...] [--dry-run] [--json]`;

function describeServer(s) {
  const what = s.url || [s.command, ...(s.args || [])].filter(Boolean).join(' ');
  const secrets = [...s.envKeys.map((k) => `env ${k}`), ...s.headerKeys.map((k) => `header ${k}`)];
  return `${what}${secrets.length ? `  (${secrets.join(', ')}: hidden)` : ''}`;
}

function printMcp(views) {
  for (const v of views) {
    const tag = v.kind === 'pool' ? ' — shared: profiles that share mcp.json get these' : v.subscribed ? ' — gets the pool\'s servers' : '';
    process.stdout.write(`${color.stdout.bold(v.target)}${v.alias ? ' (existing account)' : ''}${tag}\n`);
    if (!v.servers.length) process.stdout.write('  (no MCP servers)\n');
    const user = v.servers.filter((s) => s.scope !== 'local');
    const local = v.servers.filter((s) => s.scope === 'local');
    for (const s of user) process.stdout.write(`  ${s.name}${s.fromPool ? ' [pool]' : ''}  ${describeServer(s)}\n`);
    const byProject = new Map();
    for (const s of local) byProject.set(s.project, [...(byProject.get(s.project) || []), s]);
    for (const [proj, list] of byProject) {
      const home = os.homedir();
      process.stdout.write(`  in ${proj.startsWith(home) ? `~${proj.slice(home.length)}` : proj}:\n`);
      for (const s of list) process.stdout.write(`    ${s.name}  ${describeServer(s)}\n`);
    }
  }
}

function splitList(v) {
  return v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
}

async function cmdMcp(rest) {
  const [sub, ...args] = rest;
  if (!sub || sub === 'help' || sub === '--help') {
    process.stdout.write(`${MCP_USAGE}\n`);
    return sub ? 0 : 2;
  }
  if (sub === 'list') {
    const { flags, positional } = parseArgs(args, { flags: ['--json'] });
    if (positional.length > 1) throw usageError(MCP_USAGE);
    let views;
    try {
      views = positional.length ? [mcpLib.describe(mcpLib.resolveTarget(positional[0]))] : mcpLib.listAll();
    } catch (err) {
      throw Object.assign(err, { exitCode: err.exitCode || 1 });
    }
    if (flags.has('--json')) process.stdout.write(`${JSON.stringify(positional.length ? views[0] : views, null, 2)}\n`);
    else printMcp(views);
    return 0;
  }
  const common = { flags: ['--dry-run', '--json', '--force'], values: ['--server', '--scope', '--project'] };
  const { flags, values, positional } = parseArgs(args, common);
  const opts = { dryRun: flags.has('--dry-run'), json: flags.has('--json') };
  if (sub === 'copy') {
    const [from, ...to] = positional;
    if (!from || !to.length) throw usageError(MCP_USAGE);
    return runAction('mcp-copy', {
      from, to, servers: splitList(values['--server']), scope: values['--scope'] || 'user', project: values['--project'], force: flags.has('--force'),
    }, opts);
  }
  if (sub === 'remove') {
    const [target, server, ...extra] = positional;
    if (!target || !server || extra.length) throw usageError(MCP_USAGE);
    if (flags.has('--force')) throw usageError('--force does not apply to mcp remove');
    return runAction('mcp-remove', { target, server, scope: values['--scope'] || 'user', project: values['--project'] }, opts);
  }
  if (sub === 'sync') {
    if (flags.has('--force') || values['--server'] || values['--scope'] || values['--project']) throw usageError('Usage: cchost mcp sync [<profile>...] [--dry-run] [--json]');
    return runAction('mcp-sync', { profiles: positional }, opts);
  }
  throw usageError(`Unknown mcp command "${sub}".\n${MCP_USAGE}`);
}

// --- backups / restore ---------------------------------------------------------

async function cmdBackups(rest) {
  const { flags } = parseArgs(rest, { flags: ['--json'] });
  const list = backupLib.list();
  if (flags.has('--json')) {
    process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
    return 0;
  }
  if (!list.length) {
    process.stdout.write('No backups yet. cchost saves one before every change it makes to a JSON file.\n');
    return 0;
  }
  for (const b of list) {
    const files = b.files.map(backupLib.shortPath).join(', ');
    process.stdout.write(`${b.id}\n  ${files}\n`);
  }
  process.stdout.write('\nUndo one with: cchost restore <id> (add --dry-run to preview)\n');
  return 0;
}

async function cmdRestore(rest) {
  const { flags, positional } = parseArgs(rest, { flags: ['--dry-run', '--json'] });
  const [id, ...extra] = positional;
  if (!id || extra.length) throw usageError('Usage: cchost restore <id> [--dry-run] [--json]   (ids: cchost backups)');
  return runAction('restore', { id }, { dryRun: flags.has('--dry-run'), json: flags.has('--json') });
}

// --- agent / skill -------------------------------------------------------------

async function cmdAgent(rest) {
  const { positional } = parseArgs(rest);
  const [topic = 'overview', ...extra] = positional;
  if (extra.length) throw usageError('Usage: cchost agent [topic]');
  let text;
  try {
    text = agentLib.guide(topic);
  } catch (err) {
    throw Object.assign(err, { exitCode: 2 });
  }
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  return 0;
}

async function cmdSkill(rest) {
  const [sub, ...args] = rest;
  const usage = 'Usage: cchost skill install [--profile=<name>] [--dry-run] [--json]\n       cchost skill status [--json]';
  if (sub === 'status') {
    const { flags } = parseArgs(args, { flags: ['--json'] });
    const st = agentLib.skillStatus();
    if (flags.has('--json')) process.stdout.write(`${JSON.stringify(st, null, 2)}\n`);
    else for (const s of st.skills) process.stdout.write(`${s.name}: ${s.installed ? (s.current ? 'installed, current' : 'installed, outdated') : 'not installed'}\n`);
    return 0;
  }
  if (sub !== 'install') throw usageError(usage);
  const { flags, values, positional } = parseArgs(args, { flags: ['--dry-run', '--json'], values: ['--profile'] });
  if (positional.length) throw usageError(usage);
  return runAction('skill-install', { profile: values['--profile'] }, { dryRun: flags.has('--dry-run'), json: flags.has('--json') });
}

// --- token ---------------------------------------------------------------------

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function cmdToken(rest) {
  const { flags, positional } = parseArgs(rest, { flags: ['--stdin'] });
  const [name, ...extra] = positional;
  if (!name || extra.length) throw usageError('Usage: cchost token <profile> [--stdin]');
  const p = profiles.resolveProfile(name);
  if (p.alias || !envLib.hasEnvConfig(p.dir)) {
    throw Object.assign(new Error(`"${name}" is not a custom-endpoint profile; it logs in with /login instead.`), { exitCode: 1 });
  }
  let token;
  if (flags.has('--stdin')) {
    token = await readStdin();
  } else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw usageError(`Setting a token needs a person at a terminal. Ask the user to run: cchost token ${name}`);
    }
    token = (await envLib.defaultWizardIo().readHidden(`Token for ${name} (input hidden): `)).trim();
  }
  if (!token) throw usageError('No token given; nothing changed.');
  envLib.validateField('auth_token', token, (m) => process.stderr.write(`${m}\n`));
  const cfg = envLib.readEnvConfig(p.dir) || {};
  envLib.writeEnvConfig(p.dir, { ...cfg, auth_token: token });
  process.stdout.write(`Token saved for "${name}" (readable by you only).\n`);
  return 0;
}

module.exports = {
  parseArgs,
  printLines,
  runAction,
  status,
  cmdStatus,
  cmdMcp,
  cmdBackups,
  cmdRestore,
  cmdAgent,
  cmdSkill,
  cmdToken,
  MCP_USAGE,
};
