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

  it('aborts cleanly when ~/.claude/<sub>/ is a junction into ~/.claude-shared/<sub>/', () => {
    const legacy = path.join(tmpHome, '.claude-shared');
    const pool = path.join(tmpHome, '.claude');
    fs.mkdirSync(path.join(legacy, 'projects', 'D--app'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'projects', 'D--app', 'a.jsonl'), 'sentinel');
    fs.mkdirSync(pool, { recursive: true });
    fs.symlinkSync(
      path.join(legacy, 'projects'),
      path.join(pool, 'projects'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = share.migrateLegacyPool();

    expect(result.selfReferencing).toBe(true);
    expect(result.migrated).toBe(false);
    // Sentinel file still in place — no self-moves happened.
    expect(fs.readFileSync(path.join(legacy, 'projects', 'D--app', 'a.jsonl'), 'utf8')).toBe('sentinel');
    expect(fs.readdirSync(path.join(legacy, 'projects', 'D--app'))).toEqual(['a.jsonl']);
  });

  it('is idempotent — running twice does nothing extra after the legacy dir is gone', () => {
    const legacy = path.join(tmpHome, '.claude-shared');
    fs.mkdirSync(path.join(legacy, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'skills', 'sentinel.md'), 'x');
    share.migrateLegacyPool();
    const result = share.migrateLegacyPool();
    expect(result.migrated).toBe(false);
  });

  it('merges projects/ folder children on collision instead of renaming the folder', () => {
    const legacy = path.join(tmpHome, '.claude-shared');
    const pool = path.join(tmpHome, '.claude');
    fs.mkdirSync(path.join(pool, 'projects', 'D--myapp'), { recursive: true });
    fs.writeFileSync(path.join(pool, 'projects', 'D--myapp', 'new.jsonl'), 'NEW');
    fs.mkdirSync(path.join(legacy, 'projects', 'D--myapp'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'projects', 'D--myapp', 'old.jsonl'), 'OLD');

    share.migrateLegacyPool();

    expect(fs.existsSync(path.join(pool, 'projects', 'D--myapp__legacy'))).toBe(false);
    expect(fs.readFileSync(path.join(pool, 'projects', 'D--myapp', 'new.jsonl'), 'utf8')).toBe('NEW');
    expect(fs.readFileSync(path.join(pool, 'projects', 'D--myapp', 'old.jsonl'), 'utf8')).toBe('OLD');
  });

  it('reissues a new UUID when a <uuid>.jsonl session-file collides during projects/ merge', () => {
    const legacy = path.join(tmpHome, '.claude-shared');
    const pool = path.join(tmpHome, '.claude');
    const uuid = '2a4c2afb-6cc0-4496-b0fe-09cd2f1b2f04';
    fs.mkdirSync(path.join(pool, 'projects', 'D--myapp'), { recursive: true });
    fs.writeFileSync(path.join(pool, 'projects', 'D--myapp', `${uuid}.jsonl`), 'NEW');
    fs.mkdirSync(path.join(legacy, 'projects', 'D--myapp'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'projects', 'D--myapp', `${uuid}.jsonl`), 'OLD');

    share.migrateLegacyPool();

    expect(fs.readFileSync(path.join(pool, 'projects', 'D--myapp', `${uuid}.jsonl`), 'utf8')).toBe('NEW');
    // Old file should still be present under a *different* UUID, not __legacy-suffixed.
    const dst = fs.readdirSync(path.join(pool, 'projects', 'D--myapp'));
    const others = dst.filter((n) => n !== `${uuid}.jsonl` && n.endsWith('.jsonl'));
    expect(others.length).toBe(1);
    expect(others[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i);
    expect(fs.readFileSync(path.join(pool, 'projects', 'D--myapp', others[0]), 'utf8')).toBe('OLD');
  });

  it('pairs a <uuid>/ sub-uuid dir with its <uuid>.jsonl under the reissued UUID', () => {
    const legacy = path.join(tmpHome, '.claude-shared');
    const pool = path.join(tmpHome, '.claude');
    const uuid = '2a4c2afb-6cc0-4496-b0fe-09cd2f1b2f04';
    fs.mkdirSync(path.join(pool, 'projects', 'D--myapp'), { recursive: true });
    fs.writeFileSync(path.join(pool, 'projects', 'D--myapp', `${uuid}.jsonl`), 'NEW');
    fs.mkdirSync(path.join(pool, 'projects', 'D--myapp', uuid), { recursive: true });
    fs.writeFileSync(path.join(pool, 'projects', 'D--myapp', uuid, 'todo.json'), 'NEW-todo');
    fs.mkdirSync(path.join(legacy, 'projects', 'D--myapp'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'projects', 'D--myapp', `${uuid}.jsonl`), 'OLD');
    fs.mkdirSync(path.join(legacy, 'projects', 'D--myapp', uuid), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'projects', 'D--myapp', uuid, 'todo.json'), 'OLD-todo');

    share.migrateLegacyPool();

    const dst = fs.readdirSync(path.join(pool, 'projects', 'D--myapp'));
    const reissuedFile = dst.find((n) => n !== `${uuid}.jsonl` && n.endsWith('.jsonl'));
    const reissuedDir = dst.find((n) => n !== uuid && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(n));
    expect(reissuedFile).toBeTruthy();
    expect(reissuedDir).toBeTruthy();
    // File and dir share the same reissued stem.
    expect(reissuedFile.replace(/\.jsonl$/, '')).toBe(reissuedDir);
    expect(fs.readFileSync(path.join(pool, 'projects', 'D--myapp', reissuedFile), 'utf8')).toBe('OLD');
    expect(fs.readFileSync(path.join(pool, 'projects', 'D--myapp', reissuedDir, 'todo.json'), 'utf8')).toBe('OLD-todo');
  });
});

describe('repairProjectFilenames', () => {
  let tmpHome;
  let originalHomedir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-repair-'));
    originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
  });

  afterEach(() => {
    os.homedir = originalHomedir;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('strips __legacy suffix when canonical <uuid>.jsonl is free', () => {
    const uuid = '2a4c2afb-6cc0-4496-b0fe-09cd2f1b2f04';
    const folder = path.join(tmpHome, '.claude', 'projects', 'D--myapp');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${uuid}__legacy.jsonl`), 'X');

    const result = share.repairProjectFilenames();

    expect(result.repaired.length).toBe(1);
    expect(fs.readFileSync(path.join(folder, `${uuid}.jsonl`), 'utf8')).toBe('X');
    expect(fs.existsSync(path.join(folder, `${uuid}__legacy.jsonl`))).toBe(false);
  });

  it('reissues a fresh UUID when canonical <uuid>.jsonl is taken', () => {
    const uuid = '2a4c2afb-6cc0-4496-b0fe-09cd2f1b2f04';
    const folder = path.join(tmpHome, '.claude', 'projects', 'D--myapp');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${uuid}.jsonl`), 'CANONICAL');
    fs.writeFileSync(path.join(folder, `${uuid}__legacy.jsonl`), 'DAMAGED');

    share.repairProjectFilenames();

    expect(fs.readFileSync(path.join(folder, `${uuid}.jsonl`), 'utf8')).toBe('CANONICAL');
    const children = fs.readdirSync(folder);
    const others = children.filter((n) => n !== `${uuid}.jsonl`);
    expect(others.length).toBe(1);
    expect(others[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i);
    expect(fs.readFileSync(path.join(folder, others[0]), 'utf8')).toBe('DAMAGED');
  });

  it('peels compounded suffixes like __legacy__legacy and __legacy_2', () => {
    const uuid = '2a4c2afb-6cc0-4496-b0fe-09cd2f1b2f04';
    const folder = path.join(tmpHome, '.claude', 'projects', 'D--myapp');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${uuid}__legacy__legacy.jsonl`), 'A');
    fs.writeFileSync(path.join(folder, `${uuid}__legacy_2.jsonl`), 'B');

    share.repairProjectFilenames();

    const children = fs.readdirSync(folder).filter((n) => n.endsWith('.jsonl'));
    expect(children.length).toBe(2);
    // One file took the canonical name; the other got a fresh UUID.
    expect(children).toContain(`${uuid}.jsonl`);
    const fresh = children.find((n) => n !== `${uuid}.jsonl`);
    expect(fresh).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i);
  });

  it('pairs a <uuid>__legacy/ sub-uuid dir with its .jsonl under the same restored stem', () => {
    const uuid = '2a4c2afb-6cc0-4496-b0fe-09cd2f1b2f04';
    const folder = path.join(tmpHome, '.claude', 'projects', 'D--myapp');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${uuid}__legacy.jsonl`), 'F');
    fs.mkdirSync(path.join(folder, `${uuid}__legacy`));
    fs.writeFileSync(path.join(folder, `${uuid}__legacy`, 'todo.json'), 'T');

    share.repairProjectFilenames();

    // canonical was free, so both restore to <uuid>.jsonl and <uuid>/.
    expect(fs.readFileSync(path.join(folder, `${uuid}.jsonl`), 'utf8')).toBe('F');
    expect(fs.readFileSync(path.join(folder, uuid, 'todo.json'), 'utf8')).toBe('T');
  });

  it('restores memory__legacy/ and sessions-index__legacy.json when canonical is free', () => {
    const folder = path.join(tmpHome, '.claude', 'projects', 'D--myapp');
    fs.mkdirSync(folder, { recursive: true });
    fs.mkdirSync(path.join(folder, 'memory__legacy'));
    fs.writeFileSync(path.join(folder, 'memory__legacy', 'k.md'), 'mem');
    fs.writeFileSync(path.join(folder, 'sessions-index__legacy.json'), '{}');

    share.repairProjectFilenames();

    expect(fs.existsSync(path.join(folder, 'memory'))).toBe(true);
    expect(fs.readFileSync(path.join(folder, 'memory', 'k.md'), 'utf8')).toBe('mem');
    expect(fs.readFileSync(path.join(folder, 'sessions-index.json'), 'utf8')).toBe('{}');
  });

  it('is a no-op when nothing is damaged', () => {
    const folder = path.join(tmpHome, '.claude', 'projects', 'D--myapp');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, '2a4c2afb-6cc0-4496-b0fe-09cd2f1b2f04.jsonl'), 'x');
    const result = share.repairProjectFilenames();
    expect(result.repaired).toEqual([]);
  });
});

describe('healProjectsLegacy', () => {
  let tmpHome;
  let originalHomedir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-heal-'));
    originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
  });

  afterEach(() => {
    os.homedir = originalHomedir;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('is a no-op when projects/ has no __legacy folders', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude', 'projects', 'D--myapp'), { recursive: true });
    const result = share.healProjectsLegacy();
    expect(result.healed).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it('merges <base>__legacy/ children into a canonical <base>/ sibling', () => {
    const projects = path.join(tmpHome, '.claude', 'projects');
    fs.mkdirSync(path.join(projects, 'D--myapp'), { recursive: true });
    fs.writeFileSync(path.join(projects, 'D--myapp', 'new.jsonl'), 'NEW');
    fs.mkdirSync(path.join(projects, 'D--myapp__legacy'), { recursive: true });
    fs.writeFileSync(path.join(projects, 'D--myapp__legacy', 'old.jsonl'), 'OLD');

    const result = share.healProjectsLegacy();

    expect(result.healed.length).toBe(1);
    expect(result.healed[0]).toMatchObject({ from: 'D--myapp__legacy', to: 'D--myapp', renamed: false });
    expect(fs.existsSync(path.join(projects, 'D--myapp__legacy'))).toBe(false);
    expect(fs.readFileSync(path.join(projects, 'D--myapp', 'new.jsonl'), 'utf8')).toBe('NEW');
    expect(fs.readFileSync(path.join(projects, 'D--myapp', 'old.jsonl'), 'utf8')).toBe('OLD');
  });

  it('renames <base>__legacy/ to <base>/ when no canonical sibling exists', () => {
    const projects = path.join(tmpHome, '.claude', 'projects');
    fs.mkdirSync(path.join(projects, 'D--orphan__legacy'), { recursive: true });
    fs.writeFileSync(path.join(projects, 'D--orphan__legacy', 's.jsonl'), 'x');

    const result = share.healProjectsLegacy();

    expect(result.healed.length).toBe(1);
    expect(result.healed[0]).toMatchObject({ from: 'D--orphan__legacy', to: 'D--orphan', renamed: true });
    expect(fs.existsSync(path.join(projects, 'D--orphan__legacy'))).toBe(false);
    expect(fs.readFileSync(path.join(projects, 'D--orphan', 's.jsonl'), 'utf8')).toBe('x');
  });

  it('peels compounded suffixes like __legacy__legacy and __legacy_2', () => {
    const projects = path.join(tmpHome, '.claude', 'projects');
    fs.mkdirSync(path.join(projects, 'D--app'), { recursive: true });
    fs.writeFileSync(path.join(projects, 'D--app', 'a.jsonl'), 'A');
    fs.mkdirSync(path.join(projects, 'D--app__legacy__legacy'), { recursive: true });
    fs.writeFileSync(path.join(projects, 'D--app__legacy__legacy', 'b.jsonl'), 'B');
    fs.mkdirSync(path.join(projects, 'D--app__legacy_2'), { recursive: true });
    fs.writeFileSync(path.join(projects, 'D--app__legacy_2', 'c.jsonl'), 'C');

    share.healProjectsLegacy();

    expect(fs.readFileSync(path.join(projects, 'D--app', 'a.jsonl'), 'utf8')).toBe('A');
    expect(fs.readFileSync(path.join(projects, 'D--app', 'b.jsonl'), 'utf8')).toBe('B');
    expect(fs.readFileSync(path.join(projects, 'D--app', 'c.jsonl'), 'utf8')).toBe('C');
    expect(fs.existsSync(path.join(projects, 'D--app__legacy__legacy'))).toBe(false);
    expect(fs.existsSync(path.join(projects, 'D--app__legacy_2'))).toBe(false);
  });

  it('on Windows, merges d--…__legacy into a case-different D--… sibling', () => {
    if (process.platform !== 'win32') return;
    const projects = path.join(tmpHome, '.claude', 'projects');
    fs.mkdirSync(path.join(projects, 'D--myapp'), { recursive: true });
    fs.writeFileSync(path.join(projects, 'D--myapp', 'u.jsonl'), 'U');
    fs.mkdirSync(path.join(projects, 'd--myapp__legacy'), { recursive: true });
    fs.writeFileSync(path.join(projects, 'd--myapp__legacy', 'l.jsonl'), 'L');

    const result = share.healProjectsLegacy();

    expect(result.healed[0]).toMatchObject({ to: 'D--myapp' });
    expect(fs.readFileSync(path.join(projects, 'D--myapp', 'u.jsonl'), 'utf8')).toBe('U');
    expect(fs.readFileSync(path.join(projects, 'D--myapp', 'l.jsonl'), 'utf8')).toBe('L');
  });
});
