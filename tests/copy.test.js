import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import copyLib from '../lib/copy.js';
import share from '../lib/share.js';

describe('cc copy default <profile>', () => {
  let tmpHome;
  let originalHomedir;
  let originalLog;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-copy-'));
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

  function seedDefault() {
    const d = path.join(tmpHome, '.claude');
    fs.mkdirSync(path.join(d, 'projects', 'ProjectA'), { recursive: true });
    fs.writeFileSync(path.join(d, 'projects', 'ProjectA', 'sess1.jsonl'), 'log1');
    fs.mkdirSync(path.join(d, 'projects', 'ProjectB'), { recursive: true });
    fs.writeFileSync(path.join(d, 'projects', 'ProjectB', 'sess2.jsonl'), 'log2');
    fs.writeFileSync(path.join(d, '.credentials.json'), '{"secret":1}');
    fs.writeFileSync(path.join(d, '.claude.json'), '{"oauthAccount":{}}');
    fs.writeFileSync(path.join(d, 'projects', '.credentials.json'), 'NEVER_COPY');
    return d;
  }

  it('default → <profile> on a fresh profile with no symlinks: copies dir content', () => {
    seedDefault();
    // Create profile dir manually without auto-linking (simulate "unlinked" state)
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(pdir, { recursive: true });

    copyLib.copy('default', 'work');

    expect(fs.existsSync(path.join(pdir, 'projects', 'ProjectA', 'sess1.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(pdir, 'projects', 'ProjectB', 'sess2.jsonl'))).toBe(true);
    // EXCLUDED_FILES are NOT copied into profile root or into any subdir
    expect(fs.existsSync(path.join(pdir, '.credentials.json'))).toBe(false);
    expect(fs.existsSync(path.join(pdir, 'projects', '.credentials.json'))).toBe(false);
  });

  it('--dry-run reports the same counts as a real copy and writes nothing', () => {
    seedDefault();
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');

    const dry = copyLib.copy('default', 'work', { dryRun: true });

    expect(fs.existsSync(pdir)).toBe(false);
    const real = copyLib.copy('default', 'work');
    expect(dry.copied).toBe(real.copied);
    expect(dry.copied).toBeGreaterThan(0);
    expect(dry.results).toEqual(real.results);
  });

  it('rejects "shared" as destination in v0.4', () => {
    seedDefault();
    expect(() => copyLib.copy('default', 'shared')).toThrow(/v0\.4/);
  });

  it('rejects "shared" as source in v0.4', () => {
    expect(() => copyLib.copy('shared', 'work')).toThrow(/v0\.4/);
  });

  it('rejects "default" as destination', () => {
    expect(() => copyLib.copy('default', 'default')).toThrow(/Cannot copy into "default"/);
  });

  it('rejects invalid source', () => {
    expect(() => copyLib.copy('garbage', 'work')).toThrow(/Invalid copy source/);
  });

  it('skips resources that resolve to the same on-disk path via symlink', () => {
    // Seed pool content
    const pool = path.join(tmpHome, '.claude');
    fs.mkdirSync(path.join(pool, 'projects', 'X'), { recursive: true });
    fs.writeFileSync(path.join(pool, 'projects', 'X', 'p.txt'), 'pool');

    // Create profile with auto-linking (all 7 shared via symlink)
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(pdir, { recursive: true });
    share.shareLink('work');

    const result = copyLib.copy('default', 'work');
    // All resources should be 'shared' status; nothing copied
    expect(result.copied).toBe(0);
    expect(result.shared).toBe(share.SHARED_RESOURCES.length);
  });

  it('copies single config files (mcp.json, settings.json, CLAUDE.md) when destination is unlinked', () => {
    const d = path.join(tmpHome, '.claude');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'mcp.json'), '{"servers":{}}');
    fs.writeFileSync(path.join(d, 'settings.json'), '{"theme":"dark"}');
    fs.writeFileSync(path.join(d, 'CLAUDE.md'), '# project guide');

    // Profile exists with NO links — fully private
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(pdir, { recursive: true });

    copyLib.copy('default', 'work');

    expect(fs.readFileSync(path.join(pdir, 'mcp.json'), 'utf8')).toBe('{"servers":{}}');
    expect(fs.readFileSync(path.join(pdir, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}');
    expect(fs.readFileSync(path.join(pdir, 'CLAUDE.md'), 'utf8')).toBe('# project guide');
  });

  it('skips single files already present (no --force)', () => {
    const d = path.join(tmpHome, '.claude');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'mcp.json'), '{"src":1}');

    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, 'mcp.json'), '{"existing":1}');

    copyLib.copy('default', 'work');
    expect(fs.readFileSync(path.join(pdir, 'mcp.json'), 'utf8')).toBe('{"existing":1}');
  });

  it('--force overwrites existing single file', () => {
    const d = path.join(tmpHome, '.claude');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'mcp.json'), '{"new":1}');

    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, 'mcp.json'), '{"old":1}');

    copyLib.copy('default', 'work', { force: true });
    expect(fs.readFileSync(path.join(pdir, 'mcp.json'), 'utf8')).toBe('{"new":1}');
  });

  it('--force overwrites existing dir entries', () => {
    const d = path.join(tmpHome, '.claude');
    fs.mkdirSync(path.join(d, 'projects', 'ProjectA'), { recursive: true });
    fs.writeFileSync(path.join(d, 'projects', 'ProjectA', 'new.jsonl'), 'new-data');

    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    const workProjects = path.join(pdir, 'projects');
    fs.mkdirSync(path.join(workProjects, 'ProjectA'), { recursive: true });
    fs.writeFileSync(path.join(workProjects, 'ProjectA', 'old.jsonl'), 'old-data');

    copyLib.copy('default', 'work', { force: true });

    expect(fs.existsSync(path.join(workProjects, 'ProjectA', 'new.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(workProjects, 'ProjectA', 'old.jsonl'))).toBe(false);
  });

  it('skip-on-collision leaves existing entries untouched', () => {
    seedDefault();
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    const workProjects = path.join(pdir, 'projects');
    fs.mkdirSync(path.join(workProjects, 'ProjectA'), { recursive: true });
    fs.writeFileSync(path.join(workProjects, 'ProjectA', 'sess1.jsonl'), 'KEEP_ME');

    copyLib.copy('default', 'work');

    expect(fs.readFileSync(path.join(workProjects, 'ProjectA', 'sess1.jsonl'), 'utf8')).toBe('KEEP_ME');
    expect(fs.existsSync(path.join(workProjects, 'ProjectB', 'sess2.jsonl'))).toBe(true);
  });

  it('missing source no-ops cleanly and creates the profile dir', () => {
    const result = copyLib.copy('default', 'work');
    expect(result.copied).toBe(0);
    expect(fs.existsSync(path.join(tmpHome, '.claude-profiles', 'work'))).toBe(true);
  });

  it('rejects path-traversal profile names as destination', () => {
    expect(() => copyLib.copy('default', '../escape')).toThrow();
  });

  it('never copies sessions/ even when present at source', () => {
    const d = path.join(tmpHome, '.claude');
    fs.mkdirSync(path.join(d, 'projects', 'X'), { recursive: true });
    fs.writeFileSync(path.join(d, 'projects', 'X', 'p.txt'), 'data');
    fs.mkdirSync(path.join(d, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(d, 'sessions', 'pid.json'), '{"pid":1}');

    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(pdir, { recursive: true });

    copyLib.copy('default', 'work');

    expect(fs.existsSync(path.join(pdir, 'projects', 'X', 'p.txt'))).toBe(true);
    expect(fs.existsSync(path.join(pdir, 'sessions'))).toBe(false);
  });

  it('never copies .cc-env.json from default into a profile', () => {
    const d = path.join(tmpHome, '.claude');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '.cc-env.json'), '{"base_url":"http://x"}');
    fs.mkdirSync(path.join(d, 'projects'), { recursive: true });

    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(pdir, { recursive: true });

    copyLib.copy('default', 'work');

    expect(fs.existsSync(path.join(pdir, '.cc-env.json'))).toBe(false);
  });
});
