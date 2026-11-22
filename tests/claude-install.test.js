import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import install from '../lib/claude-install.js';
import doctor from '../lib/doctor.js';

const isWin = process.platform === 'win32';
const OLD = Date.now() - 60 * 60 * 1000;

describe('Claude Code install repair', () => {
  let tmp;
  let root;
  let binDir;
  let originalHomedir;
  const saved = {};

  function touch(p, content = '', mtime) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    if (mtime) fs.utimesSync(p, mtime / 1000, mtime / 1000);
  }

  function healthy() {
    touch(path.join(root, '@anthropic-ai', 'claude-code', 'package.json'), '{}');
    touch(path.join(root, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), 'x'.repeat(8000));
    touch(path.join(binDir, 'claude'), '');
  }

  function interrupted() {
    touch(path.join(root, '@anthropic-ai', 'claude-code', 'package.json'), '{}');
    touch(path.join(root, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), 'echo "Error: claude native binary not installed." >&2\nexit 1\n');
    fs.mkdirSync(path.join(root, '@anthropic-ai', '.claude-code-e12Jc3WF'), { recursive: true });
    fs.utimesSync(path.join(root, '@anthropic-ai', '.claude-code-e12Jc3WF'), OLD / 1000, OLD / 1000);
    touch(path.join(binDir, '.claude-KkVpuBou'), '', OLD);
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cinst-'));
    root = isWin ? path.join(tmp, 'npm', 'node_modules') : path.join(tmp, 'npm', 'lib', 'node_modules');
    binDir = isWin ? path.join(tmp, 'npm') : path.join(tmp, 'npm', 'bin');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    originalHomedir = os.homedir;
    os.homedir = () => tmp;
    for (const k of ['CCHOST_NPM_ROOT', 'PATH']) saved[k] = process.env[k];
    process.env.CCHOST_NPM_ROOT = root;
    process.env.PATH = binDir;
  });

  afterEach(() => {
    os.homedir = originalHomedir;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('sees a complete install as healthy', () => {
    healthy();
    const info = install.inspect();
    expect(info.broken).toBe(false);
    expect(info.leftovers).toEqual([]);
  });

  it('spots an update that stopped halfway', () => {
    interrupted();
    const info = install.inspect();
    expect(info.stub).toBe(true);
    expect(info.linked).toBe(false);
    expect(info.broken).toBe(true);
    expect(info.leftovers).toHaveLength(2);
    expect(info.problems.join(' ')).toMatch(/never unpacked.*missing.*2 leftovers/);
  });

  it('leaves fresh leftovers alone: another update may still be running', () => {
    healthy();
    touch(path.join(binDir, '.claude-AbCd1234'), '');
    expect(install.inspect().leftovers).toEqual([]);
  });

  it.skipIf(isWin)('sees a claude link that points at nothing as broken', () => {
    healthy();
    fs.rmSync(path.join(binDir, 'claude'));
    fs.symlinkSync(path.join(root, 'gone', 'claude.exe'), path.join(binDir, 'claude'));
    expect(install.inspect().broken).toBe(true);
  });

  it.skipIf(isWin)('updates the claude that runs, not another npm copy', () => {
    healthy();
    const native = path.join(tmp, 'local', 'bin');
    touch(path.join(native, 'claude'), '#!/bin/sh\n');
    fs.chmodSync(path.join(native, 'claude'), 0o755);
    process.env.PATH = native + path.delimiter + binDir;
    expect(install.plan().how).toBe('native');
    process.env.PATH = binDir + path.delimiter + native;
    fs.chmodSync(path.join(binDir, 'claude'), 0o755);
    expect(install.plan().how).toBe('npm');
  });

  it('lets one update run at a time and reclaims a dead lock', () => {
    expect(install.acquireLock()).toBe(true);
    expect(install.acquireLock()).toBe(false);
    install.releaseLock();
    fs.writeFileSync(install.lockFile(), JSON.stringify({ pid: 2 ** 22 + 7, at: Date.now() }));
    expect(install.acquireLock()).toBe(true);
    install.releaseLock();
    fs.writeFileSync(install.lockFile(), JSON.stringify({ pid: process.pid, at: Date.now() - install.LOCK_STALE_MS - 1 }));
    expect(install.acquireLock()).toBe(true);
    install.releaseLock();
  });

  it('refuses to update while another process holds the lock', async () => {
    interrupted();
    fs.mkdirSync(path.dirname(install.lockFile()), { recursive: true });
    fs.writeFileSync(install.lockFile(), JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }));
    await expect(install.update({ write: () => {}, npm: async () => ({ status: 0 }) })).rejects.toThrow(/Another Claude Code update is running/);
    expect(JSON.parse(fs.readFileSync(install.lockFile(), 'utf8')).token).toBe('other');
  });

  it('keeps a long update\'s lock while its owner is alive, and only releases its own', () => {
    fs.mkdirSync(path.dirname(install.lockFile()), { recursive: true });
    fs.writeFileSync(install.lockFile(), JSON.stringify({ pid: process.pid, at: Date.now() - 20 * 60 * 1000, token: 'other' }));
    expect(install.acquireLock()).toBe(false);
    install.releaseLock();
    expect(fs.existsSync(install.lockFile())).toBe(true);
  });

  it('never removes a lock while another process is reclaiming it', () => {
    fs.mkdirSync(path.dirname(install.lockFile()), { recursive: true });
    fs.writeFileSync(install.lockFile(), JSON.stringify({ pid: 2 ** 22 + 7, at: Date.now(), token: 'dead' }));
    fs.writeFileSync(`${install.lockFile()}.guard`, '1');
    expect(install.acquireLock()).toBe(false);
    expect(JSON.parse(fs.readFileSync(install.lockFile(), 'utf8')).token).toBe('dead');
    const old = (Date.now() - 2 * 60 * 1000) / 1000;
    fs.utimesSync(`${install.lockFile()}.guard`, old, old);
    expect(install.acquireLock()).toBe(true);
    install.releaseLock();
    expect(fs.existsSync(install.lockFile())).toBe(false);
  });

  it('treats a lock still being written as held', () => {
    fs.mkdirSync(path.dirname(install.lockFile()), { recursive: true });
    fs.writeFileSync(install.lockFile(), '');
    expect(install.acquireLock()).toBe(false);
  });

  it('a release after losing the lock leaves the new owner\'s lock alone', () => {
    expect(install.acquireLock()).toBe(true);
    fs.writeFileSync(install.lockFile(), JSON.stringify({ pid: process.pid, at: Date.now(), token: 'newer' }));
    install.releaseLock();
    expect(JSON.parse(fs.readFileSync(install.lockFile(), 'utf8')).token).toBe('newer');
  });

  it('dry run names the command and the leftovers, and changes nothing', async () => {
    interrupted();
    let out = '';
    await install.update({ write: (t) => { out += t; }, dryRun: true, npm: () => { throw new Error('ran'); } });
    expect(out).toMatch(/Would run: npm install -g --allow-scripts=@anthropic-ai\/claude-code @anthropic-ai\/claude-code@latest/);
    expect(out).toMatch(/Would remove: .*\.claude-code-e12Jc3WF/);
    expect(install.inspect().broken).toBe(true);
  });

  it.skipIf(isWin)('reinstalls, clears the leftovers and releases the lock', async () => {
    interrupted();
    process.env.PATH = binDir;
    const calls = [];
    const npm = async (args) => {
      calls.push(args.join(' '));
      fs.writeFileSync(path.join(root, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), '#!/bin/sh\necho "2.1.400 (Claude Code)"\n' + '#'.repeat(5000));
      fs.chmodSync(path.join(root, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), 0o755);
      fs.symlinkSync(path.join(root, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), path.join(binDir, 'claude'));
      return { status: 0 };
    };
    let out = '';
    const res = await install.update({ write: (t) => { out += t; }, npm });
    expect(calls).toEqual(['install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest']);
    expect(res.after).toBe('2.1.400');
    expect(out).toMatch(/removed .*\.claude-KkVpuBou/);
    const info = install.inspect();
    expect(info.broken).toBe(false);
    expect(info.leftovers).toEqual([]);
    expect(fs.existsSync(install.lockFile())).toBe(false);
  });

  it.skipIf(isWin)('unpacks the program itself when npm blocked the install script', async () => {
    interrupted();
    process.env.PATH = binDir;
    const exe = path.join(root, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    const npm = async () => {
      fs.symlinkSync(exe, path.join(binDir, 'claude'));
      return { status: 0 };
    };
    const setup = async (dir) => {
      expect(dir).toBe(path.join(root, '@anthropic-ai', 'claude-code'));
      fs.writeFileSync(exe, '#!/bin/sh\necho "2.1.400 (Claude Code)"\n' + '#'.repeat(5000));
      fs.chmodSync(exe, 0o755);
      return { status: 0 };
    };
    let out = '';
    expect((await install.update({ write: (t) => { out += t; }, npm, setup })).after).toBe('2.1.400');
    expect(out).toMatch(/Unpacking the claude program/);
  });

  it.skipIf(isWin)('doctor repairs the broken npm copy even when another claude runs first', async () => {
    interrupted();
    const native = path.join(tmp, 'local', 'bin');
    touch(path.join(native, 'claude'), '#!/bin/sh\necho "2.1.300 (Claude Code)"\n');
    fs.chmodSync(path.join(native, 'claude'), 0o755);
    process.env.PATH = native + path.delimiter + binDir;
    expect(install.plan().how).toBe('native');
    const exe = path.join(root, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    const npm = async () => {
      fs.writeFileSync(exe, '#!/bin/sh\necho "2.1.400 (Claude Code)"\n' + '#'.repeat(5000));
      fs.chmodSync(exe, 0o755);
      fs.symlinkSync(exe, path.join(binDir, 'claude'));
      return { status: 0 };
    };
    const res = await install.update({ write: () => {}, target: 'npm', npm, claude: () => { throw new Error('updated the other claude'); } });
    expect(res.after).toBe('2.1.400');
    expect(install.inspect().broken).toBe(false);
  });

  it.skipIf(isWin)('the update notice forgets a version once claude changes', async () => {
    const spawnLib = (await import('../lib/spawn.js')).default;
    const exe = path.join(binDir, 'claude');
    touch(exe, '#!/bin/sh\necho "2.1.300 (Claude Code)"\n');
    fs.chmodSync(exe, 0o755);
    spawnLib.cachedClaudeVersion(exe);
    expect(spawnLib.lastKnownVersion()).toBe('2.1.300');
    fs.writeFileSync(exe, '#!/bin/sh\necho "2.1.400 (Claude Code)"\n');
    fs.utimesSync(exe, new Date(), new Date(Date.now() + 5000));
    expect(spawnLib.lastKnownVersion()).toBe(null);
    spawnLib.cachedClaudeVersion(exe);
    expect(spawnLib.lastKnownVersion()).toBe('2.1.400');
  });

  it('stops without touching leftovers when npm fails', async () => {
    interrupted();
    await expect(install.update({ write: () => {}, npm: async () => ({ status: 1 }) })).rejects.toThrow(/failed\. Nothing else was changed/);
    expect(install.inspect().leftovers).toHaveLength(2);
    expect(fs.existsSync(install.lockFile())).toBe(false);
  });

  it('doctor reports the half-finished install with a safe fix', () => {
    interrupted();
    const check = doctor.runChecks().find((r) => r.name === 'Claude Code install');
    expect(check.status).toBe('error');
    expect(check.message).toMatch(/stopped halfway/);
    expect(check.fix.safe).toBe(true);
  });

  it('doctor --fix can clear leftovers alone when the install itself is fine', async () => {
    healthy();
    touch(path.join(binDir, '.claude-KkVpuBou'), '', OLD);
    const check = doctor.runChecks().find((r) => r.name === 'Claude Code install');
    expect(check.status).toBe('warn');
    await check.fix.apply(() => {});
    expect(fs.existsSync(path.join(binDir, '.claude-KkVpuBou'))).toBe(false);
  });
});
