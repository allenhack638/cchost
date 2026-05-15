import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import profiles from '../lib/profiles.js';

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
