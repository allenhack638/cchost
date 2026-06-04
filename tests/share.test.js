import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import share from '../lib/share.js';

describe('shareLink — v0.4.1 (7 resources)', () => {
  let tmpHome;
  let originalHomedir;
  let originalLog;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-share-'));
    originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
    originalLog = console.log;
    console.log = () => {};
  });

  afterEach(() => {
    os.homedir = originalHomedir;
    console.log = originalLog;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('links all 7 resources (4 dirs + 3 files) on an empty profile', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(pdir, { recursive: true });

    const results = share.shareLink('work');

    expect(results).toHaveLength(7);
    for (const r of results) {
      expect(['linked', 'already-linked']).toContain(r.status);
    }
    // 4 dir links
    for (const sub of ['projects', 'skills', 'agents', 'commands']) {
      expect(fs.lstatSync(path.join(pdir, sub)).isSymbolicLink()).toBe(true);
    }
    // 3 file links — symlink OR hardlink (Windows fallback)
    for (const f of ['mcp.json', 'settings.json', 'CLAUDE.md']) {
      expect(share.isSharedResource(pdir, f)).toBe(true);
    }
  });

  it('symlinks point at ~/.claude/, not ~/.claude-shared/', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(pdir, { recursive: true });
    share.shareLink('work');
    for (const sub of share.SHARED_DIRS) {
      const link = path.join(pdir, sub);
      const target = path.resolve(pdir, fs.readlinkSync(link));
      expect(target).toBe(path.join(tmpHome, '.claude', sub));
    }
  });

  it('leaves sessions/ alone (never linked)', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(path.join(pdir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(pdir, 'sessions', 'pid.json'), '{"pid":1}');
    share.shareLink('work');
    expect(fs.lstatSync(path.join(pdir, 'sessions')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(pdir, 'sessions', 'pid.json'), 'utf8')).toBe('{"pid":1}');
    expect(fs.existsSync(path.join(tmpHome, '.claude', 'sessions'))).toBe(false);
  });

  it('refuses to link a resource that has private content (v0.4.1 behavior)', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(path.join(pdir, 'projects', 'MyProject'), { recursive: true });
    fs.writeFileSync(path.join(pdir, 'projects', 'MyProject', 'note.txt'), 'private');

    const results = share.shareLink('work');
    const projects = results.find((r) => r.resource === 'projects');
    expect(projects.status).toBe('refused');
    expect(projects.message).toMatch(/private content/i);
    // Private content stays where it was
    expect(fs.existsSync(path.join(pdir, 'projects', 'MyProject', 'note.txt'))).toBe(true);
    // Other resources still get linked
    const skills = results.find((r) => r.resource === 'skills');
    expect(skills.status).toBe('linked');
  });

  it('refuses to link a config file that already has private content', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, 'mcp.json'), '{"private":1}');

    const results = share.shareLink('work', { config: true });
    const mcp = results.find((r) => r.resource === 'mcp.json');
    expect(mcp.status).toBe('refused');
    // File stays untouched
    expect(fs.readFileSync(path.join(pdir, 'mcp.json'), 'utf8')).toBe('{"private":1}');
  });

  it('empty private dir is safely replaced by a symlink', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(path.join(pdir, 'projects'), { recursive: true }); // empty
    const results = share.shareLink('work');
    const projects = results.find((r) => r.resource === 'projects');
    expect(projects.status).toBe('linked');
    expect(fs.lstatSync(path.join(pdir, 'projects')).isSymbolicLink()).toBe(true);
  });

  it('is idempotent: re-running on an already-linked profile is a no-op', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'p');
    fs.mkdirSync(pdir, { recursive: true });
    share.shareLink('p');
    const results = share.shareLink('p');
    for (const r of results) {
      expect(r.status).toBe('already-linked');
    }
  });

  it('per-resource failure does not abort the rest', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'partial');
    fs.mkdirSync(pdir, { recursive: true });
    // mcp.json as a directory (where a file is expected) — forces a failure or refusal
    fs.mkdirSync(path.join(pdir, 'mcp.json'));
    fs.writeFileSync(path.join(pdir, 'mcp.json', 'sub.txt'), 'x');

    const results = share.shareLink('partial');
    const byName = Object.fromEntries(results.map((r) => [r.resource, r.status]));
    // mcp.json should be refused or failed (private content)
    expect(['refused', 'failed']).toContain(byName['mcp.json']);
    // Other resources link
    expect(byName.projects).toBe('linked');
    expect(byName.skills).toBe('linked');
  });

  it('shareLink with { tools: true } links only skills/agents/commands', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(pdir, { recursive: true });
    const results = share.shareLink('work', { tools: true });
    const subs = results.map((r) => r.resource).sort();
    expect(subs).toEqual(['agents', 'commands', 'skills']);
    expect(fs.lstatSync(path.join(pdir, 'skills')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(pdir, 'projects'))).toBe(false);
    expect(fs.existsSync(path.join(pdir, 'mcp.json'))).toBe(false);
  });

  it('shareLink with { projects: true } links only projects', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(pdir, { recursive: true });
    const results = share.shareLink('work', { projects: true });
    expect(results).toHaveLength(1);
    expect(results[0].resource).toBe('projects');
    expect(fs.lstatSync(path.join(pdir, 'projects')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(pdir, 'skills'))).toBe(false);
  });

  it('shareLink with { config: true } links only the 3 config files', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(pdir, { recursive: true });
    const results = share.shareLink('work', { config: true });
    const names = results.map((r) => r.resource).sort();
    expect(names).toEqual(['CLAUDE.md', 'mcp.json', 'settings.json']);
    for (const f of ['mcp.json', 'settings.json', 'CLAUDE.md']) {
      expect(share.isSharedResource(pdir, f)).toBe(true);
    }
    // Dirs untouched
    expect(fs.existsSync(path.join(pdir, 'projects'))).toBe(false);
  });

  it('combined flags: --tools --config links 6 (no projects)', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(pdir, { recursive: true });
    const results = share.shareLink('work', { tools: true, config: true });
    expect(results).toHaveLength(6);
    expect(fs.existsSync(path.join(pdir, 'projects'))).toBe(false);
  });

  it('relinks silently when an existing link points at the legacy ~/.claude-shared/ pool', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(pdir, { recursive: true });
    const legacy = path.join(tmpHome, '.claude-shared', 'projects');
    fs.mkdirSync(legacy, { recursive: true });
    fs.symlinkSync(
      legacy,
      path.join(pdir, 'projects'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const results = share.shareLink('work', { projects: true });
    const projects = results.find((r) => r.resource === 'projects');
    expect(projects.status).toBe('linked');
    expect(projects.relinkedFromLegacy).toBe(true);
    const newTarget = path.resolve(pdir, fs.readlinkSync(path.join(pdir, 'projects')));
    expect(newTarget).toBe(path.join(tmpHome, '.claude', 'projects'));
  });

  it('rejects shareLink on non-existent profile', () => {
    expect(() => share.shareLink('ghost')).toThrow(/does not exist/);
  });
});

describe('shareUnlink — v0.4.1 materializes content', () => {
  let tmpHome;
  let originalHomedir;
  let originalLog;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-unlink-'));
    originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
    originalLog = console.log;
    console.log = () => {};
  });

  afterEach(() => {
    os.homedir = originalHomedir;
    console.log = originalLog;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('restores all 7 resources as private with content copied from the pool', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'p');
    fs.mkdirSync(pdir, { recursive: true });
    share.shareLink('p');

    // Seed pool content after linking
    const pool = path.join(tmpHome, '.claude');
    fs.writeFileSync(path.join(pool, 'projects', 'a.txt'), 'A');
    fs.writeFileSync(path.join(pool, 'mcp.json'), '{"shared":1}');

    share.shareUnlink('p');

    for (const sub of share.SHARED_DIRS) {
      expect(share.isLink(path.join(pdir, sub))).toBe(false);
    }
    expect(fs.readFileSync(path.join(pdir, 'projects', 'a.txt'), 'utf8')).toBe('A');
    expect(fs.readFileSync(path.join(pdir, 'mcp.json'), 'utf8')).toBe('{"shared":1}');
  });

  it('shareUnlink with { tools: true } only restores tool dirs; projects + config stay linked', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(pdir, { recursive: true });
    share.shareLink('work');
    share.shareUnlink('work', { tools: true });
    expect(share.isSharedResource(pdir, 'projects')).toBe(true);
    expect(share.isSharedResource(pdir, 'mcp.json')).toBe(true);
    for (const sub of ['skills', 'agents', 'commands']) {
      expect(share.isLink(path.join(pdir, sub))).toBe(false);
    }
  });

  it('shareUnlink with { config: true } only materializes the 3 config files', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(pdir, { recursive: true });
    share.shareLink('work');
    share.shareUnlink('work', { config: true });
    expect(share.isSharedResource(pdir, 'projects')).toBe(true);
    for (const f of ['mcp.json', 'settings.json', 'CLAUDE.md']) {
      expect(share.isSharedResource(pdir, f)).toBe(false);
      expect(fs.existsSync(path.join(pdir, f))).toBe(true);
    }
  });

  it('reports not-linked when nothing is linked', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(pdir, { recursive: true });
    const results = share.shareUnlink('work', { projects: true });
    expect(results[0].status).toBe('not-linked');
  });
});

describe('migrateLegacyPool — v0.3 → v0.4', () => {
  let tmpHome;
  let originalHomedir;
  let originalLog;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-legacy-'));
    originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
    originalLog = console.log;
    console.log = () => {};
  });

  afterEach(() => {
    os.homedir = originalHomedir;
    console.log = originalLog;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('is a no-op when ~/.claude-shared/ does not exist', () => {
    const result = share.migrateLegacyPool();
    expect(result.migrated).toBe(false);
    expect(result.moves).toEqual([]);
  });

  it('moves legacy pool content into ~/.claude/ and removes the legacy dir', () => {
    const legacy = path.join(tmpHome, '.claude-shared');
    fs.mkdirSync(path.join(legacy, 'skills', 'context7-mcp'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'skills', 'context7-mcp', 'skill.md'), 'mcp content');
    fs.mkdirSync(path.join(legacy, 'projects', 'D--myapp'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'projects', 'D--myapp', 'conv.jsonl'), 'log');

    const result = share.migrateLegacyPool();

    expect(result.migrated).toBe(true);
    expect(result.moves.length).toBe(2);
    const pool = path.join(tmpHome, '.claude');
    expect(fs.readFileSync(path.join(pool, 'skills', 'context7-mcp', 'skill.md'), 'utf8')).toBe('mcp content');
    expect(fs.readFileSync(path.join(pool, 'projects', 'D--myapp', 'conv.jsonl'), 'utf8')).toBe('log');
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('collision-renames on conflict with __legacy suffix', () => {
    const legacy = path.join(tmpHome, '.claude-shared');
    const pool = path.join(tmpHome, '.claude');
    fs.mkdirSync(path.join(pool, 'skills', 'context7-mcp'), { recursive: true });
    fs.writeFileSync(path.join(pool, 'skills', 'context7-mcp', 'skill.md'), 'NEW');
    fs.mkdirSync(path.join(legacy, 'skills', 'context7-mcp'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'skills', 'context7-mcp', 'skill.md'), 'LEGACY');

    share.migrateLegacyPool();

    expect(fs.readFileSync(path.join(pool, 'skills', 'context7-mcp', 'skill.md'), 'utf8')).toBe('NEW');
    expect(
      fs.readFileSync(path.join(pool, 'skills', 'context7-mcp__legacy', 'skill.md'), 'utf8'),
    ).toBe('LEGACY');
  });

  it('re-points profile symlinks from legacy → new pool', () => {
    const legacy = path.join(tmpHome, '.claude-shared');
    fs.mkdirSync(path.join(legacy, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'projects', 'SENTINEL.txt'), 'kept');

    const pdir = path.join(tmpHome, '.claude-profiles', 'p1');
    fs.mkdirSync(pdir, { recursive: true });
    fs.symlinkSync(
      path.join(legacy, 'projects'),
      path.join(pdir, 'projects'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = share.migrateLegacyPool();

    expect(result.relinked).toContainEqual({ profile: 'p1', sub: 'projects' });
    const newTarget = path.resolve(pdir, fs.readlinkSync(path.join(pdir, 'projects')));
    expect(newTarget).toBe(path.join(tmpHome, '.claude', 'projects'));
    expect(fs.readFileSync(path.join(pdir, 'projects', 'SENTINEL.txt'), 'utf8')).toBe('kept');
  });

  it('is idempotent — running twice does nothing extra after the legacy dir is gone', () => {
    const legacy = path.join(tmpHome, '.claude-shared');
    fs.mkdirSync(path.join(legacy, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'skills', 'sentinel.md'), 'x');
    share.migrateLegacyPool();
    const result = share.migrateLegacyPool();
    expect(result.migrated).toBe(false);
  });
});
