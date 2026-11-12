import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import share from '../lib/share.js';
import profiles from '../lib/profiles.js';
import mcp from '../lib/mcp.js';
import backup from '../lib/backup.js';

const SECRET = 'sk-SENTINEL-9f8e7d6c5b4a3210zz';

let home;
let realHomedir;
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const write = (f, d) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(d));
};
const cj = (name) => path.join(home, '.claude-profiles', name, '.claude.json');

function makeProfile(name, { shareMcp = true } = {}) {
  fs.mkdirSync(path.join(home, '.claude-profiles', name), { recursive: true });
  if (shareMcp) share.shareLink(name, { config: true });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mcp-'));
  realHomedir = os.homedir;
  os.homedir = () => home;
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
});

afterEach(() => {
  os.homedir = realHomedir;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('masking', () => {
  it('never exposes env/header values or secret-looking args', () => {
    const v = mcp.publicView({
      command: 'npx',
      args: ['-y', 'srv', '--token', SECRET, `--api-key=${SECRET}`, SECRET, 'https://x.io/s?key=abc&q=1'],
      env: { TOKEN: SECRET },
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    const text = JSON.stringify(v);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('abc');
    expect(v.envKeys).toEqual(['TOKEN']);
    expect(v.headerKeys).toEqual(['Authorization']);
    expect(v.args.slice(0, 3)).toEqual(['-y', 'srv', '--token']);
  });

  it('masks URL credentials', () => {
    expect(mcp.maskUrl('https://user:pw@h.io/x')).not.toContain('pw');
  });
});

describe('copy', () => {
  beforeEach(() => {
    makeProfile('work', { shareMcp: false });
    makeProfile('pk', { shareMcp: false });
    write(cj('work'), {
      oauthAccount: { emailAddress: 'a@b.c' },
      mcpServers: { db: { type: 'stdio', command: 'run.sh', args: [], env: { K: SECRET } } },
      projects: { '/p/front': { mcpServers: { pw: { command: 'npx', args: ['pw'] } } } },
    });
    write(cj('pk'), { oauthAccount: { emailAddress: 'x@y.z' }, numStartups: 4 });
  });

  it('previews without writing', () => {
    const lines = mcp.copy({ from: 'work', to: ['pk'] }, { dryRun: true });
    expect(lines.map((l) => l.text)).toContain('copy to pk');
    expect(read(cj('pk')).mcpServers).toBeUndefined();
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });

  it('copies user scope, keeps other keys, writes 0600 and a backup', () => {
    const lines = mcp.copy({ from: 'work', to: ['pk'] }, { dryRun: false });
    const after = read(cj('pk'));
    expect(after.mcpServers.db.env.K).toBe(SECRET);
    expect(after.numStartups).toBe(4);
    expect(after.projects).toBeUndefined();
    if (process.platform !== 'win32') expect(fs.statSync(cj('pk')).mode & 0o777).toBe(0o600);
    const id = lines.find((l) => l.backup).backup;
    expect(backup.list()[0].id).toBe(id);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });

  it('copies local scope into the same project', () => {
    mcp.copy({ from: 'work', to: ['pk'], scope: 'all' }, { dryRun: false });
    expect(read(cj('pk')).projects['/p/front'].mcpServers.pw.args).toEqual(['pw']);
  });

  it('reports identical servers as same and refuses different ones without force', () => {
    mcp.copy({ from: 'work', to: ['pk'] }, { dryRun: false });
    expect(mcp.copy({ from: 'work', to: ['pk'] }, { dryRun: false })[0].kind).toBe('same');
    write(cj('pk'), { mcpServers: { db: { command: 'other' } } });
    const refused = mcp.copy({ from: 'work', to: ['pk'] }, { dryRun: false });
    expect(refused[0]).toMatchObject({ kind: 'warn', code: 'conflict' });
    expect(read(cj('pk')).mcpServers.db.command).toBe('other');
    mcp.copy({ from: 'work', to: ['pk'], force: true }, { dryRun: false });
    expect(read(cj('pk')).mcpServers.db.command).toBe('run.sh');
  });

  it('errors on an unknown server or profile', () => {
    expect(() => mcp.copy({ from: 'work', to: ['pk'], servers: ['nope'] })).toThrow(/no user-scope MCP server named "nope"/);
    expect(() => mcp.copy({ from: 'ghost', to: ['pk'] })).toThrow(/does not exist/);
  });

  it('restore puts the destination back', () => {
    const before = fs.readFileSync(cj('pk'), 'utf8');
    const lines = mcp.copy({ from: 'work', to: ['pk'] }, { dryRun: false });
    backup.restore(lines.find((l) => l.backup).backup);
    expect(fs.readFileSync(cj('pk'), 'utf8')).toBe(before);
  });
});

describe('pool sync', () => {
  const pool = () => path.join(home, '.claude', 'mcp.json');

  beforeEach(() => {
    write(pool(), { mcpServers: { plate: { command: 'npx', args: ['plate'] } } });
    makeProfile('a');
    makeProfile('b');
    makeProfile('solo', { shareMcp: false });
    write(cj('a'), { keep: 1 });
  });

  it('writes pool servers into sharing profiles only and records them', () => {
    const lines = mcp.sync({}, { dryRun: false });
    expect(read(cj('a')).mcpServers.plate.args).toEqual(['plate']);
    expect(read(cj('a')).keep).toBe(1);
    expect(read(cj('b')).mcpServers.plate).toBeDefined();
    expect(fs.existsSync(cj('solo'))).toBe(false);
    expect(lines.filter((l) => l.kind === 'change')).toHaveLength(2);
    expect(mcp.drift()).toEqual([]);
  });

  it('removing from the pool removes only synced, unedited copies', () => {
    mcp.sync({}, { dryRun: false });
    const b = read(cj('b'));
    b.mcpServers.plate.args = ['edited'];
    write(cj('b'), b);
    write(cj('a'), { ...read(cj('a')), mcpServers: { ...read(cj('a')).mcpServers, mine: { command: 'm' } } });
    mcp.remove({ target: 'pool', server: 'plate' }, { dryRun: false });
    expect(read(cj('a')).mcpServers.plate).toBeUndefined();
    expect(read(cj('a')).mcpServers.mine).toBeDefined();
    expect(read(cj('b')).mcpServers.plate.args).toEqual(['edited']);
  });

  it('never overwrites a server the profile added itself', () => {
    write(cj('a'), { mcpServers: { plate: { command: 'own' } } });
    const lines = mcp.sync({ profiles: ['a'] }, { dryRun: false });
    expect(lines[0]).toMatchObject({ kind: 'warn', code: 'conflict' });
    expect(read(cj('a')).mcpServers.plate.command).toBe('own');
  });

  it('copying into the pool syncs subscribers and the pool file is 0600', () => {
    makeProfile('src', { shareMcp: false });
    write(cj('src'), { mcpServers: { db: { command: 'db', env: { K: SECRET } } } });
    mcp.copy({ from: 'src', to: ['pool'] }, { dryRun: false });
    expect(read(cj('b')).mcpServers.db.env.K).toBe(SECRET);
    if (process.platform !== 'win32') expect(fs.statSync(pool()).mode & 0o777).toBe(0o600);
    expect(mcp.poolExposed()).toBe(false);
  });

  it('a profile that keeps its own mcp.json is reported, not written', () => {
    const lines = mcp.sync({ profiles: ['solo'] }, { dryRun: false });
    expect(lines[0].kind).toBe('warn');
  });

  it('includes the named existing account (~/.claude.json)', () => {
    write(path.join(home, '.claude.json'), { oauthAccount: { emailAddress: 'me@x.io' } });
    profiles.setAlias('personal');
    mcp.sync({}, { dryRun: false });
    expect(read(path.join(home, '.claude.json')).mcpServers.plate).toBeDefined();
    expect(fs.existsSync(path.join(home, '.claude', '.cc-mcp-sync.json'))).toBe(true);
  });
});

describe('default target', () => {
  it('is the existing account before and after it has a name', () => {
    write(path.join(home, '.claude.json'), { mcpServers: { db: { command: 'db' } } });
    makeProfile('w', { shareMcp: false });
    expect(mcp.copy({ from: 'default', to: ['w'] }, { dryRun: true })[0].text).toBe('copy to w');
    profiles.setAlias('me');
    expect(mcp.resolveTarget('default').name).toBe('me');
  });
});

describe('describe / listAll', () => {
  it('lists pool and profiles with scopes and no secrets', () => {
    makeProfile('w', { shareMcp: false });
    write(cj('w'), { mcpServers: { db: { command: 'x', env: { K: SECRET } } }, projects: { '/p': { mcpServers: { l: { url: 'https://h.io' } } } } });
    const all = mcp.listAll();
    expect(all[0].target).toBe('pool');
    const w = all.find((t) => t.target === 'w');
    expect(w.servers.map((s) => `${s.name}:${s.scope}`)).toEqual(['db:user', 'l:local']);
    expect(w.servers[1].transport).toBe('http');
    expect(JSON.stringify(all)).not.toContain(SECRET);
  });
});

describe('backup safety', () => {
  it('refuses to write outside the cchost roots', () => {
    const outside = path.join(home, 'elsewhere.json');
    const link = path.join(home, '.claude-profiles', 'x', '.claude.json');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.writeFileSync(outside, '{}');
    try {
      fs.symlinkSync(outside, link);
    } catch {
      return;
    }
    const tx = backup.begin('t');
    expect(() => tx.writeJson(link, (d) => d)).toThrow(/outside/);
  });

  it('will not overwrite a file that is not valid JSON', () => {
    const f = path.join(home, '.claude-profiles', 'y', '.claude.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '{broken');
    expect(() => backup.begin('t').writeJson(f, (d) => d)).toThrow(/not valid JSON/);
    expect(fs.readFileSync(f, 'utf8')).toBe('{broken');
  });

  it('keeps only the newest backups', () => {
    const f = path.join(home, '.claude', 'mcp.json');
    for (let i = 0; i < backup.KEEP + 3; i++) {
      const tx = backup.begin(`n${i}`);
      tx.writeJson(f, (d) => ({ ...d, i }));
      tx.done();
    }
    expect(backup.list().length).toBe(backup.KEEP);
  });
});
