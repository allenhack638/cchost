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
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pins-')));
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
