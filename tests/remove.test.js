import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import cli from '../lib/cli.js';
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
    // Build a linked profile via the real share.shareLink so we exercise
    // the same junction/symlink code path 'cc remove' has to undo.
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(path.join(pdir, 'projects'), { recursive: true });

    // Pre-populate shared with a sentinel file BEFORE linking.
    const sharedProjects = path.join(tmpHome, '.claude-shared', 'projects');
    fs.mkdirSync(sharedProjects, { recursive: true });
    fs.writeFileSync(path.join(sharedProjects, 'SENTINEL.txt'), 'do not delete me');

    share.shareLink('work');

    // Now the profile's projects/ should be a link to shared.
    expect(fs.lstatSync(path.join(pdir, 'projects')).isSymbolicLink()).toBe(true);
    // Verify the sentinel is visible through the link.
    expect(fs.readFileSync(path.join(pdir, 'projects', 'SENTINEL.txt'), 'utf8')).toBe('do not delete me');

    // Remove the profile dir.
    cli.removeRecursivelyPreservingLinks(pdir);

    // The profile dir is gone.
    expect(fs.existsSync(pdir)).toBe(false);
    // The SHARED target survives — this is the critical safety invariant.
    expect(fs.existsSync(sharedProjects)).toBe(true);
    expect(fs.readFileSync(path.join(sharedProjects, 'SENTINEL.txt'), 'utf8')).toBe('do not delete me');
  });

  it('removes a profile that has private (non-linked) projects/', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(path.join(pdir, 'projects', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(pdir, 'projects', 'sub', 'a.txt'), 'private');
    fs.writeFileSync(path.join(pdir, '.credentials.json'), '{}');

    cli.removeRecursivelyPreservingLinks(pdir);

    expect(fs.existsSync(pdir)).toBe(false);
  });

  it('is a no-op on a missing path', () => {
    expect(() =>
      cli.removeRecursivelyPreservingLinks(path.join(tmpHome, 'no-such-thing')),
    ).not.toThrow();
  });

  it('removes a directory containing a mix of files, dirs, and a junction', () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'mixed');
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, 'file.txt'), 'x');
    fs.mkdirSync(path.join(pdir, 'subdir'));
    fs.writeFileSync(path.join(pdir, 'subdir', 'inner.txt'), 'y');

    const sharedProjects = path.join(tmpHome, '.claude-shared', 'projects');
    fs.mkdirSync(sharedProjects, { recursive: true });
    fs.writeFileSync(path.join(sharedProjects, 'KEEP.txt'), 'must-survive');

    // Make pdir/projects a junction to shared/projects
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(sharedProjects, path.join(pdir, 'projects'), linkType);

    cli.removeRecursivelyPreservingLinks(pdir);

    expect(fs.existsSync(pdir)).toBe(false);
    expect(fs.readFileSync(path.join(sharedProjects, 'KEEP.txt'), 'utf8')).toBe('must-survive');
  });
});
