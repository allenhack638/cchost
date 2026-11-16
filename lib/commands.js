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
const pinsLib = require('./pins');
const findLib = require('./find');
const color = require('./color');
const errors = require('./errors');
const paths = require('./paths');

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
      if (eq === -1 || eq === a.length - 1) throw errors.usage(`${name} needs a value: ${name}=VALUE`);
      vals[name] = a.slice(eq + 1);
    } else if (flags.includes(name) && eq === -1) {
      set.add(name);
    } else {
      throw errors.usage(`Unknown flag: ${name}`);
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
  if (!claude.found) next.push('Install Claude Code: curl -fsSL https://claude.ai/install.sh | bash');
  else if (!claude.ok) next.push('Update Claude Code: claude update');
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
  w(`${key('Claude Code')}${s.claude.found ? `${s.claude.version || 'unknown version'}${s.claude.ok ? '' : color.stdout.yellow('  (old: run claude update)')}` : color.stdout.red('not found')}`);
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
    if (positional.length > 1) throw errors.usage(MCP_USAGE);
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
    if (!from || !to.length) throw errors.usage(MCP_USAGE);
    return runAction('mcp-copy', {
      from, to, servers: splitList(values['--server']), scope: values['--scope'] || 'user', project: values['--project'], force: flags.has('--force'),
    }, opts);
  }
  if (sub === 'remove') {
    const [target, server, ...extra] = positional;
    if (!target || !server || extra.length) throw errors.usage(MCP_USAGE);
    if (flags.has('--force')) throw errors.usage('--force does not apply to mcp remove');
    return runAction('mcp-remove', { target, server, scope: values['--scope'] || 'user', project: values['--project'] }, opts);
  }
  if (sub === 'sync') {
    if (flags.has('--force') || values['--server'] || values['--scope'] || values['--project']) throw errors.usage('Usage: cchost mcp sync [<profile>...] [--dry-run] [--json]');
    return runAction('mcp-sync', { profiles: positional }, opts);
  }
  throw errors.usage(`Unknown mcp command "${sub}".\n${MCP_USAGE}`);
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
    const files = b.files.map(paths.shortPath).join(', ');
    process.stdout.write(`${b.id}\n  ${files}\n`);
  }
  process.stdout.write('\nUndo one with: cchost restore <id> (add --dry-run to preview)\n');
  return 0;
}

async function cmdRestore(rest) {
  const { flags, positional } = parseArgs(rest, { flags: ['--dry-run', '--json'] });
  const [id, ...extra] = positional;
  if (!id || extra.length) throw errors.usage('Usage: cchost restore <id> [--dry-run] [--json]   (ids: cchost backups)');
  return runAction('restore', { id }, { dryRun: flags.has('--dry-run'), json: flags.has('--json') });
}

// --- agent / skill -------------------------------------------------------------

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

// --- pins ----------------------------------------------------------------------

const PIN_USAGE = `Usage:
  cchost pin <profile> [--path=DIR] [--dry-run] [--json]
  cchost unpin [--path=DIR] [--dry-run] [--json]
  cchost pins [--json]
  cchost which [--json]
  cchost go [...claude args]`;

async function cmdPin(rest) {
  const { flags, values, positional } = parseArgs(rest, { flags: ['--dry-run', '--json'], values: ['--path'] });
  const [profile, ...extra] = positional;
  if (!profile || extra.length) throw errors.usage(PIN_USAGE);
  return runAction('pin', { profile, dir: values['--path'] }, { dryRun: flags.has('--dry-run'), json: flags.has('--json') });
}

async function cmdUnpin(rest) {
  const { flags, values, positional } = parseArgs(rest, { flags: ['--dry-run', '--json'], values: ['--path'] });
  if (positional.length) throw errors.usage(PIN_USAGE);
  return runAction('unpin', { dir: values['--path'] }, { dryRun: flags.has('--dry-run'), json: flags.has('--json') });
}

async function cmdPins(rest) {
  const { flags } = parseArgs(rest, { flags: ['--json'] });
  const list = pinsLib.list();
  if (flags.has('--json')) {
    process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
    return 0;
  }
  if (!list.length) {
    process.stdout.write('No pinned folders. Pin one with: cchost pin <profile>   (run it inside the folder)\n');
    return 0;
  }
  const width = Math.max(...list.map((p) => paths.shortPath(p.dir).length));
  for (const p of list) {
    const note = !p.exists ? color.stdout.yellow('  folder missing') : !p.profileExists ? color.stdout.yellow('  profile missing') : '';
    process.stdout.write(`${paths.shortPath(p.dir).padEnd(width)}  ${p.profile}${note}\n`);
  }
  return 0;
}

function whichInfo(cwd = process.cwd()) {
  const hit = pinsLib.resolve(cwd);
  let scope = null;
  let scopeError = null;
  try {
    scope = pinsLib.scope(cwd);
  } catch (err) {
    scopeError = err.message;
  }
  const alias = profiles.getAlias();
  let launch = null;
  let reason;
  if (hit && hit.kind === 'pin') {
    launch = hit.profile;
    reason = `pinned at ${paths.shortPath(hit.dir)}`;
  } else if (hit && hit.profile) {
    reason = `${pinsLib.FILE} in ${paths.shortPath(hit.dir)} suggests ${hit.profile}; \`cchost go\` asks once before using it`;
  } else if (hit) {
    reason = hit.error;
  } else if (alias) {
    launch = alias;
    reason = `no pin here; the existing account "${alias}" is the default`;
  } else {
    reason = 'no pin here and no default; run `cchost pin <profile>` or `cchost use <profile>`';
  }
  return {
    cwd,
    launch,
    reason,
    pin: hit ? { kind: hit.kind, dir: hit.dir, profile: hit.profile, confirmed: hit.confirmed } : null,
    scope: scope ? { ...scope, short: paths.shortPath(scope.root) } : null,
    scopeError,
  };
}

async function cmdWhich(rest) {
  const { flags } = parseArgs(rest, { flags: ['--json'] });
  const w = whichInfo();
  if (flags.has('--json')) {
    process.stdout.write(`${JSON.stringify(w, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`cchost go here runs: ${w.launch ? color.stdout.bold(w.launch) : color.stdout.yellow('nothing')}  (${w.reason})\n`);
  if (w.scope) {
    const who = w.scope.profiles === null ? 'every account' : w.scope.profiles.length ? `account ${w.scope.profiles.join(', ')}` : 'no account';
    process.stdout.write(`cchost find here sees: ${w.scope.short} and subfolders, ${who}\n`);
  } else {
    process.stdout.write(`cchost find here sees: ${color.stdout.yellow('nothing')} — ${w.scopeError}\n`);
  }
  return 0;
}

// --- find / index ----------------------------------------------------------------

const FIND_USAGE = `Usage:
  cchost find <words...> [--since=30d] [-n=20] [--json]
  cchost find <words...> [--profile=NAME[,NAME...]] [--global] [--project=PATH]   (--global: terminal only)
  cchost open [<session-id-prefix>] [--fork] [--global] [--profile=NAME] [--cwd=PATH]
  cchost index [--global] [--json]`;

function globalAllowed() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// The scope a find/open/index call runs in. --global is the only way out of
// the folder's scope, and it needs a person at a terminal.
function scopeFromFlags(flags, values, what) {
  if (flags.has('--global')) {
    if (!globalAllowed()) {
      throw errors.usage(`--global shows every account's conversations and only works in a terminal. Ask the user to run \`cchost ${what} --global\` themselves.`);
    }
    return { root: null, profiles: null, source: 'global', confirmed: true };
  }
  return pinsLib.scope();
}

function ago(iso) {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 14 * 86400) return `${Math.round(s / 86400)}d ago`;
  if (s < 60 * 86400) return `${Math.round(s / 604800)}w ago`;
  return String(iso).slice(0, 10);
}

function highlight(text, terms) {
  if (!terms.length) return text;
  const re = new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  return text.replace(re, (m) => color.stdout.mark(m));
}

function clip(text, width) {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

function printFind(res, scope) {
  const w = (t = '') => process.stdout.write(`${t}\n`);
  const width = Math.max(60, Math.min(process.stdout.columns || 100, 120)) - 4;
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const more = res.total > res.results.length ? color.stdout.dim(`  (top ${res.results.length}; more with -n=${res.total})`) : '';
  w(`${color.stdout.bold(n(res.total, 'match', 'matches'))} ${color.stdout.dim(`in ${n(res.sessions, 'conversation', 'conversations')} · ${res.scope.text}`)}${more}`);
  if (!res.total) {
    w(color.stdout.dim('  Every word must appear in the same message. Try fewer or different words.'));
    if (scope.source !== 'global' && globalAllowed()) w(color.stdout.dim('  Search every folder and account: add --global'));
    return;
  }
  for (const r of res.results) {
    const who = r.accounts.length ? r.accounts.join(', ') : 'unknown account';
    const where = `${r.short || ''}${r.branch ? ` (${r.branch})` : ''}`;
    w();
    w(`  ${color.stdout.bold(color.stdout.cyan(r.id.slice(0, 8)))}  ${who} ${color.stdout.dim(`· ${ago(r.lastSeen)} · ${where}`)}`);
    if (r.title && !r.snippet.startsWith(r.title.replace(/…$/, ''))) w(`  ${color.stdout.bold(clip(r.title, width))}`);
    w(`  ${color.stdout.dim(r.where === 'prompt' ? 'you   ' : 'claude')} ${highlight(clip(r.snippet, width - 7), res.query)}`);
  }
  w();
  w(`${color.stdout.dim('→ resume:')} ${color.stdout.bold(`cchost open ${res.results[0].id.slice(0, 8)}`)}${color.stdout.dim('   (or any id above; add --fork to branch off)')}`);
}

async function cmdFind(rest) {
  const { flags, values, positional } = parseArgs(rest, { flags: ['--json', '--global'], values: ['--since', '-n', '--profile', '--project'] });
  if (!positional.length) throw errors.usage(FIND_USAGE);
  const json = flags.has('--json');
  const limit = values['-n'] ? Number(values['-n']) : 20;
  if (!Number.isInteger(limit) || limit < 1) throw errors.usage('-n wants a positive number');
  let scope;
  try {
    scope = scopeFromFlags(flags, values, 'find');
  } catch (err) {
    if (json && err.exitCode !== 2) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
      return 1;
    }
    throw err;
  }
  await findLib.refresh(scope);
  let res;
  try {
    res = findLib.search(scope, positional.join(' '), { profile: values['--profile'], project: values['--project'], since: values['--since'], limit });
  } catch (err) {
    if (json && err.exitCode !== 2) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
      return 1;
    }
    throw Object.assign(err, { exitCode: err.exitCode || 1 });
  }
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...res }, null, 2)}\n`);
    return 0;
  }
  printFind(res, scope);
  return 0;
}

function recentLabel(r) {
  const who = r.accounts.length ? r.accounts.join(', ') : 'unknown account';
  const width = Math.max(50, Math.min(process.stdout.columns || 100, 120)) - 12;
  return `${color.stdout.cyan(r.id.slice(0, 8))}  ${clip(r.title || r.last, width - 10)}\n        ${color.stdout.dim(`${who} · ${ago(r.lastSeen)} · ${r.short || ''}${r.branch ? ` (${r.branch})` : ''}`)}`;
}

function printRecent(res) {
  process.stdout.write(`${color.stdout.bold('Recent conversations')} ${color.stdout.dim(`· ${res.scope.text}`)}\n`);
  for (const r of res.results) process.stdout.write(`  ${recentLabel(r)}\n`);
  process.stdout.write(`${color.stdout.dim('→ resume one:')} ${color.stdout.bold(`cchost open ${res.results[0].id.slice(0, 8)}`)}\n`);
}

async function cmdIndex(rest) {
  const { flags } = parseArgs(rest, { flags: ['--json', '--global'] });
  const scope = scopeFromFlags(flags, {}, 'index');
  const stats = await findLib.refresh(scope, { prune: scope.source === 'global' });
  const summary = findLib.indexSummary();
  if (flags.has('--json')) {
    process.stdout.write(`${JSON.stringify({ ok: true, scope: { root: scope.root, profiles: scope.profiles, source: scope.source }, ...stats, index: summary }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`indexed ${stats.indexed}, unchanged ${stats.unchanged}, outside scope ${stats.skipped}${stats.pruned ? `, pruned ${stats.pruned}` : ''}\n`);
  for (const i of summary) {
    if (i.sessions) process.stdout.write(`  ${i.account.padEnd(16)} ${String(i.sessions).padStart(5)} sessions  ${(i.bytes / 1e6).toFixed(1)} MB  ${i.dir}\n`);
  }
  return 0;
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
  if (!name || extra.length) throw errors.usage('Usage: cchost token <profile> [--stdin]');
  const p = profiles.resolveProfile(name);
  if (p.alias || !envLib.hasEnvConfig(p.dir)) {
    throw Object.assign(new Error(`"${name}" is not a custom-endpoint profile; it logs in with /login instead.`), { exitCode: 1 });
  }
  let token;
  if (flags.has('--stdin')) {
    token = await readStdin();
  } else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw errors.usage(`Setting a token needs a person at a terminal. Ask the user to run: cchost token ${name}`);
    }
    token = (await envLib.defaultWizardIo().readHidden(`Token for ${name} (input hidden): `)).trim();
  }
  if (!token) throw errors.usage('No token given; nothing changed.');
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
  cmdPin,
  cmdUnpin,
  cmdPins,
  cmdWhich,
  cmdFind,
  cmdIndex,
  printRecent,
  recentLabel,
  scopeFromFlags,
  FIND_USAGE,
};
