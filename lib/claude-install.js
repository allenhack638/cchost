'use strict';

// Claude Code's own install: spot an npm update that stopped halfway, and
// update it one process at a time across every profile.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const { findClaude, getClaudeVersion, cachedClaudeVersion } = require('./spawn');
const errors = require('./errors');

const PKG = '@anthropic-ai/claude-code';
const NPM_ARGS = ['install', '-g', `--allow-scripts=${PKG}`, `${PKG}@latest`];
const STUB_MARK = 'native binary not installed';
const LEFTOVER_MIN_AGE_MS = 10 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
// Longer than an update can hold it (install + setup), so only a lost lock expires.
const LOCK_STALE_MS = 60 * 60 * 1000;
const HALF_WRITTEN_MS = 60 * 1000;
const PKG_LEFTOVER = /^\.claude-code-[A-Za-z0-9]{8}$/;
const BIN_LEFTOVER = /^\.claude(\.cmd|\.ps1)?-[A-Za-z0-9]{8}$/;

const isWin = () => process.platform === 'win32';

function run(cmd, args, { stdio = 'inherit', timeout, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio, cwd, shell: isWin() && cmd === 'npm.cmd', windowsHide: true });
    } catch {
      resolve({ status: null });
      return;
    }
    const timer = timeout ? setTimeout(() => child.kill(), timeout) : null;
    child.on('error', () => { clearTimeout(timer); resolve({ status: null }); });
    child.on('exit', (status) => { clearTimeout(timer); resolve({ status }); });
  });
}

const runNpm = (args, opts) => run(isWin() ? 'npm.cmd' : 'npm', args, { timeout: INSTALL_TIMEOUT_MS, ...opts });
const runSetup = (pkgDir, opts) => run(process.execPath, [path.join(pkgDir, 'install.cjs')], { cwd: pkgDir, timeout: SETUP_TIMEOUT_MS, ...opts });

// npm masks anything in its output that looks like a secret, paths included.
function npmRoot() {
  if (process.env.CCHOST_NPM_ROOT) return process.env.CCHOST_NPM_ROOT;
  try {
    const res = spawnSync(isWin() ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', shell: isWin(), timeout: 10000 });
    const out = res && res.status === 0 ? String(res.stdout).trim() : '';
    if (out && !out.includes('***')) return out;
  } catch { /* fall back to node's own prefix */ }
  return isWin()
    ? path.join(path.dirname(process.execPath), 'node_modules')
    : path.join(path.dirname(path.dirname(process.execPath)), 'lib', 'node_modules');
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
  const binDir = path.resolve(binDirOf(root));
  const installed = fs.existsSync(path.join(pkgDir, 'package.json'));
  // existsSync follows the link: one pointing at nothing does not count.
  const linked = ['claude', 'claude.cmd'].some((n) => fs.existsSync(path.join(binDir, n)));
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

function readLock(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  let held = null;
  try {
    held = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* still being written, or damaged */ }
  return { held, mtimeMs: st.mtimeMs };
}

function expired({ held, mtimeMs }, now) {
  if (!held || !Number.isInteger(held.pid)) return now - mtimeMs > HALF_WRITTEN_MS;
  return !alive(held.pid) || now - held.at > LOCK_STALE_MS;
}

const tokenOf = (lock) => (lock && lock.held ? lock.held.token : undefined);

let myToken = null;

// An expired lock is moved aside under a private name before a new one is
// taken. If what got moved is not the lock judged expired, it goes back.
function acquireLock(now = Date.now()) {
  const file = lockFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomBytes(8).toString('hex');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: now, token }), { flag: 'wx', mode: 0o600 });
      myToken = token;
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const lock = readLock(file);
    if (!lock) continue;
    if (!expired(lock, now)) return false;
    const aside = `${file}.${token}`;
    try {
      fs.renameSync(file, aside);
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    if (tokenOf(readLock(aside)) !== tokenOf(lock)) {
      try {
        fs.linkSync(aside, file);
      } catch { /* a newer lock is already in place */ }
      fs.rmSync(aside, { force: true });
      return false;
    }
    fs.rmSync(aside, { force: true });
  }
  return false;
}

function releaseLock() {
  const file = lockFile();
  if (myToken && tokenOf(readLock(file)) === myToken) fs.rmSync(file, { force: true });
  myToken = null;
}

async function withLock(fn) {
  if (!acquireLock()) throw errors.refused('Another Claude Code update is running. Try again in a minute.');
  try {
    return await fn();
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

// Decided by the `claude` that actually runs: an npm copy elsewhere is not it.
function method(info, bin) {
  if (!bin) return info ? 'npm' : null;
  if (!info) return 'native';
  let real = bin;
  try {
    real = fs.realpathSync(bin);
  } catch { /* keep the path as found */ }
  let pkgReal = info.pkgDir;
  try {
    pkgReal = fs.realpathSync(info.pkgDir);
  } catch { /* not installed */ }
  const inNpm = real.startsWith(pkgReal + path.sep) || path.resolve(path.dirname(bin)) === info.binDir;
  return inNpm ? 'npm' : 'native';
}

function plan({ info = inspect(), bin = findClaude(), target } = {}) {
  const how = target || method(info, bin);
  if (how === 'npm') return { how, cmd: `npm ${NPM_ARGS.join(' ')}`, leftovers: info ? info.leftovers : [] };
  if (how === 'native') return { how, cmd: 'claude update', leftovers: [] };
  return { how: null, cmd: null, leftovers: [] };
}

// Also repairs a half-finished install. npm 12 blocks the package's postinstall
// unless allowed, which leaves the placeholder; its own setup script fills it in.
// target: 'npm' repairs the npm install even when another claude runs first.
async function update({ write = (t) => process.stdout.write(t), dryRun = false, stdio = 'inherit', target, npm = runNpm, setup = runSetup, claude } = {}) {
  const bin = findClaude();
  const p = plan({ bin, target });
  const before = bin && p.how === method(inspect(), bin) ? getClaudeVersion(bin) : null;
  if (!p.how) throw errors.refused(`npm was not found. Install Claude Code: npm install -g ${PKG}`);
  if (dryRun) {
    write(`Would run: ${p.cmd}\n`);
    for (const l of p.leftovers) write(`Would remove: ${l}\n`);
    return { ran: false, cmd: p.cmd };
  }
  return withLock(async () => {
    write(`Running: ${p.cmd}\n`);
    const runClaude = claude || ((args, o) => run(bin, args, { timeout: INSTALL_TIMEOUT_MS, ...o }));
    const res = p.how === 'npm' ? await npm(NPM_ARGS, { stdio }) : await runClaude(['update'], { stdio });
    if (!res || res.status !== 0) throw errors.fail(`${p.cmd} failed. Nothing else was changed.`, 409);
    let checked = findClaude();
    if (p.how === 'npm') {
      let after = inspect();
      if (after && after.stub) {
        write('Unpacking the claude program (its install script did not run)\n');
        const r = await setup(after.pkgDir, { stdio });
        if (!r || r.status !== 0) throw errors.fail(`Could not unpack Claude Code. Run: node ${path.join(after.pkgDir, 'install.cjs')}`, 409);
        after = inspect();
      }
      if (after) {
        removeLeftovers(after.leftovers, write);
        const own = path.join(after.binDir, isWin() ? 'claude.cmd' : 'claude');
        if (fs.existsSync(own)) checked = own;
      }
    }
    const v = checked ? cachedClaudeVersion(checked) : null;
    if (!v) throw errors.fail('Claude Code still does not start after the update. Run: cchost doctor', 409);
    const msg = !before ? `Claude Code ${v.raw} starts again` : before.raw !== v.raw ? `Claude Code ${before.raw} → ${v.raw}` : `Claude Code ${v.raw} is up to date`;
    write(`${msg}\n`);
    return { ran: true, cmd: p.cmd, before: before ? before.raw : null, after: v.raw };
  });
}

async function cleanLeftovers({ write = (t) => process.stdout.write(t), info = inspect() } = {}) {
  if (!info || !info.leftovers.length) return 0;
  return withLock(async () => {
    removeLeftovers(info.leftovers, write);
    return info.leftovers.length;
  });
}

module.exports = { inspect, plan, update, cleanLeftovers, acquireLock, releaseLock, lockFile, LOCK_STALE_MS };
