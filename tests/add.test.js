import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import profiles from '../lib/profiles.js';
import cli from '../lib/cli.js';

describe('addProfile', () => {
  let tmpHome;
  let originalHomedir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-add-'));
    originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
  });

  afterEach(() => {
    os.homedir = originalHomedir;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('creates a profile directory', () => {
    const { dir } = profiles.addProfile('work');
    expect(fs.existsSync(dir)).toBe(true);
    expect(dir).toBe(path.join(tmpHome, '.claude-profiles', 'work'));
  });

  it('refuses to overwrite an existing profile', () => {
    profiles.addProfile('work');
    expect(() => profiles.addProfile('work')).toThrow(/already exists/);
  });

  it('rejects invalid profile names', () => {
    expect(() => profiles.addProfile('a/b')).toThrow(/disallowed/);
  });

  it('does not write any extra files into the profile dir', () => {
    const { dir } = profiles.addProfile('clean');
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });
});

describe('cc add — auto-link in v0.4', () => {
  let tmpHome;
  let originalHomedir;
  let originalLog;
  let originalErr;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-add-link-'));
    originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
    originalLog = console.log;
    console.log = () => {};
    originalErr = process.stderr.write;
    process.stderr.write = () => true;
  });

  afterEach(() => {
    os.homedir = originalHomedir;
    console.log = originalLog;
    process.stderr.write = originalErr;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('auto-symlinks all 4 artifact dirs into ~/.claude/ on cc add', async () => {
    await cli.run(['add', 'work']);
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    for (const sub of ['projects', 'skills', 'agents', 'commands']) {
      const link = path.join(pdir, sub);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      const target = path.resolve(pdir, fs.readlinkSync(link));
      expect(target).toBe(path.join(tmpHome, '.claude', sub));
    }
  });

  it('two profiles share the same underlying ~/.claude/ pool', async () => {
    await cli.run(['add', 'work']);
    await cli.run(['add', 'personal']);
    // Write a "skill" via work's symlink; personal should see it.
    fs.writeFileSync(
      path.join(tmpHome, '.claude-profiles', 'work', 'skills', 'frontend-skill.md'),
      'shared content',
    );
    const seenFromPersonal = fs.readFileSync(
      path.join(tmpHome, '.claude-profiles', 'personal', 'skills', 'frontend-skill.md'),
      'utf8',
    );
    expect(seenFromPersonal).toBe('shared content');
  });

  it('cc add runs the legacy ~/.claude-shared/ migration when present', async () => {
    const legacy = path.join(tmpHome, '.claude-shared');
    fs.mkdirSync(path.join(legacy, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'skills', 'old-skill.md'), 'from-legacy');

    await cli.run(['add', 'work']);

    // Legacy content moved into ~/.claude/
    expect(
      fs.readFileSync(path.join(tmpHome, '.claude', 'skills', 'old-skill.md'), 'utf8'),
    ).toBe('from-legacy');
    // Legacy dir removed
    expect(fs.existsSync(legacy)).toBe(false);
    // New profile sees the migrated skill via its symlink
    expect(
      fs.readFileSync(path.join(tmpHome, '.claude-profiles', 'work', 'skills', 'old-skill.md'), 'utf8'),
    ).toBe('from-legacy');
  });
});
