import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import migrateLib from '../lib/migrate.js';

describe('cc migrate', () => {
  let tmpHome;
  let originalHomedir;
  let originalLog;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-migrate-'));
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
    // credential files that MUST NOT be copied
    fs.writeFileSync(path.join(d, '.credentials.json'), '{"secret":1}');
    fs.writeFileSync(path.join(d, '.claude.json'), '{"oauthAccount":{}}');
    // also seed at the top of projects/ to verify exclusion within the subdir
    fs.writeFileSync(path.join(d, 'projects', '.credentials.json'), 'NEVER_COPY');
    return d;
  }

  it('default → <profile>: copies projects, creates profile, excludes credential files', () => {
    seedDefault();
    migrateLib.migrate('default', 'work');
    const profilesDir = path.join(tmpHome, '.claude-profiles', 'work', 'projects');
    expect(fs.existsSync(path.join(profilesDir, 'ProjectA', 'sess1.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(profilesDir, 'ProjectB', 'sess2.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(profilesDir, '.credentials.json'))).toBe(false);
  });

  it('default → shared: copies projects into ~/.claude-shared/projects', () => {
    seedDefault();
    migrateLib.migrate('default', 'shared');
    const sharedProjects = path.join(tmpHome, '.claude-shared', 'projects');
    expect(fs.existsSync(path.join(sharedProjects, 'ProjectA', 'sess1.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(sharedProjects, 'ProjectB', 'sess2.jsonl'))).toBe(true);
  });

  it('skip-on-collision: existing entries at destination are left untouched', () => {
    seedDefault();
    // Pre-create work/ with one project already present
    const workProjects = path.join(tmpHome, '.claude-profiles', 'work', 'projects');
    fs.mkdirSync(path.join(workProjects, 'ProjectA'), { recursive: true });
    fs.writeFileSync(path.join(workProjects, 'ProjectA', 'sess1.jsonl'), 'KEEP_ME');

    migrateLib.migrate('default', 'work');

    // ProjectA stays as the original "KEEP_ME"
    expect(fs.readFileSync(path.join(workProjects, 'ProjectA', 'sess1.jsonl'), 'utf8')).toBe('KEEP_ME');
    // ProjectB is freshly copied
    expect(fs.existsSync(path.join(workProjects, 'ProjectB', 'sess2.jsonl'))).toBe(true);
  });

  it('returns counts of copied and skipped', () => {
    seedDefault();
    const workProjects = path.join(tmpHome, '.claude-profiles', 'work', 'projects');
    fs.mkdirSync(path.join(workProjects, 'ProjectA'), { recursive: true });
    fs.writeFileSync(path.join(workProjects, 'ProjectA', 'a.txt'), 'pre');

    const result = migrateLib.migrate('default', 'work');
    expect(result.copied).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('missing source no-ops cleanly', () => {
    // No ~/.claude exists
    const result = migrateLib.migrate('default', 'work');
    expect(result.copied).toBe(0);
    expect(result.skipped).toBe(0);
    // The profile dir was created anyway (the user clearly wants the profile)
    expect(fs.existsSync(path.join(tmpHome, '.claude-profiles', 'work'))).toBe(true);
  });

  it('rejects invalid source', () => {
    expect(() => migrateLib.migrate('garbage', 'work')).toThrow(/Invalid migrate source/);
  });

  it('rejects "default" as destination', () => {
    expect(() => migrateLib.migrate('shared', 'default')).toThrow(/Cannot migrate into "default"/);
  });

  it('rejects src == dest (shared → shared)', () => {
    expect(() => migrateLib.migrate('shared', 'shared')).toThrow(/same directory/);
  });

  it('shared → <profile> works after default → shared seeding', () => {
    seedDefault();
    migrateLib.migrate('default', 'shared');
    migrateLib.migrate('shared', 'personal');
    const personalProjects = path.join(tmpHome, '.claude-profiles', 'personal', 'projects');
    expect(fs.existsSync(path.join(personalProjects, 'ProjectA', 'sess1.jsonl'))).toBe(true);
  });

  it('never copies sessions/ even when present at the source (transient per-process state)', () => {
    const d = path.join(tmpHome, '.claude');
    fs.mkdirSync(path.join(d, 'projects', 'ProjectX'), { recursive: true });
    fs.writeFileSync(path.join(d, 'projects', 'ProjectX', 'log.jsonl'), 'p-data');
    fs.mkdirSync(path.join(d, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(d, 'sessions', 'pid.json'), '{"pid":1}');

    migrateLib.migrate('default', 'work');

    const profileDir = path.join(tmpHome, '.claude-profiles', 'work');
    // projects/ migrated as usual
    expect(fs.existsSync(path.join(profileDir, 'projects', 'ProjectX', 'log.jsonl'))).toBe(true);
    // sessions/ was deliberately not copied
    expect(fs.existsSync(path.join(profileDir, 'sessions'))).toBe(false);
  });

  it('rejects path-traversal profile names as destination', () => {
    expect(() => migrateLib.migrate('default', '../escape')).toThrow();
  });
});
