import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import share from '../lib/share.js';

describe('share link migration with collisions', () => {
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

  it('migrates existing projects/ into shared and links it; leaves sessions/ alone', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(path.join(pdir, 'projects', 'MyProject'), { recursive: true });
    fs.writeFileSync(path.join(pdir, 'projects', 'MyProject', 'note.txt'), 'work-note');
    fs.mkdirSync(path.join(pdir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(pdir, 'sessions', 'pid.json'), '{"pid":1}');

    share.shareLink('work');

    const shared = path.join(tmpHome, '.claude-shared');
    expect(fs.existsSync(path.join(shared, 'projects', 'MyProject', 'note.txt'))).toBe(true);
    expect(fs.lstatSync(path.join(pdir, 'projects')).isSymbolicLink()).toBe(true);
    // sessions/ stays per-profile, never linked, content preserved
    expect(fs.lstatSync(path.join(pdir, 'sessions')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(pdir, 'sessions', 'pid.json'), 'utf8')).toBe('{"pid":1}');
    // shared dir should not contain a sessions/ tree either
    expect(fs.existsSync(path.join(shared, 'sessions'))).toBe(false);
  });

  it('links all four artifact dirs (projects, skills, agents, commands)', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'multi');
    for (const sub of ['projects', 'skills', 'agents', 'commands']) {
      fs.mkdirSync(path.join(pdir, sub, 'item'), { recursive: true });
      fs.writeFileSync(path.join(pdir, sub, 'item', 'f.txt'), sub);
    }

    share.shareLink('multi');

    const shared = path.join(tmpHome, '.claude-shared');
    for (const sub of ['projects', 'skills', 'agents', 'commands']) {
      expect(fs.lstatSync(path.join(pdir, sub)).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(shared, sub, 'item', 'f.txt'))).toBe(true);
    }
  });

  it('shareLink works on a profile that has no sessions/ folder at all', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(path.join(pdir, 'projects'), { recursive: true });
    // deliberately no sessions/
    expect(() => share.shareLink('work')).not.toThrow();
    expect(fs.lstatSync(path.join(pdir, 'projects')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(pdir, 'sessions'))).toBe(false);
  });

  it('renames the second profile\'s colliding project with __<profile> suffix', () => {
    const p1 = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(path.join(p1, 'projects', 'shared-name'), { recursive: true });
    fs.writeFileSync(path.join(p1, 'projects', 'shared-name', 'a.txt'), 'from-work');

    const p2 = path.join(tmpHome, '.claude-profiles', 'personal');
    fs.mkdirSync(path.join(p2, 'projects', 'shared-name'), { recursive: true });
    fs.writeFileSync(path.join(p2, 'projects', 'shared-name', 'b.txt'), 'from-personal');

    share.shareLink('work');
    share.shareLink('personal');

    const sharedProjects = path.join(tmpHome, '.claude-shared', 'projects');
    expect(fs.existsSync(path.join(sharedProjects, 'shared-name', 'a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(sharedProjects, 'shared-name__personal', 'b.txt'))).toBe(true);
  });

  it('is idempotent: linking an already-linked profile does nothing', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'p');
    fs.mkdirSync(path.join(pdir, 'projects'), { recursive: true });
    share.shareLink('p');
    expect(() => share.shareLink('p')).not.toThrow();
    expect(fs.lstatSync(path.join(pdir, 'projects')).isSymbolicLink()).toBe(true);
  });

  it('shareUnlink restores all four private dirs with content copied back', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'p');
    for (const sub of ['projects', 'skills', 'agents', 'commands']) {
      fs.mkdirSync(path.join(pdir, sub), { recursive: true });
      fs.writeFileSync(path.join(pdir, sub, 'hello.txt'), sub);
    }
    share.shareLink('p');
    share.shareUnlink('p');
    for (const sub of ['projects', 'skills', 'agents', 'commands']) {
      expect(fs.lstatSync(path.join(pdir, sub)).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(pdir, sub, 'hello.txt'), 'utf8')).toBe(sub);
    }
  });

  it('rejects shareLink on non-existent profile', () => {
    expect(() => share.shareLink('ghost')).toThrow(/does not exist/);
  });

  it('shareLink does not abort on a per-directory failure; remaining dirs still linked', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'partial');
    for (const sub of ['projects', 'skills', 'commands']) {
      fs.mkdirSync(path.join(pdir, sub, 'x'), { recursive: true });
    }
    // agents is a regular file where a directory is expected — forces a failure.
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, 'agents'), 'not-a-dir');

    let results;
    expect(() => { results = share.shareLink('partial'); }).not.toThrow();

    const byName = Object.fromEntries(results.map((r) => [r.sub, r.status]));
    expect(byName.agents).toBe('failed');
    expect(byName.projects).toBe('linked');
    expect(byName.skills).toBe('linked');
    // commands is attempted even though agents (earlier in the list) failed.
    expect(byName.commands).toBe('linked');
    expect(fs.lstatSync(path.join(pdir, 'commands')).isSymbolicLink()).toBe(true);
  });

  it('collision counter falls back to __<profile>_2 when first rename also collides', () => {
    // Pre-seed shared with both `dup` and `dup__work` already taken,
    // so migrating profile "work" with its own `dup` must end up at `dup__work_2`.
    const sharedProjects = path.join(tmpHome, '.claude-shared', 'projects');
    fs.mkdirSync(path.join(sharedProjects, 'dup'), { recursive: true });
    fs.writeFileSync(path.join(sharedProjects, 'dup', 's.txt'), 'original');
    fs.mkdirSync(path.join(sharedProjects, 'dup__work'), { recursive: true });
    fs.writeFileSync(path.join(sharedProjects, 'dup__work', 'a.txt'), 'pre-existing');

    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(path.join(pdir, 'projects', 'dup'), { recursive: true });
    fs.writeFileSync(path.join(pdir, 'projects', 'dup', 'mine.txt'), 'from-work');

    share.shareLink('work');

    expect(fs.readFileSync(path.join(sharedProjects, 'dup', 's.txt'), 'utf8')).toBe('original');
    expect(fs.readFileSync(path.join(sharedProjects, 'dup__work', 'a.txt'), 'utf8')).toBe('pre-existing');
    expect(fs.readFileSync(path.join(sharedProjects, 'dup__work_2', 'mine.txt'), 'utf8')).toBe('from-work');
  });
});
