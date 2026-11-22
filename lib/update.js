'use strict';

// Update notice: a detached child refreshes the latest npm version at most
// once a day; commands only read the cached result.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DAY_MS = 24 * 60 * 60 * 1000;
const REGISTRY_URL = 'https://registry.npmjs.org/cchost/latest';
const CLAUDE_URL = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest';

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

function claudeAvailable(current) {
  const { claudeLatest } = readCache();
  return current && isNewer(claudeLatest, current) ? { current, latest: claudeLatest } : null;
}

function notice(current = currentVersion(), claudeCurrent = null) {
  const out = [];
  const u = available(current);
  if (u) out.push(`cchost ${u.latest} is available (you have ${u.current}). Update: npm install -g cchost@latest`);
  const c = claudeAvailable(claudeCurrent);
  if (c) out.push(`Claude Code ${c.latest} is available (you have ${c.current}). Update: cchost update claude`);
  return out.length ? out.join('\n') : null;
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

async function latestOf(url, signal) {
  try {
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const { version } = await res.json();
    return parse(version) ? version : null;
  } catch {
    return null;
  }
}

async function fetchLatest() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const [latest, claudeLatest] = await Promise.all([latestOf(REGISTRY_URL, ctrl.signal), latestOf(CLAUDE_URL, ctrl.signal)]);
    const next = { ...readCache(), checkedAt: Date.now() };
    if (latest) next.latest = latest;
    if (claudeLatest) next.claudeLatest = claudeLatest;
    writeCache(next);
  } finally {
    clearTimeout(timer);
  }
}

if (require.main === module && process.argv[2] === '--fetch') fetchLatest();

module.exports = { available, notice, checkInBackground, isNewer, disabled, due, readCache, writeCache, cacheFile, DAY_MS };
