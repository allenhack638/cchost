'use strict';

// Update notice: a detached child refreshes the latest npm version at most
// once a day; commands only read the cached result.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DAY_MS = 24 * 60 * 60 * 1000;
const REGISTRY_URL = 'https://registry.npmjs.org/cchost/latest';

function cacheFile() {
  return path.join(os.homedir(), '.claude-profiles', '.cc-update.json');
}

function currentVersion() {
  return require('../package.json').version;
}

function disabled(env = process.env) {
  return Boolean(env.CCHOST_NO_UPDATE_CHECK || env.CI || env.NO_UPDATE_NOTIFIER);
}

function readCache() {
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeCache(data) {
  fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
  fs.writeFileSync(cacheFile(), JSON.stringify(data));
}

function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? m.slice(1).map(Number) : null;
}

function isNewer(latest, current) {
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// { current, latest } when a newer release is cached, else null.
function available(current = currentVersion()) {
  const { latest } = readCache();
  return isNewer(latest, current) ? { current, latest } : null;
}

function notice(current = currentVersion()) {
  const u = available(current);
  if (!u) return null;
  return `cchost ${u.latest} is available (you have ${u.current}). Update: npm install -g cchost@latest`;
}

function due(now = Date.now()) {
  const { checkedAt } = readCache();
  return !Number.isFinite(checkedAt) || now - checkedAt > DAY_MS;
}

function checkInBackground() {
  if (disabled() || !due()) return false;
  try {
    // Stamp first so parallel runs don't all spawn a check.
    writeCache({ ...readCache(), checkedAt: Date.now() });
    const child = spawn(process.execPath, [__filename, '--fetch'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function fetchLatest() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(REGISTRY_URL, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return;
    const { version } = await res.json();
    if (parse(version)) writeCache({ ...readCache(), checkedAt: Date.now(), latest: version });
  } catch {
    // Offline or blocked: try again tomorrow.
  } finally {
    clearTimeout(timer);
  }
}

if (require.main === module && process.argv[2] === '--fetch') fetchLatest();

module.exports = { available, notice, checkInBackground, isNewer, disabled, due, readCache, writeCache, cacheFile, DAY_MS };
