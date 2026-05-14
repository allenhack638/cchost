import { describe, it, expect } from 'vitest';
import spawnLib from '../lib/spawn.js';

describe('parseVersion', () => {
  it('parses plain x.y.z', () => {
    expect(spawnLib.parseVersion('2.1.140')).toEqual({ major: 2, minor: 1, patch: 140, raw: '2.1.140' });
  });

  it('parses x.y.z embedded in text', () => {
    expect(spawnLib.parseVersion('Claude Code 2.1.59 (build abc)')).toMatchObject({ major: 2, minor: 1, patch: 59 });
  });

  it('returns null for non-version text', () => {
    expect(spawnLib.parseVersion('no version here')).toBeNull();
    expect(spawnLib.parseVersion('')).toBeNull();
    expect(spawnLib.parseVersion(null)).toBeNull();
  });
});

describe('compareVersion', () => {
  it('returns negative when version is below target', () => {
    expect(spawnLib.compareVersion({ major: 2, minor: 1, patch: 59 }, [2, 1, 140])).toBeLessThan(0);
    expect(spawnLib.compareVersion({ major: 2, minor: 0, patch: 999 }, [2, 1, 0])).toBeLessThan(0);
    expect(spawnLib.compareVersion({ major: 1, minor: 99, patch: 99 }, [2, 0, 0])).toBeLessThan(0);
  });

  it('returns 0 when version equals target', () => {
    expect(spawnLib.compareVersion({ major: 2, minor: 1, patch: 140 }, [2, 1, 140])).toBe(0);
  });

  it('returns positive when version is above target', () => {
    expect(spawnLib.compareVersion({ major: 2, minor: 1, patch: 141 }, [2, 1, 140])).toBeGreaterThan(0);
    expect(spawnLib.compareVersion({ major: 3, minor: 0, patch: 0 }, [2, 9, 999])).toBeGreaterThan(0);
  });

  it('returns 0 when version is falsy', () => {
    expect(spawnLib.compareVersion(null, [2, 1, 140])).toBe(0);
  });
});

describe('escapeArgWin', () => {
  // Note: this returns args ready for cmd.exe through CreateProcess with
  // windowsVerbatimArguments: the outer double-quotes get caret-escaped so
  // cmd.exe doesn't interpret them as quote boundaries.

  it('wraps and caret-escapes the wrapping quotes', () => {
    expect(spawnLib.escapeArgWin('hello')).toBe('^"hello^"');
  });

  it('escapes internal double quotes by backslash-escaping after the meta pass', () => {
    // raw: "a\"b" → caret-escape each " → ^"a\^"b^"
    expect(spawnLib.escapeArgWin('a"b')).toBe('^"a\\^"b^"');
  });

  it('doubles trailing backslashes so the closing quote isn\'t escaped', () => {
    expect(spawnLib.escapeArgWin('path\\')).toBe('^"path\\\\^"');
  });

  it('caret-escapes cmd metacharacters inside the arg', () => {
    expect(spawnLib.escapeArgWin('a&b')).toBe('^"a^&b^"');
  });

  it('caret-escapes spaces so cmd.exe doesn\'t split on them', () => {
    const out = spawnLib.escapeArgWin('two words');
    expect(out).toBe('^"two^ words^"');
  });
});

describe('escapeCommandWin', () => {
  it('caret-escapes the space in "Program Files"', () => {
    expect(spawnLib.escapeCommandWin('C:\\Program Files\\claude.cmd')).toBe('C:\\Program^ Files\\claude.cmd');
  });

  it('leaves benign paths alone', () => {
    expect(spawnLib.escapeCommandWin('C:\\bin\\claude.cmd')).toBe('C:\\bin\\claude.cmd');
  });
});
