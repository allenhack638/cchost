import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import cli from '../lib/cli.js';
import pins from '../lib/pins.js';
import actions from '../lib/actions.js';

let home;
let realHomedir;
let realCwd;
let out;
let realWrite;
let realLog;
let realErr;
let cwd;

async function run(...args) {
  out = '';
  const code = await cli.run(args);
  return { code, out };
}
const json = async (...args) => {
  const r = await run(...args);
  return { code: r.code, data: JSON.parse(r.out) };
};
const mk = (...p) => {
  const d = path.join(home, ...p);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pins-')));
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
  mk('.claude-profiles', 'work');
  mk('.claude-profiles', 'p1');
  mk('.claude');
});

afterEach(() => {
  os.homedir = realHomedir;
  process.cwd = realCwd;
  process.stdout.write = realWrite;
  console.log = realLog;
  process.stderr.write = realErr;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('pins', () => {
  it('pins, lists and unpins through the CLI with previews', async () => {
    const repo = mk('src', 'api');
    cwd = repo;
    const dry = await json('pin', 'work', '--dry-run', '--json');
    expect(dry.data.ok && dry.data.dryRun).toBe(true);
    expect(pins.list()).toEqual([]);
    const r = await json('pin', 'work', '--json');
    expect(r.data.ok).toBe(true);
    expect(r.data.lines[0].text).toContain(`pinned ${path.join('~', 'src', 'api')} and its subfolders to work`);
    expect((await json('pin', 'work', '--json')).data.lines[0].kind).toBe('same');
    const re = await json('pin', 'p1', '--json');
    expect(re.data.lines[0].text).toContain('(was work)');
    const list = await json('pins', '--json');
    expect(list.data).toEqual([{ dir: repo, profile: 'p1', exists: true, profileExists: true }]);
    cwd = home;
    const un = await json('unpin', `--path=${repo}`, '--json');
    expect(un.data.lines[0].text).toContain(`unpinned ${path.join('~', 'src', 'api')} (was p1)`);
    expect((await json('unpin', `--path=${repo}`, '--json')).data.lines[0].kind).toBe('same');
  });

  it('refuses unknown profiles, non-folders, home and roots', async () => {
    cwd = mk('proj');
    const bad = await json('pin', 'nope', '--json');
    expect(bad.code).toBe(1);
    expect(bad.data.error).toContain('does not exist');
    await expect(run('pin', 'work', '--path=/definitely/not/here')).rejects.toThrow(/not a folder/);
    cwd = home;
    const h = await json('pin', 'work', '--json');
    expect(h.code).toBe(1);
    expect(h.data.error).toContain('not your home');
    expect(() => pins.pin('work', path.parse(home).root)).toThrow(/home or a filesystem root/);
  });

  it('the deepest pin wins and subfolders inherit', () => {
    const top = mk('work');
    const side = mk('work', 'side');
    const deep = mk('work', 'side', 'x', 'y');
    pins.pin('work', top);
    pins.pin('p1', side);
    expect(pins.resolve(top).profile).toBe('work');
    expect(pins.resolve(path.join(top, 'other')).profile).toBe('work');
    expect(pins.resolve(deep)).toMatchObject({ kind: 'pin', profile: 'p1', dir: side });
    expect(pins.resolve(home)).toBeNull();
  });

  it('a .cchost file is a suggestion: it narrows scope but is not a pin', () => {
    const repo = mk('clone');
    fs.writeFileSync(path.join(repo, '.cchost'), '# team default\nwork\n');
    const hit = pins.resolve(path.join(repo));
    expect(hit).toMatchObject({ kind: 'file', profile: 'work', confirmed: false, dir: repo });
    expect(pins.scope(repo)).toMatchObject({ root: repo, profiles: ['work'], source: 'file', confirmed: false });
    pins.ignoreFile(repo);
    expect(pins.resolve(repo)).toBeNull();
    expect(pins.scope(repo)).toMatchObject({ root: repo, profiles: null, source: 'cwd' });
    pins.pin('p1', repo);
    expect(pins.resolve(repo)).toMatchObject({ kind: 'pin', profile: 'p1' });
  });

  it('a malformed .cchost file never names a profile', () => {
    const repo = mk('clone');
    fs.writeFileSync(path.join(repo, '.cchost'), 'work\np1\n');
    expect(pins.resolve(repo)).toMatchObject({ kind: 'file', profile: null });
    fs.writeFileSync(path.join(repo, '.cchost'), '../etc\n');
    expect(pins.resolve(repo).profile).toBeNull();
    expect(pins.scope(repo).profiles).toEqual([]);
    fs.writeFileSync(path.join(repo, '.cchost'), '');
    expect(pins.resolve(repo)).toBeNull();
  });

  it('scope: project folders bound the folder only; home and above have none', () => {
    const proj = mk('code', 'thing');
    expect(pins.scope(proj)).toEqual({ root: proj, profiles: null, source: 'cwd', confirmed: true });
    expect(() => pins.scope(home)).toThrow(/No search scope/);
    expect(() => pins.scope(path.dirname(home))).toThrow(/No search scope/);
    expect(() => pins.scope(path.parse(home).root)).toThrow(/No search scope/);
  });

  it('which explains go and find, and go without a pin falls back to the existing account', async () => {
    cwd = mk('proj');
    let w = await json('which', '--json');
    expect(w.data.launch).toBeNull();
    expect(w.data.scope).toMatchObject({ profiles: null, source: 'cwd' });
    fs.writeFileSync(path.join(home, '.claude.json'), '{}');
    await json('add', 'me', '--existing', '--json');
    w = await json('which', '--json');
    expect(w.data.launch).toBe('me');
    pins.pin('work', cwd);
    w = await json('which', '--json');
    expect(w.data).toMatchObject({ launch: 'work', pin: { kind: 'pin', profile: 'work' }, scope: { profiles: ['work'], source: 'pin' } });
    cwd = home;
    w = await json('which', '--json');
    expect(w.data.scope).toBeNull();
    expect(w.data.scopeError).toContain('No search scope');
  });

  it('removing a profile drops its pins, and state lists pins', async () => {
    const a = mk('a');
    const b = mk('b');
    pins.pin('work', a);
    pins.pin('p1', b);
    expect(actions.state().pins.map((p) => p.profile)).toEqual(['work', 'p1']);
    const dry = await json('remove', 'work', '--dry-run', '--json');
    expect(dry.data.lines.some((l) => l.label === 'pin' && l.text === `unpin ${path.join('~', 'a')}`)).toBe(true);
    expect(pins.list()).toHaveLength(2);
    const r = await json('remove', 'work', '--yes', '--json');
    expect(r.data.ok).toBe(true);
    expect(pins.list()).toEqual([{ dir: b, profile: 'p1', exists: true, profileExists: true }]);
  });

  it('tolerates garbage in the registry and flags stale pins', () => {
    const reg = path.join(home, '.claude-profiles', '.cchost.json');
    fs.writeFileSync(reg, JSON.stringify({ pins: { relative: 'work', [path.join(home, 'gone')]: 'work', [path.join(home, 'x')]: 'Bad Name!', [path.join(home, 'y')]: 'ghost' }, ignoredPinFiles: 'nope' }));
    mk('y');
    expect(pins.list()).toEqual([
      { dir: path.join(home, 'gone'), profile: 'work', exists: false, profileExists: true },
      { dir: path.join(home, 'y'), profile: 'ghost', exists: true, profileExists: false },
    ]);
  });

  it('help covers pin, unpin, pins, which and go', async () => {
    for (const c of ['pin', 'unpin', 'pins', 'which', 'go']) {
      const r = await run('help', c);
      expect(r.out).toContain('cchost go [...claude args]');
    }
    expect((await run('--help')).out).toContain('cchost go');
  });
});

describe('folder spellings', () => {
  it('treats a folder and its resolved spellings as the same place', () => {
    const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sp-')));
    try {
      expect(pins.spellings(d)).toContain(d);
      expect(pins.isUnderReal(path.join(d, 'x'), d)).toBe(true);
      expect(pins.isUnderReal(`${d}-old`, d)).toBe(false);
      expect(pins.isUnderReal(path.join(d, '..', path.basename(d), 'y'), d)).toBe(true);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('interactive go and open', () => {
  const FIXTURES = path.resolve(__dirname, '..', 'test-fixtures');
  let answers;
  let realPrompt;
  let realPath;
  let inTTY;
  let outTTY;

  beforeEach(() => {
    realPrompt = cli.io.prompt;
    answers = [];
    cli.io.prompt = async () => (answers.length ? answers.shift() : '');
    realPath = process.env.PATH;
    process.env.PATH = `${FIXTURES}${path.delimiter}${realPath}`;
    if (process.platform !== 'win32') fs.chmodSync(path.join(FIXTURES, 'claude'), 0o755);
    inTTY = process.stdin.isTTY;
    outTTY = process.stdout.isTTY;
    process.env.NO_COLOR = '1';
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
  });

  afterEach(() => {
    cli.io.prompt = realPrompt;
    process.env.PATH = realPath;
    delete process.env.NO_COLOR;
    process.stdin.isTTY = inTTY;
    process.stdout.isTTY = outTTY;
  });

  it('go with no pin lists accounts, launches the pick and pins on yes', async () => {
    cwd = mk('src', 'fresh');
    answers = ['2', ''];
    const r = await run('go', '--version');
    expect(r.code).toBe(0);
    expect(r.out).toContain('No pin for');
    expect(r.out).toMatch(/1 {2}p1/);
    expect(r.out).toMatch(/2 {2}work/);
    expect(r.out).toContain('pinned');
    expect(pins.list()).toMatchObject([{ dir: cwd, profile: 'work' }]);
  });

  it('declining the pin still launches, and cancelling changes nothing', async () => {
    cwd = mk('src', 'fresh');
    answers = ['1', 'n'];
    expect((await run('go')).code).toBe(0);
    expect(pins.list()).toEqual([]);
    answers = ['q'];
    const c = await run('go');
    expect(c.code).toBe(1);
    expect(c.out).toContain('Cancelled');
    answers = ['9'];
    expect((await run('go')).code).toBe(1);
  });

  it('Enter picks the existing account, and home folders are never offered a pin', async () => {
    fs.writeFileSync(path.join(home, '.claude.json'), '{}');
    await run('add', 'me', '--existing', '--json');
    cwd = home;
    answers = [''];
    const r = await run('go');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/me.*\(Enter\)/);
    expect(r.out).not.toContain('Pin ');
    expect(pins.list()).toEqual([]);
  });

  it('a declined .cchost suggestion falls through to the picker', async () => {
    cwd = mk('clone');
    fs.writeFileSync(path.join(cwd, '.cchost'), 'work\n');
    answers = ['n', '1', 'y'];
    expect((await run('go')).code).toBe(0);
    expect(pins.list()).toMatchObject([{ dir: cwd, profile: 'p1' }]);
  });

  it('without a terminal go keeps the old behaviour and never prompts', async () => {
    process.stdin.isTTY = false;
    cwd = mk('src', 'fresh');
    answers = ['1', 'y'];
    await expect(run('go')).rejects.toThrow(/No pin for this folder/);
    expect(answers).toHaveLength(2);
  });

  it('open with no id lists recent conversations, and picks one at a terminal', async () => {
    const proj = mk('src', 'proj');
    const id = 'feed1234-0000-4000-8000-000000000001';
    const dir = path.join(home, '.claude', 'projects', proj.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${[
      { type: 'user', cwd: proj, sessionId: id, timestamp: new Date(Date.now() - 2 * 86400e3).toISOString(), message: { role: 'user', content: 'migrate the billing tables' } },
      { type: 'assistant', cwd: proj, sessionId: id, timestamp: new Date(Date.now() - 2 * 86400e3).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ].map((l) => JSON.stringify(l)).join('\n')}\n`);
    fs.writeFileSync(path.join(home, '.claude-profiles', 'work', 'history.jsonl'), `${JSON.stringify({ display: 'x', timestamp: 1, project: proj, sessionId: id })}\n`);
    cwd = proj;
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;
    const list = await run('open');
    expect(list.code).toBe(0);
    expect(list.out).toContain('Recent conversations');
    expect(list.out).toContain('feed1234  migrate the billing tables');
    expect(list.out).toContain('work · 2d ago');
    expect(list.out).toContain('cchost open feed1234');
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    answers = [''];
    expect((await run('open')).code).toBe(0);
    answers = ['q'];
    expect((await run('open')).code).toBe(1);
    cwd = mk('src', 'empty');
    expect((await run('open')).out).toContain('No conversations yet');
  });

  it('home screen hints at go in an unpinned project, shows the pin when pinned', async () => {
    cwd = mk('src', 'proj');
    expect((await run()).out).toContain('not pinned · cchost go asks which account');
    pins.pin('work', cwd);
    expect((await run()).out).toMatch(/Here +.*→ work/);
    cwd = home;
    expect((await run()).out).not.toContain('Here');
  });

  it('status lists pins', async () => {
    const d = mk('src', 'proj');
    pins.pin('work', d);
    expect((await run('status')).out).toMatch(new RegExp(`Pinned +${path.join('~', 'src', 'proj').replace(/[\\]/g, '\\\\')} → work`));
  });
});

describe('friendly paths', () => {
  it('add and remove print ~ paths, not absolute ones', async () => {
    const added = await run('add', 'newp');
    expect(added.out).toContain(`Created profile "newp" at ${path.join('~', '.claude-profiles', 'newp')}.`);
    expect(added.out).not.toContain(home);
  });
});

describe('endpoint login state', () => {
  it('list counts an endpoint profile as logged in once its token is set', async () => {
    await run('add', 'kimi', '--custom', '--base-url=https://api.example.com');
    let rows = JSON.parse((await run('list', '--json')).out);
    expect(rows.find((r) => r.name === 'kimi')).toMatchObject({ loggedIn: false, credentialSource: 'none' });
    const envFile = path.join(home, '.claude-profiles', 'kimi', '.cc-env.json');
    fs.writeFileSync(envFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(envFile, 'utf8')), auth_token: 'sk-x' }));
    rows = JSON.parse((await run('list', '--json')).out);
    expect(rows.find((r) => r.name === 'kimi')).toMatchObject({ loggedIn: true, credentialSource: 'token' });
    expect((await run('list', 'kimi')).out).toContain('LoggedIn:  true');
    expect(rows.find((r) => r.name === 'work').credentialSource).not.toBe('token');
  });
});
