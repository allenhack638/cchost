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
