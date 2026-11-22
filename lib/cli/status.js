'use strict';

// Overview and upkeep: status, doctor, ui, backups, agent guides, skills.

const fs = require('fs');
const path = require('path');

const profiles = require('../profiles');
const share = require('../share');
const envLib = require('../env');
const actions = require('../actions');
const pinsLib = require('../pins');
const color = require('../color');
const errors = require('../errors');
const paths = require('../paths');
const mcpLib = require('../mcp');
const backupLib = require('../backup');
const agentLib = require('../agent');
const updateLib = require('../update');
const { parseArgs, runAction, prompt } = require('./term');

function claudeInfo() {
  const spawn = require('../spawn');
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
  const version = require('../../package.json').version;
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
        endpoint: p.alias ? 'subscription' : envLib.endpointSummary(p.dir),
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
    pins: pinsLib.list(),
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
  if (!claude.found) next.push('Install or repair Claude Code: cchost update claude');
  else if (!claude.ok) next.push('Update Claude Code: cchost update claude');
  if (out.cchost.updateAvailable) next.push('Update cchost: npm install -g cchost@latest');
  if (existingFound && !alias && acct.loggedIn) next.push('Name the existing account: cchost add <name> --existing');
  for (const p of out.profiles) {
    if (p.needsToken) next.push(`Set the token for ${p.name} (hidden input): cchost token ${p.name}`);
    else if (!p.loggedIn && p.kind === 'subscription') next.push(`Log in to ${p.name}: cchost use ${p.name}, then type /login`);
  }
  if (drift.length) next.push('Sync pool MCP servers: cchost mcp sync');
  if (!skills.installed) next.push('Install the agent skills: cchost skill install');
  else if (!skills.current) next.push('Update the agent skills: cchost skill install');
  if (out.issues.some((i) => i.status === 'error')) next.push('Review problems: cchost doctor');
  return out;
}

function printStatus(s) {
  const w = (t = '') => process.stdout.write(`${t}\n`);
  const dim = color.stdout.dim;
  const key = (k) => dim(k.padEnd(14));
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  w(`${color.stdout.bold(`cchost ${s.cchost.version}`)}${s.cchost.updateAvailable ? color.stdout.yellow(`  update available: ${s.cchost.latest} (npm i -g cchost@latest)`) : ''}`);
  w(`${key('Claude Code')}${s.claude.found ? `${s.claude.version || 'unknown version'}${s.claude.ok ? '' : color.stdout.yellow('  (old: run cchost update claude)')}` : color.stdout.red('not found')}`);
  if (s.existing.found) {
    const who = s.existing.loggedIn ? (s.existing.email || 'logged in') : color.stdout.yellow('not logged in');
    w(`${key('Your account')}${who}${dim(s.existing.name ? `  named "${s.existing.name}"` : '  not named yet')}`);
  }
  w();
  if (!s.profiles.length) {
    w(`${key('Profiles')}none yet`);
  } else {
    w(color.stdout.bold('Profiles'));
    const rows = s.profiles.map((p) => ({
      name: `${p.name}${p.existingAccount ? '*' : ''}`,
      via: p.endpoint,
      login: p.needsToken ? 'needs token' : p.loggedIn ? 'logged in' : 'not logged in',
      ok: !p.needsToken && p.loggedIn,
      shared: `${p.shared} shared`,
      mcp: p.mcp.length ? `mcp: ${p.mcp.join(', ')}` : '',
    }));
    const wd = (k) => Math.max(...rows.map((r) => r[k].length));
    for (const r of rows) {
      const login = r.login.padEnd(wd('login'));
      w(`  ${color.stdout.bold(r.name.padEnd(wd('name')))}  ${r.via.padEnd(wd('via'))}  ${r.ok ? color.stdout.green(login) : color.stdout.yellow(login)}  ${dim(r.shared.padEnd(wd('shared')))}  ${dim(r.mcp)}`.trimEnd());
    }
    if (s.profiles.some((p) => p.existingAccount)) w(dim('  * your existing account (~/.claude, plain claude)'));
  }
  w();
  w(`${key('Shared MCP')}${s.pool.mcp.length ? s.pool.mcp.join(', ') : dim('none')}`);
  if (s.pins.length) {
    s.pins.forEach((p, i) => w(`${key(i ? '' : 'Pinned')}${paths.shortPath(p.dir)} → ${p.profile}${!p.exists ? color.stdout.yellow('  (folder missing)') : !p.profileExists ? color.stdout.yellow('  (profile missing)') : ''}`));
  } else {
    w(`${key('Pinned')}${dim('none · cchost go in a project folder offers to pin it')}`);
  }
  w(`${key('Agent skills')}${s.skills.installed ? (s.skills.current ? 'installed' : color.stdout.yellow('outdated')) : dim('not installed')}`);
  w(`${key('Doctor')}${s.issues.length ? color.stdout.yellow(`${n(s.issues.length, 'issue', 'issues')} · cchost doctor`) : color.stdout.green('all good')}`);
  if (s.next.length) {
    w();
    w(color.stdout.bold('Next'));
    for (const x of s.next) w(`  → ${x}`);
  }
}

async function cmdStatus(rest) {
  const { flags } = parseArgs(rest, { flags: ['--json'] });
  const s = status();
  if (flags.has('--json')) process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
  else printStatus(s);
  return 0;
}

async function cmdDoctor(rest) {
  const { flags, positional } = parseArgs(rest, { flags: ['--fix', '--force', '--json', '--dry-run'] });
  if (positional.length) throw errors.usage(`Unexpected argument: ${positional[0]}`);
  const fix = flags.has('--fix');
  const force = flags.has('--force');
  if (force && !fix) throw errors.usage('--force requires --fix');
  const json = flags.has('--json');
  if (flags.has('--dry-run')) {
    if (!fix) throw errors.usage('--dry-run goes with --fix: cchost doctor --fix --dry-run');
    return runAction('doctor-fix', {}, { dryRun: true, json });
  }
  const doctor = require('../doctor');
  return doctor.runDoctor({ fix, force, json, prompt });
}

// '30m', '8h', '2d' -> milliseconds.
function parseDuration(text) {
  const m = /^(\d+)(m|h|d)$/.exec(text);
  if (!m || Number(m[1]) === 0) return null;
  return Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]];
}

async function cmdUi(rest) {
  let port = 0;
  let open = true;
  let user = 'cchost';
  let pass = null;
  let sessionTtlMs;
  for (const a of rest) {
    if (a === '--no-open') { open = false; continue; }
    const eq = a.indexOf('=');
    const flag = eq === -1 ? a : a.slice(0, eq);
    const value = eq === -1 ? null : a.slice(eq + 1);
    if (['--port', '--user', '--pass', '--session'].includes(flag) && !value) {
      throw errors.usage(`Flag ${flag} requires a value: ${flag}=VALUE`);
    }
    if (flag === '--port') {
      port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw errors.usage(`Invalid port: ${a}`);
      continue;
    }
    if (flag === '--user') { user = value; continue; }
    if (flag === '--pass') {
      if (value.length < 8) throw errors.usage('--pass must be at least 8 characters.');
      pass = value;
      continue;
    }
    if (flag === '--session') {
      sessionTtlMs = parseDuration(value);
      if (!sessionTtlMs) throw errors.usage(`Invalid --session "${value}". Use e.g. 30m, 8h or 2d.`);
      continue;
    }
    throw errors.usage(a.startsWith('-') ? `Unknown flag: ${flag}` : `Unexpected argument: ${a}`);
  }
  const { startUi } = require('../ui/server');
  await startUi({ port, open, user, pass, sessionTtlMs });
  return new Promise(() => {});
}

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
    const files = b.files.map(paths.shortPath).join(', ');
    process.stdout.write(`${b.id}\n  ${files}\n`);
  }
  process.stdout.write('\nUndo one with: cchost restore <id> (add --dry-run to preview)\n');
  return 0;
}

async function cmdUpdate(rest) {
  const { flags, positional } = parseArgs(rest, { flags: ['--dry-run', '--json'] });
  const [what, ...extra] = positional;
  if (what !== 'claude' || extra.length) {
    throw errors.usage('Usage: cchost update claude [--dry-run] [--json]   (update cchost itself: npm install -g cchost@latest)');
  }
  const json = flags.has('--json');
  const write = json ? (t) => process.stderr.write(t) : (t) => process.stdout.write(t);
  const result = require('../claude-install').update({ write, dryRun: flags.has('--dry-run'), stdio: json ? ['ignore', 2, 2] : 'inherit' });
  if (json) process.stdout.write(`${JSON.stringify({ ok: true, dryRun: flags.has('--dry-run'), ...result }, null, 2)}\n`);
  return 0;
}

async function cmdRestore(rest) {
  const { flags, positional } = parseArgs(rest, { flags: ['--dry-run', '--json'] });
  const [id, ...extra] = positional;
  if (!id || extra.length) throw errors.usage('Usage: cchost restore <id> [--dry-run] [--json]   (ids: cchost backups)');
  return runAction('restore', { id }, { dryRun: flags.has('--dry-run'), json: flags.has('--json') });
}

async function cmdAgent(rest) {
  const { positional } = parseArgs(rest);
  const [topic = 'overview', ...extra] = positional;
  if (extra.length) throw errors.usage('Usage: cchost agent [topic]');
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
  if (sub !== 'install') throw errors.usage(usage);
  const { flags, values, positional } = parseArgs(args, { flags: ['--dry-run', '--json'], values: ['--profile'] });
  if (positional.length) throw errors.usage(usage);
  return runAction('skill-install', { profile: values['--profile'] }, { dryRun: flags.has('--dry-run'), json: flags.has('--json') });
}

module.exports = { status, cmdStatus, cmdDoctor, cmdUi, cmdBackups, cmdRestore, cmdUpdate, cmdAgent, cmdSkill };
