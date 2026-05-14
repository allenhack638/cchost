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

  it('migrates existing content into shared and links the profile dir', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(path.join(pdir, 'projects', 'MyProject'), { recursive: true });
    fs.writeFileSync(path.join(pdir, 'projects', 'MyProject', 'note.txt'), 'work-note');
    fs.mkdirSync(path.join(pdir, 'sessions'), { recursive: true });

    share.shareLink('work');

    const shared = path.join(tmpHome, '.claude-shared');
    expect(fs.existsSync(path.join(shared, 'projects', 'MyProject', 'note.txt'))).toBe(true);
    expect(fs.lstatSync(path.join(pdir, 'projects')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(pdir, 'sessions')).isSymbolicLink()).toBe(true);
  });

  it('renames the second profile\'s colliding project with __<profile> suffix', () => {
    const p1 = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(path.join(p1, 'projects', 'shared-name'), { recursive: true });
    fs.writeFileSync(path.join(p1, 'projects', 'shared-name', 'a.txt'), 'from-work');
    fs.mkdirSync(path.join(p1, 'sessions'), { recursive: true });

    const p2 = path.join(tmpHome, '.claude-profiles', 'personal');
    fs.mkdirSync(path.join(p2, 'projects', 'shared-name'), { recursive: true });
    fs.writeFileSync(path.join(p2, 'projects', 'shared-name', 'b.txt'), 'from-personal');
    fs.mkdirSync(path.join(p2, 'sessions'), { recursive: true });

    share.shareLink('work');
    share.shareLink('personal');

    const sharedProjects = path.join(tmpHome, '.claude-shared', 'projects');
    expect(fs.existsSync(path.join(sharedProjects, 'shared-name', 'a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(sharedProjects, 'shared-name__personal', 'b.txt'))).toBe(true);
  });

  it('is idempotent: linking an already-linked profile does nothing', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'p');
    fs.mkdirSync(path.join(pdir, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(pdir, 'sessions'), { recursive: true });
    share.shareLink('p');
    expect(() => share.shareLink('p')).not.toThrow();
    expect(fs.lstatSync(path.join(pdir, 'projects')).isSymbolicLink()).toBe(true);
  });

  it('shareUnlink restores private dirs with content copied back', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'p');
    fs.mkdirSync(path.join(pdir, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(pdir, 'projects', 'hello.txt'), 'hi');
    fs.mkdirSync(path.join(pdir, 'sessions'), { recursive: true });
    share.shareLink('p');
    share.shareUnlink('p');
    expect(fs.lstatSync(path.join(pdir, 'projects')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(pdir, 'projects', 'hello.txt'), 'utf8')).toBe('hi');
  });

  it('rejects shareLink on non-existent profile', () => {
    expect(() => share.shareLink('ghost')).toThrow(/does not exist/);
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
    fs.mkdirSync(path.join(pdir, 'sessions'), { recursive: true });

    share.shareLink('work');

    expect(fs.readFileSync(path.join(sharedProjects, 'dup', 's.txt'), 'utf8')).toBe('original');
    expect(fs.readFileSync(path.join(sharedProjects, 'dup__work', 'a.txt'), 'utf8')).toBe('pre-existing');
    expect(fs.readFileSync(path.join(sharedProjects, 'dup__work_2', 'mine.txt'), 'utf8')).toBe('from-work');
  });
});
