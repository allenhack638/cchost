'use strict';

// Claude Code's own install: spot an npm update that stopped halfway, and
// update it one process at a time across every profile.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { findClaude, getClaudeVersion } = require('./spawn');
const errors = require('./errors');

const PKG = '@anthropic-ai/claude-code';
const STUB_MARK = 'native binary not installed';
const LEFTOVER_MIN_AGE_MS = 10 * 60 * 1000;
const LOCK_STALE_MS = 15 * 60 * 1000;
const PKG_LEFTOVER = /^\.claude-code-[A-Za-z0-9]{8}$/;
const BIN_LEFTOVER = /^\.claude(\.cmd|\.ps1)?-[A-Za-z0-9]{8}$/;

const NPM_ARGS = ['install', '-g', `--allow-scripts=${PKG}`, `${PKG}@latest`];

const isWin = () => process.platform === 'win32';

function runNpm(args, opts = {}) {
  return spawnSync(isWin() ? 'npm.cmd' : 'npm', args, { encoding: 'utf8', shell: isWin(), ...opts });
}

// npm masks anything in its output that looks like a secret, paths included.
function npmRoot() {
  if (process.env.CCHOST_NPM_ROOT) return process.env.CCHOST_NPM_ROOT;
  try {
    const res = runNpm(['root', '-g'], { timeout: 10000 });
    const out = res && res.status === 0 ? String(res.stdout).trim() : '';
    if (out && !out.includes('***')) return out;
  } catch { /* fall back to node's own prefix */ }
  const prefix = path.dirname(path.dirname(process.execPath));
  return isWin() ? path.join(path.dirname(process.execPath), 'node_modules') : path.join(prefix, 'lib', 'node_modules');
}

function binDirOf(root) {
  return isWin() ? path.dirname(root) : path.join(root, '..', '..', 'bin');
}

function lstat(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function leftoversIn(dir, re, now) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => re.test(n)).map((n) => {
    const p = path.join(dir, n);
    const st = lstat(p);
    return { path: p, stale: !st || now - st.mtimeMs > LEFTOVER_MIN_AGE_MS };
  });
}

function isStub(file) {
  const st = lstat(file);
  if (!st || !st.isFile() || st.size > 4096) return false;
  try {
    return fs.readFileSync(file, 'utf8').includes(STUB_MARK);
  } catch {
    return false;
  }
}

function inspect({ root = npmRoot(), now = Date.now() } = {}) {
  if (!root) return null;
  const scope = path.join(root, '@anthropic-ai');
  const pkgDir = path.join(scope, 'claude-code');
  const binDir = binDirOf(root);
  const installed = fs.existsSync(path.join(pkgDir, 'package.json'));
  const linked = ['claude', 'claude.cmd'].some((n) => lstat(path.join(binDir, n)));
  const stub = installed && isStub(path.join(pkgDir, 'bin', 'claude.exe'));
  const leftovers = [...leftoversIn(scope, PKG_LEFTOVER, now), ...leftoversIn(binDir, BIN_LEFTOVER, now)];
  const stale = leftovers.filter((l) => l.stale).map((l) => l.path);
  const problems = [];
  if (stub) problems.push('the claude program was never unpacked');
  if (installed && !linked) problems.push('the claude command is missing');
  if (stale.length) problems.push(`${stale.length} leftover${stale.length === 1 ? '' : 's'} from an interrupted update`);
  return { root, binDir, pkgDir, installed, linked, stub, leftovers: stale, broken: stub || (installed && !linked), problems };
}

function lockFile() {
  return path.join(os.homedir(), '.claude-profiles', '.claude-update.lock');
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function acquireLock(now = Date.now()) {
  const file = lockFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: now }), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let held = {};
      try {
        held = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch { /* unreadable lock counts as stale */ }
      const fresh = Number.isFinite(held.at) && now - held.at < LOCK_STALE_MS && Number.isInteger(held.pid) && alive(held.pid);
      if (fresh) return false;
      fs.rmSync(file, { force: true });
    }
  }
  return false;
}

function releaseLock() {
  fs.rmSync(lockFile(), { force: true });
}

function withLock(fn) {
  if (!acquireLock()) throw errors.refused('Another Claude Code update is running. Try again in a minute.');
  try {
    return fn();
  } finally {
    releaseLock();
  }
}

function removeLeftovers(paths, write) {
  for (const p of paths) {
    fs.rmSync(p, { recursive: true, force: true });
    write(`  removed ${p}\n`);
  }
}

// How this machine got `claude`: npm (global package) or a standalone install.
function method(info, bin) {
  if (info && (info.installed || info.broken)) return 'npm';
  if (!bin) return info ? 'npm' : null;
  return 'native';
}

function plan({ info = inspect(), bin = findClaude() } = {}) {
  const how = method(info, bin);
  if (how === 'npm') return { how, cmd: `npm ${NPM_ARGS.join(' ')}`, leftovers: info ? info.leftovers : [] };
  if (how === 'native') return { how, cmd: 'claude update', leftovers: [] };
  return { how: null, cmd: null, leftovers: [] };
}

function runSetup(pkgDir, opts) {
  return spawnSync(process.execPath, [path.join(pkgDir, 'install.cjs')], { cwd: pkgDir, ...opts });
}

// Also repairs a half-finished install. npm 12 blocks the package's postinstall
// unless allowed, which leaves the placeholder; its own setup script fills it in.
function update({ write = (t) => process.stdout.write(t), dryRun = false, stdio = 'inherit', run = runNpm, runClaude, setup = runSetup } = {}) {
  const bin = findClaude();
  const before = bin ? getClaudeVersion(bin) : null;
  const p = plan({ bin });
  if (!p.how) throw errors.refused(`npm was not found. Install Claude Code: npm install -g ${PKG}`);
  if (dryRun) {
    write(`Would run: ${p.cmd}\n`);
    for (const l of p.leftovers) write(`Would remove: ${l}\n`);
    return { ran: false, cmd: p.cmd };
  }
  return withLock(() => {
    write(`Running: ${p.cmd}\n`);
    const res = p.how === 'npm'
      ? run(NPM_ARGS, { stdio })
      : (runClaude || ((args, o) => spawnSync(bin, args, o)))(['update'], { stdio });
    if (!res || res.status !== 0) throw errors.fail(`${p.cmd} failed. Nothing else was changed.`, 409);
    if (p.how === 'npm') {
      let after = inspect();
      if (after && after.stub) {
        write('Unpacking the claude program (its install script did not run)\n');
        const r = setup(after.pkgDir, { stdio });
        if (!r || r.status !== 0) throw errors.fail(`Could not unpack Claude Code. Run: node ${path.join(after.pkgDir, 'install.cjs')}`, 409);
        after = inspect();
      }
      if (after) removeLeftovers(after.leftovers, write);
    }
    const now = findClaude();
    const v = now ? getClaudeVersion(now) : null;
    if (!v) throw errors.fail('Claude Code still does not start after the update. Run: cchost doctor', 409);
    const msg = !before ? `Claude Code ${v.raw} starts again` : before.raw !== v.raw ? `Claude Code ${before.raw} → ${v.raw}` : `Claude Code ${v.raw} is up to date`;
    write(`${msg}\n`);
    return { ran: true, cmd: p.cmd, before: before ? before.raw : null, after: v.raw };
  });
}

function cleanLeftovers({ write = (t) => process.stdout.write(t), info = inspect() } = {}) {
  if (!info || !info.leftovers.length) return 0;
  return withLock(() => {
    removeLeftovers(info.leftovers, write);
    return info.leftovers.length;
  });
}

module.exports = { inspect, plan, update, cleanLeftovers, acquireLock, releaseLock, lockFile, LOCK_STALE_MS };
