import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const fixturesDir = path.join(repoRoot, 'test-fixtures');
const ccBin = path.join(repoRoot, 'bin', 'cc.js');

function runCc(args, { home, extraEnv = {} }) {
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const env = {
    ...process.env,
    ...extraEnv,
    PATH: fixturesDir + pathSep + (process.env.PATH || process.env.Path || ''),
    USERPROFILE: home,
    HOME: home,
    // Strip any inherited override so we don't pick up the dev's real one.
    CLAUDE_CONFIG_DIR: undefined,
    NO_COLOR: '1',
  };
  // node strips undefined values from env
  return spawnSync(process.execPath, [ccBin, ...args], {
    env,
    encoding: 'utf8',
    timeout: 20000,
  });
}

const runE2E = process.platform === 'win32' ? describe : describe.skip;

runE2E('cc use — end-to-end argv + env forwarding through fake-claude', () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('forwards args verbatim and sets CLAUDE_CONFIG_DIR', () => {
    // Pre-create the profile so 'cc use' doesn't error
    const profileDir = path.join(tmpHome, '.claude-profiles', 'e2e');
    fs.mkdirSync(profileDir, { recursive: true });

    const res = runCc(['use', 'e2e', '--resume', '-p', 'two words'], { home: tmpHome });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('ARGS:["--resume","-p","two words"]');
    expect(res.stdout).toContain(`CLAUDE_CONFIG_DIR:${profileDir}`);
    // Crucially: the action ('use') and profile name ('e2e') must NOT appear in ARGS.
    expect(res.stdout).not.toMatch(/ARGS:\[[^\]]*"use"/);
    expect(res.stdout).not.toMatch(/ARGS:\[[^\]]*"e2e"/);
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
    // Banner goes to stderr.
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
