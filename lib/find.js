'use strict';

// Search across every profile's conversations. Claude Code keeps sessions as
// projects/<encoded cwd>/<id>.jsonl; the text worth searching (what the person
// typed, what Claude answered) is under 1% of those files, so the index is a
// per-session extract of just that, stored per account:
//   ~/.claude-profiles/<profile>/.cchost-index/<id>.json
//   ~/.claude/.cchost-index/<id>.json            (the existing account)
//   ~/.claude-profiles/.cchost-index/unknown/     (no account recorded it)
// Tool calls, tool results, attachments and hook output are never read into
// it. Which account a session belongs to comes from each profile's own
// history.jsonl. Everything here runs inside a scope (lib/pins.js): a scoped
// refresh never opens a session file outside the scope.

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const profiles = require('./profiles');
const pins = require('./pins');
const errors = require('./errors');
const paths = require('./paths');

const INDEX_DIR = '.cchost-index';
const FORMAT = 2;
const MAX_BLOCK = 20000;
const HEAD_BYTES = 65536;
const SKIP_PROMPT = /^\s*<(command-name|command-message|local-command|system-reminder|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook|ide_|task-notification)/;

function encode(p) {
  return String(p).replace(/[^a-zA-Z0-9]/g, '-');
}

// --- where sessions and extracts live ------------------------------------------

function sources() {
  const out = [{ kind: 'pool', dir: path.join(profiles.defaultClaudeDir(), 'projects') }];
  for (const p of profiles.listProfiles()) {
    if (p.alias) continue;
    const dir = path.join(p.dir, 'projects');
    try {
      if (!fs.lstatSync(dir).isSymbolicLink() && fs.statSync(dir).isDirectory()) out.push({ kind: 'profile', name: p.name, dir });
    } catch { /* no private history */ }
  }
  return out;
}

function accountNames() {
  return profiles.listProfiles().map((p) => p.name);
}

function indexDirFor(account) {
  if (!account) return path.join(profiles.baseDir(), INDEX_DIR, 'unknown');
  const p = profiles.resolveProfile(account);
  return path.join(p.dir, INDEX_DIR);
}

function historyFileFor(account) {
  return path.join(profiles.resolveProfile(account).dir, 'history.jsonl');
}

// sessionId -> { account: lastTimestampMs } for the wanted accounts.
function attribution(wanted) {
  const map = new Map();
  for (const name of wanted) {
    let raw;
    try {
      raw = fs.readFileSync(historyFileFor(name), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (!o || typeof o.sessionId !== 'string') continue;
      const cur = map.get(o.sessionId) || {};
      cur[name] = Math.max(cur[name] || 0, Number(o.timestamp) || 0);
      map.set(o.sessionId, cur);
    }
  }
  return map;
}

// --- reading one session ---------------------------------------------------------

function headCwd(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const text = buf.toString('utf8', 0, n);
    for (const line of text.split('\n')) {
      if (!line.includes('"cwd"')) continue;
      try {
        const o = JSON.parse(line);
        if (typeof o.cwd === 'string') return o.cwd;
      } catch { /* partial last line */ }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function textOf(content, { prompt }) {
  if (typeof content === 'string') return prompt && SKIP_PROMPT.test(content) ? [] : [content];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      if (!(prompt && SKIP_PROMPT.test(b.text))) out.push(b.text);
    }
  }
  return out;
}

async function extract(file, id) {
  const rec = { v: FORMAT, id, file, cwd: null, branch: null, title: null, started: null, lastSeen: null, prompts: [], replies: [] };
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object') continue;
    if (o.type === 'summary' && typeof o.summary === 'string' && !rec.title) {
      rec.title = o.summary.slice(0, 200);
      continue;
    }
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    if (o.isSidechain || o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly) continue;
    if (!rec.cwd && typeof o.cwd === 'string') rec.cwd = o.cwd;
    if (!rec.branch && typeof o.gitBranch === 'string') rec.branch = o.gitBranch;
    if (typeof o.timestamp === 'string') {
      if (!rec.started) rec.started = o.timestamp;
      rec.lastSeen = o.timestamp;
    }
    const content = o.message && o.message.content;
    const list = o.type === 'user' ? rec.prompts : rec.replies;
    for (const text of textOf(content, { prompt: o.type === 'user' })) {
      list.push({ t: o.timestamp || null, text: text.length > MAX_BLOCK ? text.slice(0, MAX_BLOCK) : text });
    }
  }
  if (!rec.title && rec.prompts.length) rec.title = rec.prompts[0].text.replace(/\s+/g, ' ').slice(0, 120);
  return rec;
}

// --- the index ----------------------------------------------------------------------

function readExtract(dir, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function writeExtract(dir, rec) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${rec.id}.json`);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function listExtracts(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const rec = readExtract(dir, n.slice(0, -5));
    if (rec && rec.id) out.push(rec);
  }
  return out;
}

function sessionFiles(src, root) {
  const fold = (x) => (paths.CASE_INSENSITIVE ? x.toLowerCase() : x);
  const prefixes = root ? paths.spellings(root).map((r) => fold(encode(r))) : null;
  let dirs;
  try {
    dirs = fs.readdirSync(src.dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const name = fold(d.name);
    if (prefixes && !prefixes.some((p) => name === p || name.startsWith(`${p}-`))) continue;
    const dir = path.join(src.dir, d.name);
    let files;
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.isFile() && f.name.endsWith('.jsonl')) out.push({ file: path.join(dir, f.name), id: f.name.slice(0, -6), source: src });
    }
  }
  return out;
}

// Accounts a scope may see: its own list, or every account plus "unknown" (null).
function accountsOf(scope) {
  if (scope.profiles === null) return [...accountNames(), null];
  return scope.profiles.slice();
}

const realCache = new Map();
function inRoot(cwd, root) {
  if (!root) return true;
  if (typeof cwd !== 'string') return false;
  const k = `${cwd}\0${root}`;
  if (!realCache.has(k)) realCache.set(k, paths.isUnderReal(cwd, root));
  return realCache.get(k);
}

// Bring the extracts for `scope` up to date. Only files that may be in scope
// are opened: the project folder's encoded name must match, the first lines'
// cwd must sit under the root, and (with an account boundary) the session must
// be recorded in one of those accounts' history.
async function refresh(scope, { prune = false } = {}) {
  const accounts = accountsOf(scope);
  const named = accounts.filter(Boolean);
  const attr = attribution(named);
  const stats = { seen: 0, indexed: 0, unchanged: 0, skipped: 0, pruned: 0 };
  const kept = new Set();
  for (const src of sources()) {
    const ownerOnly = src.kind === 'profile' ? src.name : null;
    for (const s of sessionFiles(src, scope.root)) {
      stats.seen++;
      let owners = Object.keys(attr.get(s.id) || {});
      if (ownerOnly) owners = named.includes(ownerOnly) ? [ownerOnly] : [];
      if (!owners.length) {
        if (scope.profiles !== null) { stats.skipped++; continue; }
        owners = [null];
      }
      let st;
      try {
        st = fs.statSync(s.file);
      } catch {
        continue;
      }
      const targets = owners.map(indexDirFor);
      const existing = targets.map((d) => readExtract(d, s.id));
      const current = (r) => r && r.v === FORMAT && r.size === st.size && r.mtimeMs === st.mtimeMs;
      const known = attr.get(s.id) || {};
      if (existing.every(current)) {
        if (!inRoot(existing[0].cwd, scope.root)) { stats.skipped++; continue; }
        existing.forEach((r, i) => {
          const merged = { ...(r.accounts || {}), ...known };
          if (JSON.stringify(merged) !== JSON.stringify(r.accounts || {})) writeExtract(targets[i], { ...r, accounts: merged });
          kept.add(path.join(targets[i], `${s.id}.json`));
        });
        stats.unchanged++;
        continue;
      }
      const cwd = headCwd(s.file);
      if (scope.root && cwd && !inRoot(cwd, scope.root)) { stats.skipped++; continue; }
      const base = existing.find(current);
      const rec = base || await extract(s.file, s.id);
      if (!inRoot(rec.cwd, scope.root)) { stats.skipped++; continue; }
      rec.size = st.size;
      rec.mtimeMs = st.mtimeMs;
      rec.accounts = { ...(base && base.accounts) || {}, ...known };
      for (const d of targets) {
        writeExtract(d, rec);
        kept.add(path.join(d, `${s.id}.json`));
      }
      stats.indexed++;
    }
  }
  if (prune && scope.profiles === null && !scope.root) {
    for (const a of accounts) {
      const dir = indexDirFor(a);
      for (const rec of listExtracts(dir)) {
        const file = path.join(dir, `${rec.id}.json`);
        if (kept.has(file)) continue;
        try {
          fs.unlinkSync(file);
          stats.pruned++;
        } catch { /* already gone */ }
      }
    }
  }
  return stats;
}

// --- searching ------------------------------------------------------------------------

function parseQuery(q) {
  const terms = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(q))) terms.push((m[1] || m[2]).toLowerCase());
  if (!terms.length) throw errors.usage('Give me something to search for.');
  return terms;
}

function parseSince(v) {
  if (!v) return 0;
  const m = /^(\d+)([hdwm])$/.exec(v);
  if (m) {
    const unit = { h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3 }[m[2]];
    return Date.now() - Number(m[1]) * unit;
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw errors.usage(`--since wants 12h, 30d, 2w, 6m or a date, not "${v}"`);
  return t;
}

function snippet(text, term, width = 160) {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(term);
  if (at < 0) return flat.slice(0, width);
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

function profileList(v) {
  if (v === undefined || v === null || v === '') return [];
  const list = (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean);
  for (const name of list) profiles.validateProfileName(name);
  return [...new Set(list)];
}

function loadScope(scope, { profile, project } = {}) {
  let accounts = accountsOf(scope);
  const wanted = profileList(profile);
  if (wanted.length) {
    const outside = scope.profiles === null ? [] : wanted.filter((p) => !scope.profiles.includes(p));
    if (outside.length) {
      throw errors.refused(`${outside.map((p) => `"${p}"`).join(', ')} ${outside.length === 1 ? 'is' : 'are'} outside this folder's scope (${scope.profiles.join(', ')}). Add --global to search everything.`);
    }
    const known = new Set(accountNames());
    const unknown = wanted.filter((p) => !known.has(p));
    if (unknown.length) throw errors.refused(`No profile named ${unknown.map((p) => `"${p}"`).join(', ')}.`);
    accounts = wanted;
  }
  let root = scope.root;
  if (project) {
    const p = paths.realpath(project);
    if (root && !paths.isUnderReal(p, root)) throw errors.refused(`${paths.shortPath(p)} is outside this folder's scope (${paths.shortPath(root)}). Add --global to search everything.`);
    root = p;
  }
  const seen = new Set();
  const records = [];
  for (const a of accounts) {
    for (const rec of listExtracts(indexDirFor(a))) {
      if (!inRoot(rec.cwd, root)) continue;
      if (seen.has(rec.id)) continue;
      seen.add(rec.id);
      records.push(rec);
    }
  }
  return { accounts, root, records };
}

function describeScope(scope, accounts, root) {
  const where = root ? `${paths.shortPath(root)} and subfolders` : 'every folder';
  const who = scope.profiles === null && accounts.includes(null) ? 'every account' : `account ${accounts.filter(Boolean).join(', ') || 'none'}`;
  return `${where} · ${who}`;
}

function search(scope, query, { profile, project, since, limit = 20 } = {}) {
  const terms = parseQuery(query);
  const after = parseSince(since);
  const { accounts, root, records } = loadScope(scope, { profile, project });
  const hits = [];
  for (const rec of records) {
    if (after && Date.parse(rec.lastSeen || 0) < after) continue;
    let best = null;
    for (const [where, list] of [['prompt', rec.prompts], ['reply', rec.replies]]) {
      for (const b of list) {
        const low = b.text.toLowerCase();
        if (!terms.every((t) => low.includes(t))) continue;
        best = { where, snippet: snippet(b.text, terms[0]), t: b.t };
        break;
      }
      if (best) break;
    }
    if (!best) continue;
    hits.push({
      id: rec.id,
      title: rec.title,
      cwd: rec.cwd,
      short: rec.cwd ? paths.shortPath(rec.cwd) : null,
      branch: rec.branch,
      accounts: Object.keys(rec.accounts || {}),
      lastSeen: rec.lastSeen,
      ...best,
    });
  }
  hits.sort((a, b) => (a.where === b.where ? Date.parse(b.lastSeen || 0) - Date.parse(a.lastSeen || 0) : a.where === 'prompt' ? -1 : 1));
  return {
    scope: { root, accounts: accounts.map((a) => a || 'unknown'), source: scope.source, text: describeScope(scope, accounts, root) },
    query: terms,
    sessions: records.length,
    total: hits.length,
    results: hits.slice(0, limit),
  };
}

// The newest conversations in the scope, for `cchost open` without an id.
function recent(scope, { profile, limit = 10 } = {}) {
  const { accounts, root, records } = loadScope(scope, { profile });
  const list = records
    .filter((r) => r.prompts.length)
    .sort((a, b) => Date.parse(b.lastSeen || 0) - Date.parse(a.lastSeen || 0))
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      title: r.title,
      short: r.cwd ? paths.shortPath(r.cwd) : null,
      branch: r.branch,
      accounts: Object.keys(r.accounts || {}),
      lastSeen: r.lastSeen,
      last: r.prompts[r.prompts.length - 1].text.replace(/\s+/g, ' ').slice(0, 160),
    }));
  return { scope: { root, accounts: accounts.map((a) => a || 'unknown'), source: scope.source, text: describeScope(scope, accounts, root) }, results: list };
}

// Which session and account `cchost open <prefix>` means, inside the scope.
function resolveOpen(scope, prefix, { profile } = {}) {
  if (profileList(profile).length > 1) throw errors.usage('open takes one --profile.');
  if (!/^[0-9a-f-]{4,}$/i.test(prefix || '')) {
    throw errors.usage(`"${prefix || ''}" is not a session id. Use the first 4 or more characters of one from cchost find, like 4f57687c.`);
  }
  const { records } = loadScope(scope, { profile });
  const matches = records.filter((r) => r.id.toLowerCase().startsWith(prefix.toLowerCase()));
  if (!matches.length) throw errors.refused(`No session starting with "${prefix}" in this scope. Search first: cchost find <words>`);
  if (matches.length > 1) throw errors.refused(`"${prefix}" matches ${matches.length} sessions here; give more characters: ${matches.map((m) => m.id.slice(0, 12)).join(', ')}`);
  const rec = matches[0];
  let account = profile || null;
  if (!account && scope.profiles && scope.profiles.length === 1) account = scope.profiles[0];
  if (!account) {
    const ranked = Object.entries(rec.accounts || {}).sort((a, b) => b[1] - a[1]);
    account = ranked.length ? ranked[0][0] : profiles.getAlias();
  }
  if (!account) throw errors.refused(`No account is recorded for session ${rec.id.slice(0, 8)}. Pick one: cchost open ${prefix} --profile=<name>`);
  return { id: rec.id, cwd: rec.cwd, account, title: rec.title };
}

function indexSummary() {
  const out = [];
  for (const a of [...accountNames(), null]) {
    const dir = indexDirFor(a);
    let count = 0;
    let bytes = 0;
    try {
      for (const n of fs.readdirSync(dir)) {
        if (!n.endsWith('.json')) continue;
        count++;
        bytes += fs.statSync(path.join(dir, n)).size;
      }
    } catch { /* none yet */ }
    out.push({ account: a || 'unknown', dir: paths.shortPath(dir), sessions: count, bytes });
  }
  return out;
}

function removeIndex(account) {
  fs.rmSync(indexDirFor(account), { recursive: true, force: true });
}

module.exports = {
  encode,
  indexDirFor,
  attribution,
  refresh,
  search,
  resolveOpen,
  recent,
  indexSummary,
  removeIndex,
  parseQuery,
};
