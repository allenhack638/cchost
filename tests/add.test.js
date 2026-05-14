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

  it('creates a profile dir without aliases', () => {
    const { dir, alias } = profiles.addProfile('work', {});
    expect(fs.existsSync(dir)).toBe(true);
    expect(alias).toEqual({});
    expect(fs.existsSync(path.join(dir, '.cc-alias.json'))).toBe(false);
  });

  it('writes .cc-alias.json with provided aliases', () => {
    profiles.addProfile('work', { email: 'a@b.com', org: 'Acme', name: 'Work' });
    const aliasFile = path.join(tmpHome, '.claude-profiles', 'work', '.cc-alias.json');
    expect(fs.existsSync(aliasFile)).toBe(true);
    const data = JSON.parse(fs.readFileSync(aliasFile, 'utf8'));
    expect(data).toEqual({ email: 'a@b.com', org: 'Acme', name: 'Work' });
  });

  it('rejects an unknown alias key', () => {
    expect(() => profiles.addProfile('work', { unknown: 'x' })).toThrow(/Unknown flag/);
  });

  it('rejects empty alias values', () => {
    expect(() => profiles.addProfile('work', { email: '' })).toThrow(/non-empty/);
  });

  it('refuses to overwrite an existing profile', () => {
    profiles.addProfile('work', {});
    expect(() => profiles.addProfile('work', {})).toThrow(/already exists/);
  });

  it('rejects invalid profile names', () => {
    expect(() => profiles.addProfile('a/b', {})).toThrow(/disallowed/);
  });
});

describe('readAlias', () => {
  let tmpHome;
  let originalHomedir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-alias-r-'));
    originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
  });

  afterEach(() => {
    os.homedir = originalHomedir;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns empty object when no file', () => {
    const dir = path.join(tmpHome, '.claude-profiles', 'p');
    fs.mkdirSync(dir, { recursive: true });
    expect(profiles.readAlias(dir)).toEqual({});
  });

  it('returns empty object on malformed JSON', () => {
    const dir = path.join(tmpHome, '.claude-profiles', 'p');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.cc-alias.json'), 'not json {');
    expect(profiles.readAlias(dir)).toEqual({});
  });

  it('strips unknown keys', () => {
    const dir = path.join(tmpHome, '.claude-profiles', 'p');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.cc-alias.json'),
      JSON.stringify({ email: 'a@b.com', evil: 'x' }),
    );
    expect(profiles.readAlias(dir)).toEqual({ email: 'a@b.com' });
  });
});

describe('applyAlias', () => {
  let tmpHome;
  let originalHomedir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-alias-a-'));
    originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
  });

  afterEach(() => {
    os.homedir = originalHomedir;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('is a no-op when there is no alias', () => {
    const dir = path.join(tmpHome, '.claude-profiles', 'p');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'real@example.com' } }),
    );
    expect(profiles.applyAlias(dir)).toBe(false);
    const data = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'));
    expect(data.oauthAccount.emailAddress).toBe('real@example.com');
  });

  it('is a no-op when .claude.json does not exist (not yet logged in)', () => {
    profiles.addProfile('p', { email: 'alias@example.com' });
    const dir = path.join(tmpHome, '.claude-profiles', 'p');
    expect(profiles.applyAlias(dir)).toBe(false);
  });

  it('merges alias into existing oauthAccount', () => {
    profiles.addProfile('p', { email: 'alias@example.com', org: 'AliasCo', name: 'Alias' });
    const dir = path.join(tmpHome, '.claude-profiles', 'p');
    fs.writeFileSync(
      path.join(dir, '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'real@example.com', organizationName: 'RealCo', other: 'untouched' },
      }),
    );
    expect(profiles.applyAlias(dir)).toBe(true);
    const data = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'));
    expect(data.oauthAccount.emailAddress).toBe('alias@example.com');
    expect(data.oauthAccount.organizationName).toBe('AliasCo');
    expect(data.oauthAccount.displayName).toBe('Alias');
    expect(data.oauthAccount.other).toBe('untouched');
  });

  it('is idempotent — second apply does not rewrite', () => {
    profiles.addProfile('p', { email: 'alias@example.com' });
    const dir = path.join(tmpHome, '.claude-profiles', 'p');
    fs.writeFileSync(
      path.join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'real@example.com' } }),
    );
    expect(profiles.applyAlias(dir)).toBe(true);
    expect(profiles.applyAlias(dir)).toBe(false);
  });

  it('skips when oauthAccount is missing', () => {
    profiles.addProfile('p', { email: 'alias@example.com' });
    const dir = path.join(tmpHome, '.claude-profiles', 'p');
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ other: 'field' }));
    expect(profiles.applyAlias(dir)).toBe(false);
    const data = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'));
    expect(data.other).toBe('field');
    expect(data.oauthAccount).toBeUndefined();
  });
});
