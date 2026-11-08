import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import update from '../lib/update.js';

describe('update notice', () => {
  let tmpHome;
  let originalHomedir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-update-'));
    originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
  });

  afterEach(() => {
    os.homedir = originalHomedir;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('compares versions numerically', () => {
    expect(update.isNewer('0.6.10', '0.6.9')).toBe(true);
    expect(update.isNewer('1.0.0', '0.9.9')).toBe(true);
    expect(update.isNewer('0.6.1', '0.6.1')).toBe(false);
    expect(update.isNewer('0.6.0', '0.6.1')).toBe(false);
    expect(update.isNewer('garbage', '0.6.1')).toBe(false);
    expect(update.isNewer('0.7.0-beta.1', '0.6.1')).toBe(false);
  });

  it('reports a newer cached version and stays quiet otherwise', () => {
    expect(update.available('0.6.1')).toBe(null);
    update.writeCache({ checkedAt: Date.now(), latest: '0.7.0' });
    expect(update.available('0.6.1')).toEqual({ current: '0.6.1', latest: '0.7.0' });
    expect(update.notice('0.6.1')).toMatch(/cchost 0\.7\.0 is available \(you have 0\.6\.1\).*npm install -g cchost@latest/);
    expect(update.notice('0.7.0')).toBe(null);
  });

  it('checks at most once a day', () => {
    expect(update.due()).toBe(true);
    update.writeCache({ checkedAt: Date.now() });
    expect(update.due()).toBe(false);
    update.writeCache({ checkedAt: Date.now() - update.DAY_MS - 1 });
    expect(update.due()).toBe(true);
  });

  it('can be turned off', () => {
    expect(update.disabled({ CCHOST_NO_UPDATE_CHECK: '1' })).toBe(true);
    expect(update.disabled({ CI: 'true' })).toBe(true);
    expect(update.disabled({})).toBe(false);
  });

  it('survives a corrupt cache file', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude-profiles'), { recursive: true });
    fs.writeFileSync(update.cacheFile(), '{not json');
    expect(update.available('0.6.1')).toBe(null);
    expect(update.due()).toBe(true);
  });
});
