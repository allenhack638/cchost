import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { removeRecursivelyPreservingLinks } from '../lib/fsutil.js';
import share from '../lib/share.js';

describe('removeRecursivelyPreservingLinks — junction safety', () => {
  let tmpHome;
  let originalHomedir;
  let originalLog;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rm-'));
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

  it('deletes the link but leaves the shared target intact', () => {
    // Use the real shareLink so this undoes the same junction/symlink path as 'cc remove'.
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(path.join(pdir, 'projects'), { recursive: true });

    const sharedProjects = path.join(tmpHome, '.claude', 'projects');
    fs.mkdirSync(sharedProjects, { recursive: true });
    fs.writeFileSync(path.join(sharedProjects, 'SENTINEL.txt'), 'do not delete me');

    share.shareLink('work');

    expect(fs.lstatSync(path.join(pdir, 'projects')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(pdir, 'projects', 'SENTINEL.txt'), 'utf8')).toBe('do not delete me');

    removeRecursivelyPreservingLinks(pdir);

    expect(fs.existsSync(pdir)).toBe(false);
    // The shared target survives: the key safety invariant.
    expect(fs.existsSync(sharedProjects)).toBe(true);
    expect(fs.readFileSync(path.join(sharedProjects, 'SENTINEL.txt'), 'utf8')).toBe('do not delete me');
  });

  it('removes a profile that has private (non-linked) projects/', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(path.join(pdir, 'projects', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(pdir, 'projects', 'sub', 'a.txt'), 'private');
    fs.writeFileSync(path.join(pdir, '.credentials.json'), '{}');

    removeRecursivelyPreservingLinks(pdir);

    expect(fs.existsSync(pdir)).toBe(false);
  });

  it('is a no-op on a missing path', () => {
    expect(() =>
      removeRecursivelyPreservingLinks(path.join(tmpHome, 'no-such-thing')),
    ).not.toThrow();
  });

  it('removes a directory containing a mix of files, dirs, and a junction', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'mixed');
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, 'file.txt'), 'x');
    fs.mkdirSync(path.join(pdir, 'subdir'));
    fs.writeFileSync(path.join(pdir, 'subdir', 'inner.txt'), 'y');

    const sharedProjects = path.join(tmpHome, '.claude', 'projects');
    fs.mkdirSync(sharedProjects, { recursive: true });
    fs.writeFileSync(path.join(sharedProjects, 'KEEP.txt'), 'must-survive');

    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(sharedProjects, path.join(pdir, 'projects'), linkType);

    removeRecursivelyPreservingLinks(pdir);

    expect(fs.existsSync(pdir)).toBe(false);
    expect(fs.readFileSync(path.join(sharedProjects, 'KEEP.txt'), 'utf8')).toBe('must-survive');
  });
});
