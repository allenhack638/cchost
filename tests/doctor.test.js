import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import cli from '../lib/cli.js';
import doctor from '../lib/doctor.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

async function withTmpHome(fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-doctor-'));
  const originalHomedir = os.homedir;
  os.homedir = () => tmpHome;
  try {
    return await fn(tmpHome);
  } finally {
    os.homedir = originalHomedir;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

// ── Flag parsing ──────────────────────────────────────────────────────────────

describe('cc doctor — flag parsing', () => {
  let originalWrite;
  beforeEach(() => { originalWrite = process.stdout.write; process.stdout.write = () => true; });
  afterEach(() => { process.stdout.write = originalWrite; });

  it('rejects unknown flags', async () => {
    await expect(cli.run(['doctor', '--bogus'])).rejects.toThrow(/Unknown flag: --bogus/);
  });

  it('rejects --force without --fix', async () => {
    await withTmpHome(async () => {
      await expect(cli.run(['doctor', '--force'])).rejects.toThrow(/--force requires --fix/);
    });
  });

  it('accepts --json without error', async () => {
    let out = '';
    process.stdout.write = (s) => { out += s; return true; };
    await withTmpHome(() => cli.run(['doctor', '--json']));
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('summary');
    expect(parsed).toHaveProperty('checks');
  });

  it('accepts --fix without error', async () => {
    const code = await withTmpHome(() => cli.run(['doctor', '--fix']));
    expect([0, 1, 2]).toContain(code);
  });

  it('accepts --fix --force without error', async () => {
    const code = await withTmpHome(() => cli.run(['doctor', '--fix', '--force']));
    expect([0, 1, 2]).toContain(code);
  });
});

// ── JSON output structure ─────────────────────────────────────────────────────

describe('cc doctor --json', () => {
  it('emits valid JSON with summary.ok/warn/error and checks array', async () => {
    let out = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = (s) => { out += s; return true; };
    try {
      await withTmpHome(() => cli.run(['doctor', '--json']));
    } finally {
      process.stdout.write = originalWrite;
    }
    const parsed = JSON.parse(out);
    expect(typeof parsed.summary.ok).toBe('number');
    expect(typeof parsed.summary.warn).toBe('number');
    expect(typeof parsed.summary.error).toBe('number');
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks.length).toBeGreaterThan(0);
  });

  it('each check has group, name, status, message fields', async () => {
    let out = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = (s) => { out += s; return true; };
    try {
      await withTmpHome(() => cli.run(['doctor', '--json']));
    } finally {
      process.stdout.write = originalWrite;
    }
    const { checks } = JSON.parse(out);
    for (const c of checks) {
      expect(c).toHaveProperty('group');
      expect(c).toHaveProperty('name');
      expect(['ok', 'warn', 'error']).toContain(c.status);
      expect(c).toHaveProperty('message');
    }
  });

  it('summary counts match checks array', async () => {
    let out = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = (s) => { out += s; return true; };
    try {
      await withTmpHome(() => cli.run(['doctor', '--json']));
    } finally {
      process.stdout.write = originalWrite;
    }
    const { summary, checks } = JSON.parse(out);
    const expected = { ok: 0, warn: 0, error: 0 };
    for (const c of checks) expected[c.status]++;
    expect(summary.ok).toBe(expected.ok);
    expect(summary.warn).toBe(expected.warn);
    expect(summary.error).toBe(expected.error);
  });
});

// ── Exit codes ────────────────────────────────────────────────────────────────

describe('cc doctor — exit codes', () => {
  let originalWrite;
  beforeEach(() => { originalWrite = process.stdout.write; process.stdout.write = () => true; });
  afterEach(() => { process.stdout.write = originalWrite; });

  it('exit code reflects the worst check status', async () => {
    // Deterministic regardless of host: derive the expected code from the
    // checks doctor actually runs, then confirm the exit code matches.
    // (CI has no `claude` installed, so the real environment is not "clean".)
    await withTmpHome(async (home) => {
      fs.mkdirSync(path.join(home, '.claude-profiles'));
      const results = doctor.runChecks();
      const hasError = results.some(r => r.status === 'error');
      const hasWarn = results.some(r => r.status === 'warn');
      const expected = hasError ? 2 : hasWarn ? 1 : 0;
      const code = await cli.run(['doctor']);
      expect(code).toBe(expected);
    });
  });

  it('returns 2 when there is an error check', async () => {
    // Make ~/.claude-profiles/ NOT writable to force a Storage error
    // Easier: inject a corrupt .claude.json via a real profile dir
    const code = await withTmpHome(async (home) => {
      const profDir = path.join(home, '.claude-profiles', 'broken');
      fs.mkdirSync(profDir, { recursive: true });
      fs.writeFileSync(path.join(profDir, '.claude.json'), '{not valid json}');
      return cli.run(['doctor']);
    });
    expect(code).toBe(2);
  });
});

// ── --fix applies safe fixes ──────────────────────────────────────────────────

describe('cc doctor --fix', () => {
  let originalWrite;
  beforeEach(() => { originalWrite = process.stdout.write; process.stdout.write = () => true; });
  afterEach(() => { process.stdout.write = originalWrite; });

  it('creates missing ~/.claude-profiles/ when --fix is passed', async () => {
    await withTmpHome(async (home) => {
      const dir = path.join(home, '.claude-profiles');
      expect(fs.existsSync(dir)).toBe(false);
      await cli.run(['doctor', '--fix']);
      expect(fs.existsSync(dir)).toBe(true);
    });
  });

  it('emits only JSON when --fix and --json are combined', async () => {
    let out = '';
    let err = '';
    const originalStdout = process.stdout.write;
    const originalStderr = process.stderr.write;
    process.stdout.write = (s) => { out += s; return true; };
    process.stderr.write = (s) => { err += s; return true; };
    try {
      await withTmpHome(() => cli.run(['doctor', '--fix', '--json']));
    } finally {
      process.stdout.write = originalStdout;
      process.stderr.write = originalStderr;
    }
    expect(() => JSON.parse(out)).not.toThrow();
    expect(out.trim().startsWith('{')).toBe(true);
    const parsed = JSON.parse(out);
    const storage = parsed.checks.find((c) => c.name === '~/.claude-profiles/');
    expect(storage.status).toBe('ok');
    // Fix progress belongs on stderr, never in the JSON document.
    expect(err).toMatch(/Fixing:|Nothing auto-fixable/);
  });
});

// ── Individual check functions ────────────────────────────────────────────────

describe('doctor.runChecks — individual checks', () => {
  it('Node.js version check is ok (this process is >= 18)', () => {
    withTmpHome(() => {
      const results = doctor.runChecks();
      const c = results.find(r => r.name === 'Node.js version');
      expect(c).toBeDefined();
      expect(c.status).toBe('ok');
    });
  });

  it('conflicting env vars check is ok when none are set', () => {
    const saved = {};
    const vars = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];
    for (const k of vars) { saved[k] = process.env[k]; delete process.env[k]; }
    try {
      withTmpHome(() => {
        const results = doctor.runChecks();
        const c = results.find(r => r.name === 'conflicting env vars');
        expect(c.status).toBe('ok');
      });
    } finally {
      for (const k of vars) { if (saved[k] !== undefined) process.env[k] = saved[k]; }
    }
  });

  it('conflicting env vars check warns when one is set', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      withTmpHome(() => {
        const results = doctor.runChecks();
        const c = results.find(r => r.name === 'conflicting env vars');
        expect(c.status).toBe('warn');
        expect(c.message).toContain('ANTHROPIC_API_KEY');
      });
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('profiles dir check warns when dir is missing, with a safe fix', () => {
    withTmpHome(() => {
      const results = doctor.runChecks();
      const c = results.find(r => r.name === '~/.claude-profiles/');
      expect(c).toBeDefined();
      expect(c.status).toBe('warn');
      expect(c.fix).not.toBeNull();
      expect(c.fix.safe).toBe(true);
      expect(typeof c.fix.apply).toBe('function');
    });
  });

  it('profile .claude.json check is ok when file does not exist', () => {
    withTmpHome((home) => {
      const profDir = path.join(home, '.claude-profiles', 'demo');
      fs.mkdirSync(profDir, { recursive: true });
      const results = doctor.runChecks();
      const c = results.find(r => r.name === '"demo" .claude.json');
      expect(c).toBeDefined();
      expect(c.status).toBe('ok');
    });
  });

  it('profile .claude.json check errors on invalid JSON, with a force fix', () => {
    withTmpHome((home) => {
      const profDir = path.join(home, '.claude-profiles', 'broken');
      fs.mkdirSync(profDir, { recursive: true });
      fs.writeFileSync(path.join(profDir, '.claude.json'), '{bad json}');
      const results = doctor.runChecks();
      const c = results.find(r => r.name === '"broken" .claude.json');
      expect(c).toBeDefined();
      expect(c.status).toBe('error');
      expect(c.fix.safe).toBe(false);
      expect(typeof c.fix.apply).toBe('function');
    });
  });

  it('--fix --force backs up corrupt .claude.json and resets it', async () => {
    let out = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = (s) => { out += s; return true; };
    try {
      await withTmpHome(async (home) => {
        const profDir = path.join(home, '.claude-profiles', 'broken');
        fs.mkdirSync(profDir, { recursive: true });
        const jsonPath = path.join(profDir, '.claude.json');
        fs.writeFileSync(jsonPath, '{bad json}');

        let prompted = false;
        const fakePrompt = async () => { prompted = true; return 'y'; };
        await doctor.runDoctor({ fix: true, force: true, json: false, prompt: fakePrompt });

        expect(prompted).toBe(true);
        expect(JSON.parse(fs.readFileSync(jsonPath, 'utf8'))).toEqual({});
        const baks = fs.readdirSync(profDir).filter(f => f.startsWith('.claude.json.bak.'));
        expect(baks.length).toBe(1);
      });
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});

describe('cchost doctor — PATH shadow check', () => {
  const originalPath = process.env.PATH;
  const originalWinPath = process.env.Path;
  const originalPathExt = process.env.PATHEXT;
  let tmpDirs = [];

  function tmpDir() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-path-'));
    tmpDirs.push(d);
    return d;
  }

  function writeBin(dir, name) {
    const file = path.join(dir, process.platform === 'win32' ? `${name}.cmd` : name);
    fs.writeFileSync(file, '');
    return file;
  }

  function writeCmd(dir, name, content) {
    const file = path.join(dir, `${name}.CMD`);
    fs.writeFileSync(file, content);
    return file;
  }

  function setPath(dirs, sep = path.delimiter) {
    const value = dirs.join(sep);
    process.env.PATH = value;
    process.env.Path = value;
  }

  afterEach(() => {
    process.env.PATH = originalPath;
    process.env.Path = originalWinPath;
    if (originalPathExt === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = originalPathExt;
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs = [];
  });

  it('ignores the system C compiler at /usr/bin/cc', () => {
    if (process.platform === 'win32' || !fs.existsSync('/usr/bin/cc')) return;
    const dir = tmpDir();
    writeBin(dir, 'cchost');
    setPath(['/usr/bin', dir]);
    const result = doctor.checkCcShadow();
    expect(result.status).toBe('ok');
    expect(result.message).toContain(dir);
  });

  it('does not count a bare cc compiler as cchost', () => {
    if (process.platform === 'win32') return;
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'cc'), '#!/bin/sh\nexec clang "$@"\n');
    setPath([dir]);
    const result = doctor.checkCcShadow('linux');
    expect(result.status).toBe('ok');
    expect(result.message).toMatch(/not found/i);
    expect(result.message).not.toContain(path.join(dir, 'cc'));
  });

  it('counts cchost and cc symlinks from one install as a single entry', () => {
    if (process.platform === 'win32') return;
    const dir = tmpDir();
    const pkgBin = path.join(dir, 'pkg', 'cchost', 'bin');
    fs.mkdirSync(pkgBin, { recursive: true });
    const target = path.join(pkgBin, 'cc.js');
    fs.writeFileSync(target, '#!/usr/bin/env node\n// cchost\n');
    fs.symlinkSync(target, path.join(dir, 'cchost'));
    fs.symlinkSync(target, path.join(dir, 'cc'));
    setPath([dir]);
    const result = doctor.checkCcShadow();
    expect(result.status).toBe('ok');
    expect(result.message).toContain(path.join(dir, 'cchost'));
  });

  it('warns when two separate cchost installs are on PATH', () => {
    const a = tmpDir();
    const b = tmpDir();
    writeBin(a, 'cchost');
    writeBin(b, 'cchost');
    setPath([a, b]);
    const result = doctor.checkCcShadow();
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/multiple/i);
  });

  it('treats cc.cmd and cchost.cmd pointing at the same install as one', () => {
    const dir = tmpDir();
    const shim = '@echo off\r\n"%dp0%\\node_modules\\cchost\\bin\\cc.js" %*\r\n';
    writeCmd(dir, 'cchost', shim);
    writeCmd(dir, 'cc', shim);
    process.env.PATHEXT = '.CMD';
    setPath([dir], ';');
    const result = doctor.checkCcShadow('win32');
    expect(result.status).toBe('ok');
  });

  it('detects a stale cc.cmd next to a fresh cchost.cmd on Windows', () => {
    const dir = tmpDir();
    writeCmd(dir, 'cchost', '@echo off\r\n"%dp0%\\node_modules\\cchost\\bin\\cc.js" %*\r\n');
    writeCmd(dir, 'cc', '@echo off\r\n"C:\\old\\node_modules\\cchost\\bin\\cc.js" %*\r\n');
    process.env.PATHEXT = '.CMD';
    setPath([dir], ';');
    const result = doctor.checkCcShadow('win32');
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/multiple/i);
  });

  it('detects two Windows installs whose shims use %dp0%', () => {
    const a = tmpDir();
    const b = tmpDir();
    const shim = '@echo off\r\n"%dp0%\\node_modules\\cchost\\bin\\cc.js" %*\r\n';
    writeCmd(a, 'cchost', shim);
    writeCmd(b, 'cchost', shim);
    process.env.PATHEXT = '.CMD';
    setPath([a, b], ';');
    const result = doctor.checkCcShadow('win32');
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/multiple/i);
  });
});

describe('cchost doctor — macOS Keychain note', () => {
  function addProfile(home, name, { endpoint = false } = {}) {
    const dir = path.join(home, '.claude-profiles', name);
    fs.mkdirSync(dir, { recursive: true });
    if (endpoint) {
      fs.writeFileSync(
        path.join(dir, '.cc-env.json'),
        JSON.stringify({ base_url: 'https://x', auth_token: 'sk' }),
      );
    } else {
      fs.writeFileSync(
        path.join(dir, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: `${name}@example.com` } }),
      );
    }
  }

  it('warns only when two logged-in subscription profiles share the Keychain', async () => {
    await withTmpHome(async (home) => {
      addProfile(home, 'one');
      expect(doctor.checkMacKeychain('darwin').status).toBe('ok');
      addProfile(home, 'two');
      const mac = doctor.checkMacKeychain('darwin');
      expect(mac.status).toBe('warn');
      expect(mac.message).toMatch(/separate macOS users|custom-endpoint/i);
      expect(doctor.checkMacKeychain('linux')).toBeNull();
    });
  });

  it('does not warn for an endpoint-only setup or a logged-out profile', async () => {
    await withTmpHome(async (home) => {
      addProfile(home, 'endpoint-a', { endpoint: true });
      addProfile(home, 'endpoint-b', { endpoint: true });
      fs.mkdirSync(path.join(home, '.claude-profiles', 'logged-out'), { recursive: true });
      expect(doctor.checkMacKeychain('darwin').status).toBe('ok');
    });
  });

  it('is ok with no profiles', async () => {
    await withTmpHome(async () => {
      expect(doctor.checkMacKeychain('darwin').status).toBe('ok');
    });
  });
});
