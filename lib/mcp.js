'use strict';

// MCP servers live in each account's .claude.json: `mcpServers` (user scope,
// every folder) and `projects[<path>].mcpServers` (local scope, one folder).
// The pool, ~/.claude/mcp.json, is cchost's own list: profiles that share
// mcp.json get its servers written into their user scope by sync(), which
// records what it added in <configDir>/.cc-mcp-sync.json so it only ever
// updates or removes its own copies.
//
// Secrets: env and header values, and secret-looking args/URL parts, are never
// returned. Copies happen here, by server name.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const profiles = require('./profiles');
const share = require('./share');
const backup = require('./backup');

const SECRET_WORD = /(token|secret|password|passwd|pwd|api[-_]?key|apikey|auth|bearer|credential|private[-_]?key|access[-_]?key|session)/i;
const SECRET_PARAM = /(key|sig|signature|code)/i;
const MANAGED_FILE = '.cc-mcp-sync.json';

function mcpError(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  e.exitCode = status === 404 ? 1 : 2;
  return e;
}

function poolFile() {
  return path.join(profiles.defaultClaudeDir(), 'mcp.json');
}

// 'pool', a profile, or the named existing account.
function resolveTarget(name) {
  if (name === 'pool') return { kind: 'pool', name: 'pool', file: poolFile(), configDir: null, alias: false };
  let p;
  try {
    p = profiles.resolveProfile(name);
  } catch (err) {
    throw mcpError(err.message, err.status || 404);
  }
  return { kind: 'profile', name: p.name, file: p.claudeJson, configDir: p.dir, alias: p.alias };
}

function readData(file) {
  try {
    return backup.readJson(file);
  } catch {
    return {};
  }
}

function serversOf(obj) {
  const s = obj && obj.mcpServers;
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}

// [{ name, scope: 'pool'|'user'|'local', project, config }]
function readServers(target) {
  const data = readData(target.file);
  const out = [];
  if (target.kind === 'pool') {
    for (const [name, config] of Object.entries(serversOf(data))) out.push({ name, scope: 'pool', project: null, config });
    return out;
  }
  for (const [name, config] of Object.entries(serversOf(data))) out.push({ name, scope: 'user', project: null, config });
  const projects = data.projects && typeof data.projects === 'object' ? data.projects : {};
  for (const [project, entry] of Object.entries(projects)) {
    for (const [name, config] of Object.entries(serversOf(entry))) out.push({ name, scope: 'local', project, config });
  }
  return out;
}

// --- masking -----------------------------------------------------------------

function looksLikeSecretValue(v) {
  return typeof v === 'string' && v.length >= 20 && /^[A-Za-z0-9_\-+=.~]+$/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v) && !v.includes('/');
}

function maskArgs(args) {
  if (!Array.isArray(args)) return [];
  const out = [];
  let hideNext = false;
  for (const raw of args) {
    const a = String(raw);
    if (hideNext) {
      out.push('***');
      hideNext = false;
      continue;
    }
    const eq = a.indexOf('=');
    if (a.startsWith('-') && eq > 0 && SECRET_WORD.test(a.slice(0, eq))) {
      out.push(`${a.slice(0, eq)}=***`);
      continue;
    }
    if (a.startsWith('-') && eq === -1 && SECRET_WORD.test(a)) {
      out.push(a);
      hideNext = true;
      continue;
    }
    out.push(looksLikeSecretValue(a) ? '***' : maskUrl(a));
  }
  return out;
}

function maskUrl(u) {
  if (typeof u !== 'string' || !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return u;
  try {
    const url = new URL(u);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '';
    }
    for (const key of [...url.searchParams.keys()]) {
      const v = url.searchParams.get(key);
      if (SECRET_WORD.test(key) || SECRET_PARAM.test(key) || looksLikeSecretValue(v)) url.searchParams.set(key, '***');
    }
    return url.toString().replace(/%2A%2A%2A/g, '***');
  } catch {
    return u;
  }
}

function keysOf(obj) {
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.keys(obj).sort() : [];
}

function transportOf(config) {
  if (config && typeof config.type === 'string') return config.type;
  return config && config.url ? 'http' : 'stdio';
}

// What may be shown anywhere: no env/header values, secret-looking parts hidden.
function publicView(config) {
  const c = config && typeof config === 'object' ? config : {};
  return {
    transport: transportOf(c),
    command: typeof c.command === 'string' ? c.command : null,
    args: maskArgs(c.args),
    url: typeof c.url === 'string' ? maskUrl(c.url) : null,
    envKeys: keysOf(c.env),
    headerKeys: keysOf(c.headers),
  };
}

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

// Lets a viewer tell identical configs apart without seeing them: keyed per
// process, so it can't be looked up or compared across runs.
const FP_KEY = crypto.randomBytes(32);
function fingerprint(config) {
  return crypto.createHmac('sha256', FP_KEY).update(stable(config)).digest('hex').slice(0, 12);
}

function sameConfig(a, b) {
  return stable(a) === stable(b);
}

// --- pool subscription --------------------------------------------------------

function readManaged(configDir) {
  const data = readData(path.join(configDir, MANAGED_FILE));
  return data.servers && typeof data.servers === 'object' ? data.servers : {};
}

// Accounts that get the pool's servers: profiles sharing mcp.json, and the
// existing account, whose ~/.claude/mcp.json is the pool itself.
function subscribers() {
  return profiles.listProfiles()
    .filter((p) => p.alias || share.isSharedResource(p.dir, 'mcp.json'))
    .map((p) => resolveTarget(p.name));
}

function isSubscribed(target) {
  if (target.kind !== 'profile') return false;
  return target.alias || share.isSharedResource(target.configDir, 'mcp.json');
}

// --- list --------------------------------------------------------------------

function describe(target) {
  const servers = readServers(target);
  const managed = target.kind === 'profile' ? readManaged(target.configDir) : {};
  return {
    target: target.name,
    kind: target.kind,
    alias: target.alias,
    subscribed: isSubscribed(target),
    servers: servers.map((s) => ({
      name: s.name,
      scope: s.scope,
      project: s.project,
      fromPool: s.scope === 'user' && Object.prototype.hasOwnProperty.call(managed, s.name),
      fp: fingerprint(s.config),
      ...publicView(s.config),
    })),
  };
}

function listAll() {
  const targets = [resolveTarget('pool'), ...profiles.listProfiles().map((p) => resolveTarget(p.name))];
  return targets.map(describe);
}

// --- lines -------------------------------------------------------------------

function where(target, scope, project) {
  if (target.kind === 'pool') return 'pool';
  if (scope === 'local') return `${target.name} (${shortPath(project)})`;
  return target.name;
}

function shortPath(p) {
  const home = require('os').homedir();
  return p && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function mline(kind, label, text, extra = {}) {
  return { n: null, resource: null, label, kind, text, ...extra };
}

// --- copy --------------------------------------------------------------------

function pickSources(source, { servers, scope = 'user', project } = {}) {
  let list = readServers(source);
  if (source.kind === 'pool') {
    list = list.map((s) => ({ ...s, scope: 'user' }));
  } else if (scope !== 'all') {
    list = list.filter((s) => s.scope === scope);
  }
  if (project) {
    const want = path.resolve(project);
    list = list.filter((s) => s.scope !== 'local' || s.project === want);
  }
  if (servers && servers.length) {
    const missing = servers.filter((n) => !list.some((s) => s.name === n));
    if (missing.length) {
      throw mcpError(`${source.name} has no ${scope === 'all' || source.kind === 'pool' ? '' : `${scope}-scope `}MCP server named ${missing.map((m) => `"${m}"`).join(', ')}.`, 404);
    }
    list = list.filter((s) => servers.includes(s.name));
  }
  return list;
}

function slotOf(data, entry, destKind) {
  if (destKind === 'pool' || entry.scope !== 'local') return serversOf(data);
  const proj = data.projects && data.projects[entry.project];
  return proj ? serversOf(proj) : {};
}

function put(data, entry, destKind) {
  if (destKind === 'pool' || entry.scope !== 'local') {
    if (!data.mcpServers || typeof data.mcpServers !== 'object') data.mcpServers = {};
    data.mcpServers[entry.name] = entry.config;
    return;
  }
  if (!data.projects || typeof data.projects !== 'object') data.projects = {};
  if (!data.projects[entry.project] || typeof data.projects[entry.project] !== 'object') data.projects[entry.project] = {};
  const proj = data.projects[entry.project];
  if (!proj.mcpServers || typeof proj.mcpServers !== 'object') proj.mcpServers = {};
  proj.mcpServers[entry.name] = entry.config;
}

function copy({ from, to, servers, scope = 'user', project, force = false } = {}, { dryRun = true } = {}) {
  if (!from) throw mcpError('from is required');
  const dests = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!dests.length) throw mcpError('at least one destination is required');
  if (!['user', 'local', 'all'].includes(scope)) throw mcpError(`Unknown scope "${scope}". Use: user, local, all`);
  const source = resolveTarget(from);
  const entries = pickSources(source, { servers, scope, project });
  const lines = [];
  if (!entries.length) {
    lines.push(mline('same', 'mcp', `${source.name} has no matching MCP servers to copy`));
    return lines;
  }
  const targets = dests.map(resolveTarget);
  for (const t of targets) {
    if (t.kind === source.kind && t.file === source.file) throw mcpError(`${t.name} is the source; pick another destination.`);
  }
  if (targets.some((t) => t.kind === 'pool')) {
    const names = entries.map((e) => e.name);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) throw mcpError(`"${dup}" exists in more than one project; copy one with --project=PATH.`);
  }

  const tx = dryRun ? null : backup.begin(`mcp-copy-${source.name}`);
  let poolChanged = false;
  for (const t of targets) {
    const data = readData(t.file);
    const writes = [];
    for (const e of entries) {
      const at = where(t, e.scope, e.project);
      const existing = slotOf(data, e, t.kind)[e.name];
      if (existing !== undefined && sameConfig(existing, e.config)) {
        lines.push(mline('same', e.name, `${at}: already has it`));
      } else if (existing !== undefined && !force) {
        lines.push(mline('warn', e.name, `${at}: has a different "${e.name}" — not replaced (use --force)`, { code: 'conflict' }));
      } else {
        const verb = existing !== undefined ? (dryRun ? 'replace in' : 'replaced in') : (dryRun ? 'copy to' : 'copied to');
        lines.push(mline('change', e.name, `${verb} ${at}`));
        writes.push(e);
      }
    }
    if (!dryRun && writes.length) {
      tx.writeJson(t.file, (d) => {
        for (const e of writes) put(d, e, t.kind);
        return d;
      });
      if (t.kind === 'pool') poolChanged = true;
    }
  }
  if (dryRun && targets.some((t) => t.kind === 'pool') && lines.some((l) => l.kind === 'change')) {
    lines.push(mline('info', 'pool', 'profiles that share mcp.json get the pool\'s servers right after'));
  }
  if (poolChanged) lines.push(...sync({}, { dryRun: false, tx }).filter((l) => l.kind !== 'same'));
  if (tx) finishTx(tx, lines);
  return lines;
}

function finishTx(tx, lines) {
  const id = tx.done();
  if (id) lines.push(mline('info', 'backup', `previous files saved — undo with: cchost restore ${id}`, { backup: id }));
}

// --- remove ------------------------------------------------------------------

function remove({ target: name, server, scope = 'user', project } = {}, { dryRun = true } = {}) {
  if (!name || !server) throw mcpError('target and server are required');
  const target = resolveTarget(name);
  const want = project ? path.resolve(project) : null;
  const matches = readServers(target).filter((s) => s.name === server
    && (target.kind === 'pool' || scope === 'all' || s.scope === scope)
    && (!want || s.scope !== 'local' || s.project === want));
  if (!matches.length) throw mcpError(`${target.name} has no MCP server "${server}"${scope === 'local' ? ' in local scope' : ''}.`, 404);
  const lines = matches.map((m) => mline('change', server, `${dryRun ? 'remove from' : 'removed from'} ${where(target, m.scope, m.project)}`));
  if (dryRun) {
    if (target.kind === 'pool') lines.push(mline('info', 'pool', 'its synced copies are removed from profiles that share mcp.json'));
    return lines;
  }
  const tx = backup.begin(`mcp-remove-${server}`);
  tx.writeJson(target.file, (d) => {
    for (const m of matches) {
      if (target.kind === 'pool' || m.scope === 'user') delete d.mcpServers[server];
      else delete d.projects[m.project].mcpServers[server];
    }
    return d;
  });
  if (target.kind === 'profile') dropManaged(tx, target, [server]);
  if (target.kind === 'pool') lines.push(...sync({}, { dryRun: false, tx }).filter((l) => l.kind !== 'same'));
  finishTx(tx, lines);
  return lines;
}

function dropManaged(tx, target, names) {
  const managed = readManaged(target.configDir);
  if (!names.some((n) => n in managed)) return;
  tx.writeJson(path.join(target.configDir, MANAGED_FILE), (d) => {
    for (const n of names) if (d.servers) delete d.servers[n];
    return d;
  });
}

// --- sync --------------------------------------------------------------------

function planSync(target, pool) {
  const data = readData(target.file);
  const current = serversOf(data);
  const managed = readManaged(target.configDir);
  const ops = [];
  for (const [name, config] of Object.entries(pool)) {
    const cur = current[name];
    if (cur === undefined) ops.push({ op: 'add', name, config });
    else if (sameConfig(cur, config)) ops.push({ op: 'same', name, config });
    else if (name in managed && managed[name] === stable(cur)) ops.push({ op: 'update', name, config });
    else ops.push({ op: 'conflict', name });
  }
  for (const name of Object.keys(managed)) {
    if (name in pool) continue;
    const cur = current[name];
    if (cur === undefined) ops.push({ op: 'forget', name });
    else if (managed[name] === stable(cur)) ops.push({ op: 'drop', name });
    else ops.push({ op: 'keep-edited', name });
  }
  return ops;
}

function syncLine(target, o, dryRun) {
  const at = target.name;
  switch (o.op) {
    case 'add': return mline('change', o.name, `${dryRun ? 'add to' : 'added to'} ${at} from the pool`);
    case 'update': return mline('change', o.name, `${dryRun ? 'update in' : 'updated in'} ${at} to match the pool`);
    case 'drop': return mline('change', o.name, `${dryRun ? 'remove from' : 'removed from'} ${at} (no longer in the pool)`);
    case 'conflict': return mline('warn', o.name, `${at} has its own "${o.name}" — kept, not synced`, { code: 'conflict' });
    case 'keep-edited': return mline('warn', o.name, `${at}: no longer in the pool but edited here — kept`);
    default: return null;
  }
}

// Sync pool servers into subscribed profiles. With `profiles`, only those.
function sync({ profiles: names } = {}, { dryRun = true, tx: outer = null } = {}) {
  const pool = serversOf(readData(poolFile()));
  let targets;
  const lines = [];
  if (names && names.length) {
    targets = [];
    for (const n of names) {
      const t = resolveTarget(n);
      if (t.kind === 'pool') throw mcpError('sync writes the pool into profiles; name profiles, not "pool".');
      if (!isSubscribed(t)) {
        lines.push(mline('warn', t.name, 'keeps its own mcp.json, so it does not get the pool\'s servers (cchost link --config to share)'));
        continue;
      }
      targets.push(t);
    }
  } else {
    targets = subscribers();
  }
  const tx = dryRun ? null : outer || backup.begin('mcp-sync');
  for (const t of targets) {
    const ops = planSync(t, pool);
    const changes = ops.filter((o) => ['add', 'update', 'drop'].includes(o.op));
    const shown = ops.map((o) => syncLine(t, o, dryRun)).filter(Boolean);
    if (!shown.length) lines.push(mline('same', t.name, Object.keys(pool).length ? 'in sync with the pool' : 'pool has no MCP servers'));
    lines.push(...shown);
    const bookkeeping = ops.some((o) => o.op === 'forget' || o.op === 'keep-edited');
    if (dryRun || (!changes.length && !bookkeeping)) continue;
    if (changes.length) {
      tx.writeJson(t.file, (d) => {
        if (!d.mcpServers || typeof d.mcpServers !== 'object') d.mcpServers = {};
        for (const o of changes) {
          if (o.op === 'drop') delete d.mcpServers[o.name];
          else d.mcpServers[o.name] = o.config;
        }
        return d;
      });
    }
    tx.writeJson(path.join(t.configDir, MANAGED_FILE), (d) => {
      const servers = d.servers && typeof d.servers === 'object' ? d.servers : {};
      for (const o of ops) {
        if (o.op === 'add' || o.op === 'update') servers[o.name] = stable(o.config);
        if (o.op === 'drop' || o.op === 'forget' || o.op === 'keep-edited') delete servers[o.name];
      }
      return { servers };
    });
  }
  if (tx && !outer) finishTx(tx, lines);
  return lines;
}

// Subscribed profiles whose user scope doesn't match the pool.
function drift() {
  const pool = serversOf(readData(poolFile()));
  const out = [];
  for (const t of subscribers()) {
    const ops = planSync(t, pool).filter((o) => ['add', 'update', 'drop'].includes(o.op));
    if (ops.length) out.push({ profile: t.name, servers: ops.map((o) => o.name) });
  }
  return out;
}

// True when the pool file holds env/header values and is readable by others.
function poolExposed() {
  if (process.platform === 'win32') return false;
  let st;
  try {
    st = fs.statSync(poolFile());
  } catch {
    return false;
  }
  if ((st.mode & 0o077) === 0) return false;
  return Object.values(serversOf(readData(poolFile()))).some((c) => keysOf(c && c.env).length || keysOf(c && c.headers).length);
}

module.exports = {
  poolFile,
  resolveTarget,
  readServers,
  publicView,
  maskArgs,
  maskUrl,
  describe,
  listAll,
  copy,
  remove,
  sync,
  drift,
  poolExposed,
  subscribers,
  MANAGED_FILE,
};
