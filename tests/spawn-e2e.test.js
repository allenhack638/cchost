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
    CC_ACTIVE_PROFILE: undefined,
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

  it('forwards args verbatim and sets CLAUDE_CONFIG_DIR + CC_ACTIVE_PROFILE', () => {
    // Pre-create the profile so 'cc use' doesn't error
    const profileDir = path.join(tmpHome, '.claude-profiles', 'e2e');
    fs.mkdirSync(profileDir, { recursive: true });

    const res = runCc(['use', 'e2e', '--resume', '-p', 'two words'], { home: tmpHome });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('ARGS:["--resume","-p","two words"]');
    expect(res.stdout).toContain(`CLAUDE_CONFIG_DIR:${profileDir}`);
    expect(res.stdout).toContain('CC_ACTIVE_PROFILE:e2e');
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
});
