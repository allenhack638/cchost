import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import profiles from '../lib/profiles.js';

describe('validateProfileName', () => {
  it('accepts simple names', () => {
    expect(profiles.validateProfileName('work')).toBe('work');
    expect(profiles.validateProfileName('side-project_2')).toBe('side-project_2');
    expect(profiles.validateProfileName('a')).toBe('a');
  });

  it('rejects names with whitespace', () => {
    expect(() => profiles.validateProfileName('two words')).toThrow(/whitespace/);
    expect(() => profiles.validateProfileName('tab\tname')).toThrow(/whitespace/);
  });

  it('rejects path separators and shell metachars', () => {
    expect(() => profiles.validateProfileName('a/b')).toThrow(/disallowed/);
    expect(() => profiles.validateProfileName('a\\b')).toThrow(/disallowed/);
    expect(() => profiles.validateProfileName('a:b')).toThrow(/disallowed/);
    expect(() => profiles.validateProfileName('a*b')).toThrow(/disallowed/);
    expect(() => profiles.validateProfileName('a"b')).toThrow(/disallowed/);
  });

  it('rejects path traversal', () => {
    expect(() => profiles.validateProfileName('..')).toThrow(/dot/);
    expect(() => profiles.validateProfileName('.hidden')).toThrow(/dot/);
    expect(() => profiles.validateProfileName('../escape')).toThrow();
  });

  it('rejects names that start with "-" (looks like a flag)', () => {
    expect(() => profiles.validateProfileName('--resume')).toThrow(/looks like a flag/);
    expect(() => profiles.validateProfileName('-h')).toThrow(/looks like a flag/);
    expect(() => profiles.validateProfileName('--email=foo')).toThrow(/looks like a flag/);
  });

  it('rejects DOS reserved names case-insensitively', () => {
    for (const name of ['CON', 'con', 'PRN', 'COM1', 'lpt9']) {
      expect(() => profiles.validateProfileName(name)).toThrow(/reserved/);
    }
  });

  it('rejects names longer than 64 chars', () => {
    expect(() => profiles.validateProfileName('a'.repeat(65))).toThrow(/64/);
    expect(profiles.validateProfileName('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it('rejects empty / non-string', () => {
    expect(() => profiles.validateProfileName('')).toThrow(/required/);
    expect(() => profiles.validateProfileName(undefined)).toThrow(/required/);
    expect(() => profiles.validateProfileName(null)).toThrow(/required/);
  });

  it('attaches exitCode=2 to thrown errors', () => {
    try {
      profiles.validateProfileName('bad/name');
    } catch (e) {
      expect(e.exitCode).toBe(2);
    }
  });
});

describe('listProfiles', () => {
  let tmpHome;
  let originalHomedir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
    originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
  });

  afterEach(() => {
    os.homedir = originalHomedir;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns empty when base dir does not exist', () => {
    expect(profiles.listProfiles()).toEqual([]);
  });

  it('returns alphabetically sorted profiles', () => {
    const base = path.join(tmpHome, '.claude-profiles');
    fs.mkdirSync(path.join(base, 'zeta'), { recursive: true });
    fs.mkdirSync(path.join(base, 'alpha'), { recursive: true });
    fs.mkdirSync(path.join(base, 'mu'), { recursive: true });
    const list = profiles.listProfiles();
    expect(list.map((p) => p.name)).toEqual(['alpha', 'mu', 'zeta']);
  });

  it('detects loggedIn from .credentials.json', () => {
    const base = path.join(tmpHome, '.claude-profiles');
    fs.mkdirSync(path.join(base, 'in'), { recursive: true });
    fs.writeFileSync(path.join(base, 'in', '.credentials.json'), '{}');
    fs.mkdirSync(path.join(base, 'out'), { recursive: true });
    const list = profiles.listProfiles();
    expect(list.find((p) => p.name === 'in').loggedIn).toBe(true);
    expect(list.find((p) => p.name === 'out').loggedIn).toBe(false);
  });

  it('reads email from .claude.json oauthAccount.emailAddress', () => {
    const base = path.join(tmpHome, '.claude-profiles');
    fs.mkdirSync(path.join(base, 'p'), { recursive: true });
    fs.writeFileSync(
      path.join(base, 'p', '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'user@example.com' } }),
    );
    const list = profiles.listProfiles();
    expect(list[0].email).toBe('user@example.com');
  });

  it('survives malformed .claude.json with empty email and keeps other profiles', () => {
    const base = path.join(tmpHome, '.claude-profiles');
    fs.mkdirSync(path.join(base, 'bad'), { recursive: true });
    fs.writeFileSync(path.join(base, 'bad', '.claude.json'), 'this is { not json');
    fs.mkdirSync(path.join(base, 'good'), { recursive: true });
    fs.writeFileSync(
      path.join(base, 'good', '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'g@e.com' } }),
    );
    const list = profiles.listProfiles();
    expect(list.find((p) => p.name === 'bad').email).toBe('');
    expect(list.find((p) => p.name === 'good').email).toBe('g@e.com');
  });

  it('survives missing oauthAccount object', () => {
    const base = path.join(tmpHome, '.claude-profiles');
    fs.mkdirSync(path.join(base, 'p'), { recursive: true });
    fs.writeFileSync(path.join(base, 'p', '.claude.json'), JSON.stringify({ other: 'field' }));
    expect(profiles.listProfiles()[0].email).toBe('');
  });
});
