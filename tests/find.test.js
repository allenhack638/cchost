import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import cli from '../lib/cli.js';
import pins from '../lib/pins.js';
import find from '../lib/find.js';

const SECRET = 'sk-SENTINEL-find-0123456789abcdef';
const OAUTH = 'oauth-SENTINEL-refresh-zz99';

let home;
let realHomedir;
let realCwd;
let out;
let realWrite;
let realLog;
let realErr;
let cwd;
let ttyIn;
let ttyOut;

async function run(...args) {
  out = '';
  const code = await cli.run(args);
  return { code, out };
}
const json = async (...args) => {
  const r = await run(...args);
  return { code: r.code, out: r.out, data: JSON.parse(r.out) };
};
const mk = (...p) => {
  const d = path.join(home, ...p);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const tty = (on) => {
  process.stdin.isTTY = on;
  process.stdout.isTTY = on;
};

let clock;
function session({ id, cwd: sessCwd, accounts = [], prompts = [], replies = [], summary, source = 'pool', extras = [] }) {
  const base = source === 'pool' ? path.join(home, '.claude', 'projects') : path.join(home, '.claude-profiles', source, 'projects');
  const dir = path.join(base, find.encode(sessCwd));
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  const ts = () => new Date((clock += 60000)).toISOString();
  if (summary) lines.push({ type: 'summary', summary, leafUuid: 'x' });
  lines.push({ type: 'last-prompt', leafUuid: 'x', sessionId: id });
  for (let i = 0; i < Math.max(prompts.length, replies.length); i++) {
    if (prompts[i] !== undefined) lines.push({ type: 'user', cwd: sessCwd, gitBranch: 'main', sessionId: id, timestamp: ts(), message: { role: 'user', content: prompts[i] } });
    lines.push({ type: 'assistant', cwd: sessCwd, sessionId: id, timestamp: ts(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: `echo ${SECRET}` } }] } });
    lines.push({ type: 'user', cwd: sessCwd, sessionId: id, timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `output ${SECRET} ${OAUTH}` }] } });
    if (replies[i] !== undefined) lines.push({ type: 'assistant', cwd: sessCwd, sessionId: id, timestamp: ts(), message: { role: 'assistant', content: [{ type: 'thinking', thinking: `hidden ${SECRET}` }, { type: 'text', text: replies[i] }] } });
  }
  lines.push(...extras);
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  accounts.forEach((a, i) => {
    const hdir = a === 'me' ? path.join(home, '.claude') : path.join(home, '.claude-profiles', a);
    fs.appendFileSync(path.join(hdir, 'history.jsonl'), `${JSON.stringify({ display: prompts[0] || '', pastedContents: {}, timestamp: clock + i, project: sessCwd, sessionId: id })}\n`);
  });
  return path.join(dir, `${id}.jsonl`);
}

let projA;
let projB;
let A1;
let A2;
let B1;
let U1;

beforeEach(async () => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-find-')));
  clock = Date.parse('2026-11-01T00:00:00Z');
  realHomedir = os.homedir;
  os.homedir = () => home;
  realCwd = process.cwd;
  cwd = home;
  process.cwd = () => cwd;
  realWrite = process.stdout.write;
  realLog = console.log;
  realErr = process.stderr.write;
  process.stdout.write = (s) => { out += s; return true; };
  console.log = (...a) => { out += `${a.join(' ')}\n`; };
  process.stderr.write = () => true;
  ttyIn = process.stdin.isTTY;
  ttyOut = process.stdout.isTTY;
  tty(false);
  mk('.claude');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } }));
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { refreshToken: OAUTH } }));
  mk('.claude-profiles', 'work');
  mk('.claude-profiles', 'p1');
  fs.writeFileSync(path.join(home, '.claude-profiles', 'work', '.cc-env.json'), JSON.stringify({ auth_token: SECRET, base_url: 'https://x.example' }));
  projA = mk('src', 'proj-a');
  mk('src', 'proj-a', 'sub');
  projB = mk('src', 'proj-b');
  A1 = session({ id: 'aaaa1111-0000-0000-0000-000000000001', cwd: projA, accounts: ['work'], prompts: ['fix the redis cache bug', 'now add tests'], replies: ['The redis bug is in client.js', 'Added tests'], summary: 'Redis cache fix' });
  A2 = session({ id: 'aaaa2222-0000-0000-0000-000000000002', cwd: path.join(projA, 'sub'), accounts: ['p1'], prompts: ['stripe webhook retries'], replies: ['Use idempotency keys'] });
  B1 = session({ id: 'bbbb1111-0000-0000-0000-000000000003', cwd: projB, accounts: ['p1', 'work'], prompts: ['presage launch plan redis'], replies: ['Here is the plan'] });
  U1 = session({ id: 'cccc1111-0000-0000-0000-000000000004', cwd: projB, accounts: [], prompts: ['orphan session about redis'], replies: ['ok'] });
});

afterEach(() => {
  os.homedir = realHomedir;
  process.cwd = realCwd;
  process.stdout.write = realWrite;
  console.log = realLog;
  process.stderr.write = realErr;
  process.stdin.isTTY = ttyIn;
  process.stdout.isTTY = ttyOut;
  fs.rmSync(home, { recursive: true, force: true });
});

const indexFiles = () => {
  const found = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (p.includes('.cchost-index')) found.push(p);
    }
  };
  walk(home);
  return found;
};
const noSecrets = (text) => {
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(OAUTH);
};

describe('find — scope', () => {
  it('inside a pinned folder sees only that folder under that account, and indexes nothing else', async () => {
    pins.pin('work', projA);
    cwd = path.join(projA, 'sub');
    const r = await json('find', 'redis', '--json');
    expect(r.code).toBe(0);
    expect(r.data.scope).toMatchObject({ root: projA, accounts: ['work'], source: 'pin' });
    expect(r.data.results.map((x) => x.id)).toEqual([A1.split('/').pop().slice(0, -6)]);
    expect(r.data.results[0]).toMatchObject({ where: 'prompt', accounts: ['work'], title: 'Redis cache fix', branch: 'main' });
    expect(r.data.results[0].snippet).toContain('redis cache bug');
    const files = indexFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toContain(path.join('.claude-profiles', 'work', '.cchost-index'));
    for (const f of files) noSecrets(fs.readFileSync(f, 'utf8'));
    noSecrets(r.out);
    const text = await run('find', 'redis');
    expect(text.out).toContain(`scope: ${path.join('~', 'src', 'proj-a')} and subfolders · account work`);
    expect(text.out).toContain('aaaa1111');
    expect(text.out).not.toContain('presage');
    noSecrets(text.out);
  });

  it('a plain project folder sees every account in that folder, never other folders', async () => {
    cwd = projB;
    const r = await json('find', 'redis', '--json');
    expect(r.data.scope).toMatchObject({ root: projB, source: 'cwd' });
    expect(r.data.scope.accounts).toEqual(['p1', 'work', 'unknown']);
    expect(r.data.results.map((x) => x.id.slice(0, 4)).sort()).toEqual(['bbbb', 'cccc']);
    expect(r.data.results.find((x) => x.id.startsWith('bbbb')).accounts.sort()).toEqual(['p1', 'work']);
    expect(r.data.results.find((x) => x.id.startsWith('cccc')).accounts).toEqual([]);
    expect(indexFiles().some((f) => f.includes('proj-a') || f.includes('aaaa'))).toBe(false);
  });

  it('an unconfirmed .cchost file narrows the account immediately', async () => {
    fs.writeFileSync(path.join(projB, '.cchost'), 'p1\n');
    cwd = projB;
    const r = await json('find', 'redis', '--json');
    expect(r.data.scope).toMatchObject({ accounts: ['p1'], source: 'file' });
    expect(r.data.results.map((x) => x.id.slice(0, 4))).toEqual(['bbbb']);
    expect(indexFiles().every((f) => f.includes(path.join('p1', '.cchost-index')))).toBe(true);
  });

  it('refuses to run from home or above, with --json too', async () => {
    cwd = home;
    const r = await json('find', 'redis', '--json');
    expect(r.code).toBe(1);
    expect(r.data.error).toContain('No search scope');
    await expect(run('find', 'redis')).rejects.toThrow(/No search scope/);
    expect(indexFiles()).toEqual([]);
  });

  it('--global needs a terminal; with one it sees everything, including unattributed sessions', async () => {
    cwd = projA;
    await expect(run('find', 'redis', '--global')).rejects.toMatchObject({ exitCode: 2 });
    expect(indexFiles()).toEqual([]);
    tty(true);
    const r = await json('find', 'redis', '--global', '--json');
    expect(r.data.scope).toMatchObject({ root: null, source: 'global' });
    expect(r.data.results.map((x) => x.id.slice(0, 4)).sort()).toEqual(['aaaa', 'bbbb', 'cccc']);
    const files = indexFiles();
    expect(files.filter((f) => f.includes(path.join('.claude-profiles', '.cchost-index', 'unknown')))).toHaveLength(1);
    expect(files.filter((f) => f.includes(path.join('work', '.cchost-index')))).toHaveLength(2);
    expect(files.filter((f) => f.includes(path.join('p1', '.cchost-index')))).toHaveLength(2);
    for (const f of files) noSecrets(fs.readFileSync(f, 'utf8'));
    noSecrets(r.out);
  });

  it('--profile and --project narrow a scope but never widen it', async () => {
    pins.pin('work', projA);
    cwd = projA;
    const outside = await json('find', 'redis', '--profile=p1', '--json');
    expect(outside.code).toBe(1);
    expect(outside.data.error).toContain('outside this folder');
    const far = await json('find', 'redis', `--project=${projB}`, '--json');
    expect(far.code).toBe(1);
    expect(far.data.error).toContain('outside this folder');
    const near = await json('find', 'redis', `--project=${path.join(projA, 'sub')}`, '--json');
    expect(near.data.results).toEqual([]);
    cwd = projB;
    const narrowed = await json('find', 'redis', '--profile=p1', '--json');
    expect(narrowed.data.scope.accounts).toEqual(['p1']);
    expect(narrowed.data.results.map((x) => x.id.slice(0, 4))).toEqual(['bbbb']);
    tty(true);
    const all = await json('find', 'redis', '--global', '--profile=p1', '--json');
    expect(all.data.results.map((x) => x.id.slice(0, 4)).sort()).toEqual(['bbbb']);
  });

  it('a sibling folder whose encoded name shares the prefix is not in scope', async () => {
    const lookalike = mk('src', 'proj-a-old');
    session({ id: 'dddd1111-0000-0000-0000-000000000005', cwd: lookalike, accounts: ['work'], prompts: ['redis in the old project'] });
    pins.pin('work', projA);
    cwd = projA;
    const r = await json('find', 'redis', '--json');
    expect(r.data.results.map((x) => x.id.slice(0, 4))).toEqual(['aaaa']);
    expect(indexFiles().some((f) => f.includes('dddd'))).toBe(false);
  });

  it('private (unlinked) history is indexed only for its own profile', async () => {
    session({ id: 'eeee1111-0000-0000-0000-000000000006', cwd: projA, source: 'p1', prompts: ['private redis notes'] });
    cwd = projA;
    const r = await json('find', 'redis', '--json');
    const priv = r.data.results.find((x) => x.id.startsWith('eeee'));
    expect(priv.accounts).toEqual([]);
    expect(indexFiles().filter((f) => f.includes('eeee')).every((f) => f.includes(path.join('p1', '.cchost-index')))).toBe(true);
    pins.pin('work', projA);
    const scoped = await json('find', 'redis', '--json');
    expect(scoped.data.results.some((x) => x.id.startsWith('eeee'))).toBe(false);
  });
});

describe('find — index content', () => {
  it('keeps prompts, replies, title and dates; drops tool calls, results, thinking, commands and sidechains', async () => {
    session({
      id: 'ffff1111-0000-0000-0000-000000000007', cwd: projA, accounts: ['work'],
      prompts: ['<command-name>/usage</command-name>', '<local-command-stdout>junk</local-command-stdout>', 'real question about kafka'],
      replies: ['real answer'],
      extras: [
        { type: 'user', isSidechain: true, cwd: projA, sessionId: 'f', timestamp: '2026-11-02T00:00:00Z', message: { role: 'user', content: 'subagent prompt kafka-side' } },
        { type: 'user', isMeta: true, cwd: projA, sessionId: 'f', timestamp: '2026-11-02T00:00:00Z', message: { role: 'user', content: 'meta kafka-meta' } },
        'not json',
      ],
    });
    cwd = projA;
    await json('find', 'kafka', '--json');
    const rec = JSON.parse(fs.readFileSync(indexFiles().find((f) => f.includes('ffff')), 'utf8'));
    expect(rec.prompts.map((p) => p.text)).toEqual(['real question about kafka']);
    expect(rec.replies.map((p) => p.text)).toEqual(['real answer']);
    expect(rec.title).toBe('real question about kafka');
    expect(rec.cwd).toBe(projA);
    expect(rec.started < rec.lastSeen).toBe(true);
    expect(rec.accounts).toEqual({ work: expect.any(Number) });
    expect(JSON.stringify(rec)).not.toMatch(/kafka-side|kafka-meta|tool_use|tool_result|thinking/);
    noSecrets(JSON.stringify(rec));
  });

  it('is incremental: unchanged files are not re-read, changed ones are, attribution merges', async () => {
    cwd = projA;
    const first = await find.refresh(pins.scope(projA));
    expect(first).toMatchObject({ indexed: 2, unchanged: 0, skipped: 0 });
    const again = await find.refresh(pins.scope(projA));
    expect(again).toMatchObject({ indexed: 0, unchanged: 2 });
    fs.appendFileSync(A1, `${JSON.stringify({ type: 'user', cwd: projA, sessionId: 'a', timestamp: '2026-11-03T00:00:00Z', message: { role: 'user', content: 'later: memcached instead' } })}\n`);
    const third = await find.refresh(pins.scope(projA));
    expect(third).toMatchObject({ indexed: 1, unchanged: 1 });
    expect((await json('find', 'memcached', '--json')).data.total).toBe(1);
    fs.appendFileSync(path.join(home, '.claude-profiles', 'p1', 'history.jsonl'), `${JSON.stringify({ display: 'x', timestamp: 1, project: projA, sessionId: 'aaaa1111-0000-0000-0000-000000000001' })}\n`);
    await find.refresh(pins.scope(projA));
    const r = await json('find', 'redis', '--json');
    expect(r.data.results.find((x) => x.id.startsWith('aaaa')).accounts.sort()).toEqual(['p1', 'work']);
  });

  it('index --global prunes extracts of deleted sessions and reports per-account sizes', async () => {
    tty(true);
    cwd = projA;
    const before = await json('index', '--global', '--json');
    expect(before.data).toMatchObject({ indexed: 4, pruned: 0 });
    expect(before.data.index.find((i) => i.account === 'unknown').sessions).toBe(1);
    fs.unlinkSync(U1);
    const after = await json('index', '--global', '--json');
    expect(after.data.pruned).toBe(1);
    expect(indexFiles().some((f) => f.includes('cccc'))).toBe(false);
    tty(false);
    const scoped = await json('index', '--json');
    expect(scoped.data.scope.source).toBe('cwd');
    await expect(run('index', '--global')).rejects.toMatchObject({ exitCode: 2 });
  });

  it.skipIf(process.platform === 'win32')('writes owner-only files and folders', async () => {
    cwd = projA;
    await json('find', 'redis', '--json');
    for (const f of indexFiles()) {
      expect(fs.statSync(f).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(f)).mode & 0o777).toBe(0o700);
    }
  });

  it('removing a profile removes its index; forgetting the existing account removes its index too', async () => {
    session({ id: '99991111-0000-0000-0000-000000000009', cwd: projA, accounts: ['me'], prompts: ['redis from the default account'] });
    await json('add', 'me', '--existing', '--json');
    cwd = projA;
    await json('find', 'redis', '--json');
    expect(fs.existsSync(path.join(home, '.claude', '.cchost-index'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.claude-profiles', 'work', '.cchost-index'))).toBe(true);
    const dry = await json('remove', 'me', '--dry-run', '--json');
    expect(dry.data.lines.some((l) => l.label === 'index')).toBe(true);
    await json('remove', 'me', '--yes', '--json');
    expect(fs.existsSync(path.join(home, '.claude', '.cchost-index'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.claude', 'projects'))).toBe(true);
    await json('remove', 'work', '--yes', '--json');
    expect(indexFiles().some((f) => f.includes(path.join('work', '.cchost-index')))).toBe(false);
  });
});

describe('find — query', () => {
  beforeEach(() => {
    cwd = projA;
    tty(true);
  });

  it('needs every word, honours quoted phrases, ranks prompts above replies, and limits', async () => {
    expect((await json('find', 'redis', 'tests', '--global', '--json')).data.total).toBe(0);
    expect((await json('find', 'redis', 'cache', '--global', '--json')).data.total).toBe(1);
    expect((await json('find', '"cache bug"', '--global', '--json')).data.total).toBe(1);
    expect((await json('find', '"bug cache"', '--global', '--json')).data.total).toBe(0);
    const r = await json('find', 'REDIS', '--global', '--json');
    expect(r.data.results.every((x, i, a) => i === 0 || a[i - 1].where !== 'reply' || x.where === 'reply')).toBe(true);
    const lim = await json('find', 'redis', '--global', '-n=1', '--json');
    expect(lim.data.results).toHaveLength(1);
    expect(lim.data.total).toBe(3);
    expect((await run('find', 'redis', '--global', '-n=1')).out).toContain('showing 1');
    const reply = await json('find', 'idempotency', '--global', '--json');
    expect(reply.data.results[0]).toMatchObject({ where: 'reply' });
    expect((await run('find', 'idempotency', '--global')).out).toContain('claude: Use idempotency keys');
  });

  it('--since filters by last activity and rejects nonsense', async () => {
    expect((await json('find', 'redis', '--global', '--since=2026-11-01T00:10:00Z', '--json')).data.total).toBe(2);
    expect((await json('find', 'redis', '--global', '--since=1h', '--json')).data.total).toBe(0);
    await expect(run('find', 'redis', '--since=soon')).rejects.toMatchObject({ exitCode: 2 });
    await expect(run('find')).rejects.toMatchObject({ exitCode: 2 });
    await expect(run('find', 'x', '-n=0')).rejects.toMatchObject({ exitCode: 2 });
    await expect(run('find', 'x', '--bogus')).rejects.toMatchObject({ exitCode: 2 });
    expect(() => find.parseQuery('  ')).toThrow(/something to search/);
  });

  it('says how to widen only when a terminal could', async () => {
    tty(false);
    expect((await run('find', 'nothing-matches')).out).not.toContain('--global');
    tty(true);
    expect((await run('find', 'nothing-matches')).out).toContain('add --global');
  });
});

describe('open — resolution', () => {
  it('resolves only inside the scope and picks the account that owns the session', async () => {
    pins.pin('work', projA);
    await find.refresh(pins.scope(projA));
    const s = pins.scope(projA);
    expect(find.resolveOpen(s, 'aaaa1111')).toMatchObject({ id: expect.stringMatching(/^aaaa1111/), account: 'work', cwd: projA });
    expect(() => find.resolveOpen(s, 'bbbb')).toThrow(/No session starting with "bbbb" in this scope/);
    expect(() => find.resolveOpen(s, 'aaaa2222')).toThrow(/No session/);
    expect(() => find.resolveOpen(s, 'zz')).toThrow(/first 4\+ characters/);
    tty(true);
    const g = { root: null, profiles: null, source: 'global', confirmed: true };
    await find.refresh(g);
    expect(() => find.resolveOpen(g, 'aaaa')).toThrow(/matches 2 sessions/);
    expect(find.resolveOpen(g, 'bbbb').account).toBe('work');
    expect(find.resolveOpen(g, 'aaaa2222').account).toBe('p1');
    expect(find.resolveOpen(g, 'bbbb', { profile: 'p1' }).account).toBe('p1');
    expect(() => find.resolveOpen(g, 'cccc')).toThrow(/No account is recorded/);
    await json('add', 'me', '--existing', '--json');
    expect(find.resolveOpen(g, 'cccc').account).toBe('me');
  });

  it('open from the CLI refuses outside the scope before anything launches', async () => {
    pins.pin('work', projA);
    cwd = projA;
    await expect(run('open', 'bbbb')).rejects.toThrow(/in this scope/);
    await expect(run('open')).rejects.toMatchObject({ exitCode: 2 });
    cwd = home;
    await expect(run('open', 'aaaa1111')).rejects.toThrow(/No search scope/);
    await expect(run('open', 'aaaa1111', '--global')).rejects.toMatchObject({ exitCode: 2 });
  });

  it('help covers find, open and index', async () => {
    for (const c of ['find', 'open', 'index']) expect((await run('help', c)).out).toContain('--global lifts');
    expect((await run('--help')).out).toContain('cchost find');
  });
});
