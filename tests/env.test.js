import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import envLib from '../lib/env.js';
import cli from '../lib/cli.js';

// A scripted IO for the wizard. readLine and readHidden consume `inputs` in
// the order they are called.
function scriptIo(inputs) {
  const state = { i: 0, out: [] };
  return {
    out: state.out,
    write: (s) => state.out.push(s),
    readLine: async () => String(inputs[state.i++] ?? ''),
    readHidden: async () => String(inputs[state.i++] ?? ''),
    text: () => state.out.join(''),
  };
}

describe('env config — library', () => {
  let tmpHome;
  let originalHomedir;
  let originalLog;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-env-'));
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

  function profileDir(name) {
    const d = path.join(tmpHome, '.claude-profiles', name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  describe('buildEnvVars', () => {
    it('sets both ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY', () => {
      const env = envLib.buildEnvVars({ base_url: 'https://x/anthropic', auth_token: 'sk-1' });
      expect(env.ANTHROPIC_BASE_URL).toBe('https://x/anthropic');
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-1');
      expect(env.ANTHROPIC_API_KEY).toBe('sk-1');
    });

    it('omits all model vars when no model fields are set', () => {
      const env = envLib.buildEnvVars({ base_url: 'https://x', auth_token: 'sk-1' });
      expect(env.ANTHROPIC_MODEL).toBeUndefined();
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
      expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
    });

    it('falls back per-tier to model when tier fields are missing', () => {
      const env = envLib.buildEnvVars({ base_url: 'https://x', auth_token: 'sk', model: 'kimi' });
      expect(env.ANTHROPIC_MODEL).toBe('kimi');
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi');
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi');
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi');
      expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('kimi');
    });

    it('uses distinct per-tier values when provided', () => {
      const env = envLib.buildEnvVars({
        base_url: 'https://x', auth_token: 'sk', model: 'm',
        opus: 'o', sonnet: 's', haiku: 'h', subagent: 'a',
      });
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('o');
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('s');
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('h');
      expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('a');
    });
  });

  describe('maskToken', () => {
    it('masks long tokens as first6...last4 (N chars)', () => {
      expect(envLib.maskToken('sk-abcdefghijklmnopqXYZ9')).toBe('sk-abc...XYZ9 (24 chars)');
    });
    it('fully masks short tokens', () => {
      expect(envLib.maskToken('short')).toBe('***** (5 chars)');
    });
  });

  describe('hasOAuthState', () => {
    it('true when .credentials.json exists', () => {
      const d = profileDir('p');
      fs.writeFileSync(path.join(d, '.credentials.json'), '{}');
      expect(envLib.hasOAuthState(d)).toBe(true);
    });
    it('true when .claude.json has a non-null oauthAccount', () => {
      const d = profileDir('p');
      fs.writeFileSync(path.join(d, '.claude.json'), '{"oauthAccount":{"emailAddress":"x@y.com"}}');
      expect(envLib.hasOAuthState(d)).toBe(true);
    });
    it('false when oauthAccount is null or missing', () => {
      const d = profileDir('p');
      fs.writeFileSync(path.join(d, '.claude.json'), '{"oauthAccount":null}');
      expect(envLib.hasOAuthState(d)).toBe(false);
    });
    it('false for a fresh empty profile', () => {
      expect(envLib.hasOAuthState(profileDir('p'))).toBe(false);
    });
  });

  describe('readEnvConfig', () => {
    it('returns null when no file exists', () => {
      expect(envLib.readEnvConfig(profileDir('p'))).toBeNull();
    });
    it('throws a malformed error on garbage JSON', () => {
      const d = profileDir('p');
      fs.writeFileSync(path.join(d, '.cc-env.json'), '{garbage');
      expect(() => envLib.readEnvConfig(d)).toThrow(/malformed/i);
    });
  });

  describe('writeEnvConfig', () => {
    it('persists only the seven defined fields, in order', () => {
      const d = profileDir('p');
      envLib.writeEnvConfig(d, { base_url: 'https://x', auth_token: 'sk', model: 'm', junk: 'no' });
      const raw = JSON.parse(fs.readFileSync(path.join(d, '.cc-env.json'), 'utf8'));
      expect(Object.keys(raw)).toEqual(['base_url', 'auth_token', 'model']);
    });
    it('sets 0600 permissions on POSIX', () => {
      if (process.platform === 'win32') return;
      const d = profileDir('p');
      envLib.writeEnvConfig(d, { base_url: 'https://x', auth_token: 'sk' });
      const mode = fs.statSync(path.join(d, '.cc-env.json')).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe('endpointSummary', () => {
    it('returns the host for a configured profile', () => {
      const d = profileDir('p');
      envLib.writeEnvConfig(d, { base_url: 'https://api.moonshot.ai/anthropic', auth_token: 'sk' });
      expect(envLib.endpointSummary(d)).toBe('api.moonshot.ai');
    });
    it('returns "subscription" when there is no config', () => {
      expect(envLib.endpointSummary(profileDir('p'))).toBe('subscription');
    });
    it('returns "(invalid config)" for malformed JSON, never throws', () => {
      const d = profileDir('p');
      fs.writeFileSync(path.join(d, '.cc-env.json'), '{garbage');
      expect(envLib.endpointSummary(d)).toBe('(invalid config)');
    });
  });

  describe('validation', () => {
    it('rejects a base_url without a scheme', () => {
      expect(() => envLib.validateBaseUrl('moonshot.ai', () => {})).toThrow(/http/);
    });
    it('warns (does not reject) on a /v1 path', () => {
      const warnings = [];
      expect(() => envLib.validateBaseUrl('https://x.com/v1', (m) => warnings.push(m))).not.toThrow();
      expect(warnings.join()).toMatch(/\/v1/);
    });
    it('warns on http:// to a non-local host', () => {
      const warnings = [];
      envLib.validateBaseUrl('http://example.com/anthropic', (m) => warnings.push(m));
      expect(warnings.join()).toMatch(/unencrypted/);
    });
    it('does not warn for http://localhost', () => {
      const warnings = [];
      envLib.validateBaseUrl('http://localhost:8080', (m) => warnings.push(m));
      expect(warnings).toHaveLength(0);
    });
    it('rejects a token with surrounding whitespace', () => {
      expect(() => envLib.validateToken(' sk ')).toThrow(/whitespace/);
    });
    it('rejects a token with a newline', () => {
      expect(() => envLib.validateToken('sk\nx')).toThrow(/newline/);
    });
  });

  describe('runConfigure — non-interactive', () => {
    it('creates .cc-env.json from flags', async () => {
      const d = profileDir('endp');
      const code = await envLib.runConfigure('endp', d, {
        base_url: 'https://api.moonshot.ai/anthropic', auth_token: 'sk-test', model: 'kimi-k2.5',
      });
      expect(code).toBe(0);
      const raw = JSON.parse(fs.readFileSync(path.join(d, '.cc-env.json'), 'utf8'));
      expect(raw).toEqual({ base_url: 'https://api.moonshot.ai/anthropic', auth_token: 'sk-test', model: 'kimi-k2.5' });
    });

    it('errors and writes nothing when --token is missing on creation', async () => {
      const d = profileDir('endp');
      await expect(
        envLib.runConfigure('endp', d, { base_url: 'https://x' }),
      ).rejects.toThrow(/--base-url and --token/);
      expect(fs.existsSync(path.join(d, '.cc-env.json'))).toBe(false);
    });

    it('blocks a profile that has OAuth credentials', async () => {
      const d = profileDir('oauth');
      fs.writeFileSync(path.join(d, '.credentials.json'), '{}');
      await expect(
        envLib.runConfigure('oauth', d, { base_url: 'https://x', auth_token: 'sk' }),
      ).rejects.toThrow(/has OAuth credentials/);
      expect(fs.existsSync(path.join(d, '.cc-env.json'))).toBe(false);
    });

    it('edit mode: partial update changes only the provided field', async () => {
      const d = profileDir('endp');
      envLib.writeEnvConfig(d, { base_url: 'https://x', auth_token: 'sk-keep', model: 'old' });
      await envLib.runConfigure('endp', d, { model: 'new' });
      const raw = JSON.parse(fs.readFileSync(path.join(d, '.cc-env.json'), 'utf8'));
      expect(raw).toEqual({ base_url: 'https://x', auth_token: 'sk-keep', model: 'new' });
    });

    it('errors when the profile does not exist', async () => {
      await expect(
        envLib.runConfigure('ghost', path.join(tmpHome, '.claude-profiles', 'ghost'), {
          base_url: 'https://x', auth_token: 'sk',
        }),
      ).rejects.toThrow(/does not exist/);
    });
  });

  describe('runConfigure — wizard', () => {
    it('creates a config through the wizard and submits', async () => {
      const d = profileDir('endp');
      const io = scriptIo([
        'https://api.moonshot.ai/anthropic', // base url
        'sk-secret-token-value',             // token (hidden)
        'kimi-k2.5',                         // main model
        '', '', '', '',                      // opus/sonnet/haiku/subagent — accept fallback
        's',                                 // submit
      ]);
      const code = await envLib.runConfigure('endp', d, {}, { io });
      expect(code).toBe(0);
      const raw = JSON.parse(fs.readFileSync(path.join(d, '.cc-env.json'), 'utf8'));
      expect(raw).toEqual({
        base_url: 'https://api.moonshot.ai/anthropic',
        auth_token: 'sk-secret-token-value',
        model: 'kimi-k2.5',
      });
      // tiers were Enter-skipped so they are not duplicated into the file
      expect(raw.opus).toBeUndefined();
    });

    it('cancel leaves an existing config byte-for-byte unchanged', async () => {
      const d = profileDir('endp');
      envLib.writeEnvConfig(d, { base_url: 'https://x', auth_token: 'sk', model: 'm' });
      const before = fs.readFileSync(path.join(d, '.cc-env.json'));
      const io = scriptIo(['', '', '', '', '', '', '', 'c']);
      await envLib.runConfigure('endp', d, {}, { io });
      const after = fs.readFileSync(path.join(d, '.cc-env.json'));
      expect(after.equals(before)).toBe(true);
    });

    it('edit mode: wizard prefills, "e 3" re-prompts one field, submit saves', async () => {
      const d = profileDir('endp');
      envLib.writeEnvConfig(d, { base_url: 'https://x', auth_token: 'sk-keep', model: 'old-model' });
      const io = scriptIo([
        '', '', '', '', '', '', '', // accept every prefilled value
        'e 3',                      // edit field 3 (Main model)
        'new-model',                // new value for the model
        's',                        // submit
      ]);
      await envLib.runConfigure('endp', d, {}, { io });
      const raw = JSON.parse(fs.readFileSync(path.join(d, '.cc-env.json'), 'utf8'));
      // Only the model changed; base_url and the token were kept.
      expect(raw).toEqual({ base_url: 'https://x', auth_token: 'sk-keep', model: 'new-model' });
    });

    it('review screen ignores invalid input instead of exiting', async () => {
      const d = profileDir('endp');
      envLib.writeEnvConfig(d, { base_url: 'https://x', auth_token: 'sk', model: 'm' });
      const io = scriptIo([
        '', '', '', '', '', '', '', // accept prefilled
        'e',                        // invalid (no number) — re-display
        'x',                        // invalid — re-display
        's',                        // finally submit
      ]);
      const code = await envLib.runConfigure('endp', d, {}, { io });
      expect(code).toBe(0);
    });

    it('errors in a non-TTY context with no flags', async () => {
      const d = profileDir('endp');
      await expect(
        envLib.runConfigure('endp', d, {}, { isTTY: false }),
      ).rejects.toThrow(/interactive terminal/);
    });

    it('the typed token never appears in wizard output', async () => {
      const d = profileDir('endp');
      const io = scriptIo([
        'https://x/anthropic', 'sk-super-secret-9999', 'm', '', '', '', '', 's',
      ]);
      await envLib.runConfigure('endp', d, {}, { io });
      expect(io.text()).not.toContain('sk-super-secret-9999');
    });
  });

  describe('runShow', () => {
    it('masks the token by default', () => {
      const d = profileDir('endp');
      envLib.writeEnvConfig(d, { base_url: 'https://x', auth_token: 'sk-abcdefghijklmnop' });
      const out = [];
      envLib.runShow('endp', d, { write: (s) => out.push(s) });
      const text = out.join('\n');
      expect(text).not.toContain('sk-abcdefghijklmnop');
      expect(text).toMatch(/sk-abc\.\.\./);
    });

    it('reveals the full token with --reveal and prints a warning', () => {
      const d = profileDir('endp');
      envLib.writeEnvConfig(d, { base_url: 'https://x', auth_token: 'sk-abcdefghijklmnop' });
      const out = [];
      envLib.runShow('endp', d, { reveal: true, write: (s) => out.push(s) });
      const text = out.join('\n');
      expect(text).toContain('sk-abcdefghijklmnop');
      expect(text).toMatch(/WARNING/);
    });

    it('errors on an OAuth (non-endpoint) profile', () => {
      const d = profileDir('oauth');
      expect(() => envLib.runShow('oauth', d, { write: () => {} })).toThrow(/not an endpoint profile/);
    });
  });
});

describe('cc env — CLI surface', () => {
  let tmpHome;
  let originalHomedir;
  let originalLog;
  let originalWrite;
  let originalErr;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-env-cli-'));
    originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
    originalLog = console.log;
    console.log = () => {};
    originalWrite = process.stdout.write;
    process.stdout.write = () => true;
    originalErr = process.stderr.write;
    process.stderr.write = () => true;
  });

  afterEach(() => {
    os.homedir = originalHomedir;
    console.log = originalLog;
    process.stdout.write = originalWrite;
    process.stderr.write = originalErr;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('rejects an unknown flag, naming it', async () => {
    await cli.run(['add', 'endp']);
    await expect(
      cli.run(['env', 'endp', '--token=sk-x', '--base-url=https://x', '--foo=bar']),
    ).rejects.toThrow(/Unknown flag: --foo/);
  });

  it('treats --force as an unknown flag (no override exists)', async () => {
    await cli.run(['add', 'endp']);
    await expect(
      cli.run(['env', 'endp', '--force', '--base-url=https://x', '--token=sk']),
    ).rejects.toThrow(/Unknown flag: --force/);
  });

  it('rejects --reveal outside of show mode', async () => {
    await cli.run(['add', 'endp']);
    await expect(cli.run(['env', 'endp', '--reveal'])).rejects.toThrow(/--reveal/);
  });

  it('creates a config non-interactively via flags', async () => {
    await cli.run(['add', 'endp']);
    const code = await cli.run([
      'env', 'endp', '--base-url=https://api.moonshot.ai/anthropic', '--token=sk-x',
    ]);
    expect(code).toBe(0);
    const p = path.join(tmpHome, '.claude-profiles', 'endp', '.cc-env.json');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('cc env show errors on a non-endpoint profile', async () => {
    await cli.run(['add', 'plain']);
    await expect(cli.run(['env', 'plain', 'show'])).rejects.toThrow(/not an endpoint profile/);
  });
});

describe('cc list — Endpoint column', () => {
  let tmpHome;
  let originalHomedir;
  let originalLog;
  let captured;
  let originalWrite;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-list-ep-'));
    originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
    captured = '';
    originalLog = console.log;
    console.log = (s) => { captured += s + '\n'; };
    originalWrite = process.stdout.write;
    process.stdout.write = (s) => { captured += s; return true; };
  });

  afterEach(() => {
    os.homedir = originalHomedir;
    console.log = originalLog;
    process.stdout.write = originalWrite;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('shows endpoint host for endpoint profiles and subscription otherwise', async () => {
    await cli.run(['add', 'endp']);
    await cli.run(['add', 'plain']);
    envLib.writeEnvConfig(path.join(tmpHome, '.claude-profiles', 'endp'), {
      base_url: 'https://api.moonshot.ai/anthropic', auth_token: 'sk',
    });
    await cli.run(['list']);
    expect(captured).toMatch(/api\.moonshot\.ai/);
    expect(captured).toMatch(/subscription/);
  });

  it('does not crash on a malformed .cc-env.json', async () => {
    await cli.run(['add', 'broken']);
    fs.writeFileSync(
      path.join(tmpHome, '.claude-profiles', 'broken', '.cc-env.json'), '{garbage',
    );
    const code = await cli.run(['list']);
    expect(code).toBe(0);
    expect(captured).toMatch(/invalid config/);
  });

  it('--json includes the endpoint field', async () => {
    await cli.run(['add', 'endp']);
    envLib.writeEnvConfig(path.join(tmpHome, '.claude-profiles', 'endp'), {
      base_url: 'https://api.moonshot.ai/anthropic', auth_token: 'sk',
    });
    captured = '';
    await cli.run(['list', '--json']);
    const arr = JSON.parse(captured);
    expect(arr[0].endpoint).toBe('api.moonshot.ai');
  });
});

describe('.cc-env.json is never migrated or linked', () => {
  let tmpHome;
  let originalHomedir;
  let originalLog;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-env-safe-'));
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

  it('cc link leaves .cc-env.json at the profile root untouched', async () => {
    const share = (await import('../lib/share.js')).default;
    const d = path.join(tmpHome, '.claude-profiles', 'endp');
    fs.mkdirSync(path.join(d, 'projects'), { recursive: true });
    envLib.writeEnvConfig(d, { base_url: 'https://x', auth_token: 'sk' });
    const before = fs.readFileSync(path.join(d, '.cc-env.json'));
    share.shareLink('endp');
    expect(fs.lstatSync(path.join(d, '.cc-env.json')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(d, '.cc-env.json')).equals(before)).toBe(true);
  });

  it('migrate does not copy .cc-env.json from default into a profile', async () => {
    const migrateLib = (await import('../lib/migrate.js')).default;
    const def = path.join(tmpHome, '.claude');
    fs.mkdirSync(path.join(def, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(def, '.cc-env.json'), '{"base_url":"https://leak","auth_token":"sk"}');
    fs.writeFileSync(path.join(def, 'projects', '.cc-env.json'), 'NEVER_COPY');
    migrateLib.migrate('default', 'work');
    const wdir = path.join(tmpHome, '.claude-profiles', 'work');
    expect(fs.existsSync(path.join(wdir, '.cc-env.json'))).toBe(false);
    expect(fs.existsSync(path.join(wdir, 'projects', '.cc-env.json'))).toBe(false);
  });
});
