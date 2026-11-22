import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const fixturesDir = path.join(repoRoot, 'test-fixtures');
const ccBin = path.join(repoRoot, 'bin', 'cc.js');

function runCc(args, { home, extraEnv = {}, cwd }) {
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const env = {
    ...process.env,
    // Strip auth vars too: tests opt in explicitly when testing the warning.
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    ...extraEnv,
    PATH: fixturesDir + pathSep + (process.env.PATH || process.env.Path || ''),
    USERPROFILE: home,
    HOME: home,
    // Strip any inherited override so we don't pick up the dev's real one.
    CLAUDE_CONFIG_DIR: undefined,
    NO_COLOR: '1',
    CCHOST_NO_UPDATE_CHECK: '1',
  };
  // node strips undefined values from env
  return spawnSync(process.execPath, [ccBin, ...args], {
    env,
    cwd,
    encoding: 'utf8',
    timeout: 20000,
  });
}

describe('cc use — end-to-end argv + env forwarding through fake-claude', () => {
  let tmpHome;

  beforeAll(() => {
    // Git records mode 100755, but Windows clones and zips can drop the exec bit.
    if (process.platform !== 'win32') {
      fs.chmodSync(path.join(fixturesDir, 'claude'), 0o755);
    }
  });

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('go launches the profile pinned to the folder, with args forwarded', () => {
    const profileDir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(profileDir, { recursive: true });
    const repo = path.join(tmpHome, 'src', 'api');
    fs.mkdirSync(path.join(repo, 'deep'), { recursive: true });
    expect(runCc(['pin', 'work', `--path=${repo}`], { home: tmpHome }).status).toBe(0);

    const res = runCc(['go', '--resume', 'abc'], { home: tmpHome, cwd: path.join(repo, 'deep') });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('ARGS:["--resume","abc"]');
    expect(res.stdout).toContain(`CLAUDE_CONFIG_DIR:${profileDir}`);
    expect(res.stderr).toContain("pinned to 'work'");

    const outside = runCc(['go'], { home: tmpHome, cwd: tmpHome });
    expect(outside.status).toBe(1);
    expect(outside.stderr).toContain('No pin for this folder');
  });

  it('open resumes a found session in its own folder under its account', () => {
    const work = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(work, { recursive: true });
    const repo = path.join(fs.realpathSync.native(tmpHome), 'src', 'api');
    fs.mkdirSync(path.join(repo, 'deep'), { recursive: true });
    const id = 'abcd1234-0000-0000-0000-000000000001';
    const projDir = path.join(tmpHome, '.claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, `${id}.jsonl`), [
      JSON.stringify({ type: 'user', cwd: repo, sessionId: id, timestamp: '2026-11-01T00:00:00Z', message: { role: 'user', content: 'resume me please' } }),
      JSON.stringify({ type: 'assistant', cwd: repo, sessionId: id, timestamp: '2026-11-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'sure' }] } }),
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(work, 'history.jsonl'), JSON.stringify({ display: 'resume me please', timestamp: 1, project: repo, sessionId: id }) + '\n');

    const deep = runCc(['find', 'resume', '--json'], { home: tmpHome, cwd: path.join(repo, 'deep') });
    expect(JSON.parse(deep.stdout).results).toEqual([]);
    const found = runCc(['find', 'resume', '--json'], { home: tmpHome, cwd: repo });
    expect(found.status).toBe(0);
    expect(JSON.parse(found.stdout).results[0].id).toBe(id);

    const res = runCc(['open', 'abcd1234', '--fork'], { home: tmpHome, cwd: repo });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`ARGS:["--resume","${id}","--fork-session"]`);
    expect(res.stdout).toContain(`CLAUDE_CONFIG_DIR:${work}`);
    expect(res.stdout).toContain(`CWD:${fs.realpathSync.native(repo)}`);
    expect(res.stderr).toContain("as 'work'");

    const elsewhere = runCc(['open', 'abcd1234'], { home: tmpHome, cwd: path.join(tmpHome, 'src') });
    expect(elsewhere.status).toBe(0);
    expect(elsewhere.stdout).toContain('--resume');

    fs.mkdirSync(path.join(tmpHome, 'other'));
    const outside = runCc(['open', 'abcd1234'], { home: tmpHome, cwd: path.join(tmpHome, 'other') });
    expect(outside.status).toBe(1);
    expect(outside.stdout).not.toContain('CLAUDE_CONFIG_DIR');
    expect(outside.stderr).toContain('in this scope');

    const globalHeadless = runCc(['open', 'abcd1234', '--global'], { home: tmpHome, cwd: path.join(tmpHome, 'other') });
    expect(globalHeadless.status).toBe(2);
  });

  it('go refuses an unconfirmed .cchost suggestion without a terminal', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude-profiles', 'work'), { recursive: true });
    const repo = path.join(tmpHome, 'clone');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, '.cchost'), 'work\n');
    const res = runCc(['go'], { home: tmpHome, cwd: repo });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('has not been confirmed');
    expect(res.stdout).not.toContain('CLAUDE_CONFIG_DIR');
  });

  it('forwards args verbatim and sets CLAUDE_CONFIG_DIR', () => {
    const profileDir = path.join(tmpHome, '.claude-profiles', 'e2e');
    fs.mkdirSync(profileDir, { recursive: true });

    const res = runCc(['use', 'e2e', '--resume', '-p', 'two words'], { home: tmpHome });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('ARGS:["--resume","-p","two words"]');
    expect(res.stdout).toContain(`CLAUDE_CONFIG_DIR:${profileDir}`);
    // The action ('use') and profile name ('e2e') must not appear in ARGS.
    expect(res.stdout).not.toMatch(/ARGS:\[[^\]]*"use"/);
    expect(res.stdout).not.toMatch(/ARGS:\[[^\]]*"e2e"/);
  });

  it('turns off Claude Code self-update unless asked to keep it', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude-profiles', 'e2e'), { recursive: true });
    const off = runCc(['use', 'e2e'], { home: tmpHome, extraEnv: { DISABLE_AUTOUPDATER: undefined, CCHOST_CLAUDE_AUTOUPDATE: undefined } });
    expect(off.stdout).toContain('ENV:DISABLE_AUTOUPDATER=1');
    const kept = runCc(['use', 'e2e'], { home: tmpHome, extraEnv: { DISABLE_AUTOUPDATER: undefined, CCHOST_CLAUDE_AUTOUPDATE: '1' } });
    expect(kept.stdout).toContain('ENV:DISABLE_AUTOUPDATER=\n');
  });

  // macOS names the Keychain entry after sha256 of this exact string, so pin it byte-for-byte.
  it('passes CLAUDE_CONFIG_DIR as the exact profile path (no realpath, no trailing slash)', () => {
    const profileDir = path.join(tmpHome, '.claude-profiles', 'e2e');
    fs.mkdirSync(profileDir, { recursive: true });

    const res = runCc(['use', 'e2e'], { home: tmpHome });

    expect(res.status).toBe(0);
    const line = res.stdout.split(/\r?\n/).find((l) => l.startsWith('CLAUDE_CONFIG_DIR:'));
    expect(line).toBe(`CLAUDE_CONFIG_DIR:${profileDir}`);
  });

  it('does not leak parent CLAUDE_CONFIG_DIR into child', () => {
    const profileDir = path.join(tmpHome, '.claude-profiles', 'inner');
    fs.mkdirSync(profileDir, { recursive: true });

    // Parent has a stale CLAUDE_CONFIG_DIR; child should see the profile's, not the parent's.
    const res = runCc(['use', 'inner'], {
      home: tmpHome,
      extraEnv: { CLAUDE_CONFIG_DIR: 'C:\\bogus\\inherited' },
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`CLAUDE_CONFIG_DIR:${profileDir}`);
    expect(res.stdout).not.toContain('bogus');
  });

  it('exits non-zero when the profile does not exist', () => {
    const res = runCc(['use', 'ghost'], { home: tmpHome });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/does not exist/);
  });

  it('injects ANTHROPIC_* env vars and prints the endpoint banner for an endpoint profile', () => {
    const profileDir = path.join(tmpHome, '.claude-profiles', 'kimi');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, '.cc-env.json'),
      JSON.stringify({
        base_url: 'https://api.moonshot.ai/anthropic',
        auth_token: 'sk-endpoint-secret',
        model: 'kimi-k2.5',
      }),
    );

    const res = runCc(['use', 'kimi'], { home: tmpHome });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("[cchost] Profile 'kimi' → api.moonshot.ai (custom endpoint billing applies)");
    // Both token vars set; all five model vars fall back to `model`.
    expect(res.stdout).toContain('ENV:ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic');
    expect(res.stdout).toContain('ENV:ANTHROPIC_AUTH_TOKEN=sk-endpoint-secret');
    expect(res.stdout).toContain('ENV:ANTHROPIC_API_KEY=sk-endpoint-secret');
    expect(res.stdout).toContain('ENV:ANTHROPIC_MODEL=kimi-k2.5');
    expect(res.stdout).toContain('ENV:ANTHROPIC_DEFAULT_OPUS_MODEL=kimi-k2.5');
    expect(res.stdout).toContain('ENV:CLAUDE_CODE_SUBAGENT_MODEL=kimi-k2.5');
  });

  it('does not inject endpoint vars or print a banner for a subscription profile', () => {
    const profileDir = path.join(tmpHome, '.claude-profiles', 'sub');
    fs.mkdirSync(profileDir, { recursive: true });

    const res = runCc(['use', 'sub'], { home: tmpHome });
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain('[cchost]');
    expect(res.stdout).toContain('ENV:ANTHROPIC_BASE_URL=');
    expect(res.stdout).not.toMatch(/ENV:ANTHROPIC_BASE_URL=\S/);
  });

  it('warns when a subscription profile inherits an auth env var', () => {
    const profileDir = path.join(tmpHome, '.claude-profiles', 'sub-auth');
    fs.mkdirSync(profileDir, { recursive: true });

    const res = runCc(['use', 'sub-auth'], {
      home: tmpHome,
      extraEnv: { ANTHROPIC_API_KEY: 'sk-inherited' },
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/ANTHROPIC_API_KEY/);
    expect(res.stderr).toMatch(/may override/i);
  });

  it('does not warn about inherited auth vars for an endpoint profile', () => {
    const profileDir = path.join(tmpHome, '.claude-profiles', 'kimi-auth');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, '.cc-env.json'),
      JSON.stringify({ base_url: 'https://api.moonshot.ai/anthropic', auth_token: 'sk-endpoint' }),
    );

    const res = runCc(['use', 'kimi-auth'], {
      home: tmpHome,
      extraEnv: { ANTHROPIC_API_KEY: 'sk-inherited' },
    });
    expect(res.status).toBe(0);
    expect(res.stderr).not.toMatch(/may override/i);
  });

  it('strips inherited Anthropic auth vars for an endpoint profile', () => {
    const profileDir = path.join(tmpHome, '.claude-profiles', 'kimi-strip');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, '.cc-env.json'),
      JSON.stringify({ auth_token: 'sk-endpoint' }),
    );

    const res = runCc(['use', 'kimi-strip'], {
      home: tmpHome,
      extraEnv: {
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-inherited',
        ANTHROPIC_BASE_URL: 'https://wrong.example',
        ANTHROPIC_API_KEY: 'sk-inherited',
      },
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/removed inherited.*CLAUDE_CODE_OAUTH_TOKEN/);
    expect(res.stderr).toMatch(/ANTHROPIC_BASE_URL/);
    expect(res.stdout).toContain('ENV:CLAUDE_CODE_OAUTH_TOKEN=');
    expect(res.stdout).not.toContain('oauth-inherited');
    expect(res.stdout).toContain('ENV:ANTHROPIC_BASE_URL=');
    expect(res.stdout).not.toContain('wrong.example');
    expect(res.stdout).toContain('ENV:ANTHROPIC_API_KEY=sk-endpoint');
  });

  it('forwards --resume verbatim for an endpoint profile (no profile name leaked)', () => {
    const profileDir = path.join(tmpHome, '.claude-profiles', 'kimi2');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, '.cc-env.json'),
      JSON.stringify({ base_url: 'https://api.moonshot.ai/anthropic', auth_token: 'sk-x' }),
    );

    const res = runCc(['use', 'kimi2', '--resume'], { home: tmpHome });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('ARGS:["--resume"]');
  });

  it('omits model env vars when the endpoint config has only base_url and token', () => {
    const profileDir = path.join(tmpHome, '.claude-profiles', 'bare');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, '.cc-env.json'),
      JSON.stringify({ base_url: 'https://api.moonshot.ai/anthropic', auth_token: 'sk-x' }),
    );

    const res = runCc(['use', 'bare'], { home: tmpHome });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('ENV:ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic');
    expect(res.stdout).toContain('ENV:ANTHROPIC_MODEL=');
    expect(res.stdout).not.toMatch(/ENV:ANTHROPIC_MODEL=\S/);
    expect(res.stdout).not.toMatch(/ENV:ANTHROPIC_DEFAULT_OPUS_MODEL=\S/);
  });
});
