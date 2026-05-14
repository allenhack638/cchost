'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const color = require('./color');

const MIN_VERSION = [2, 1, 140];
const MIN_VERSION_STR = MIN_VERSION.join('.');
const CMD_META_RE = /([()\][%!^"`<>&|;, *?])/g;
const CACHE_FILE = path.join(os.homedir(), '.claude-profiles', '.cc-cache.json');

function pathListSep() {
  return process.platform === 'win32' ? ';' : ':';
}

function pathExt() {
  if (process.platform !== 'win32') return [''];
  const raw = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  return raw.split(';').map((s) => s.trim()).filter(Boolean);
}

function findClaude() {
  const PATH = process.env.PATH || process.env.Path || '';
  if (!PATH) return null;
  const dirs = PATH.split(pathListSep()).filter(Boolean);
  const exts = pathExt();
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, 'claude' + ext);
      try {
        const st = fs.statSync(full);
        if (st.isFile()) return full;
      } catch {
        // not found, keep scanning
      }
    }
  }
  return null;
}

function parseVersion(text) {
  if (!text) return null;
  const m = String(text).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], raw: m[0] };
}

function compareVersion(v, target) {
  if (!v) return 0;
  const [a, b, c] = target;
  if (v.major !== a) return v.major - a;
  if (v.minor !== b) return v.minor - b;
  return v.patch - c;
}

function getClaudeVersion(bin) {
  try {
    const opts = { encoding: 'utf8', timeout: 5000 };
    let res;
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
      const cmdLine = [escapeCommandWin(bin), escapeArgWin('--version')].join(' ');
      res = spawnSync(process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', `"${cmdLine}"`], { ...opts, windowsVerbatimArguments: true });
    } else {
      res = spawnSync(bin, ['--version'], opts);
    }
    if (!res || res.status !== 0) return null;
    return parseVersion(res.stdout);
  } catch {
    return null;
  }
}

function readCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeCache(data) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
  } catch {
    // cache is best-effort; ignore write failures
  }
}

function cachedClaudeVersion(bin) {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(bin).mtimeMs;
  } catch {
    return getClaudeVersion(bin);
  }
  const cache = readCache();
  if (
    cache &&
    cache.binPath === bin &&
    cache.binMtimeMs === mtimeMs &&
    cache.minVersion === MIN_VERSION_STR &&
    cache.version
  ) {
    return cache.version;
  }
  const v = getClaudeVersion(bin);
  if (v) {
    writeCache({
      binPath: bin,
      binMtimeMs: mtimeMs,
      minVersion: MIN_VERSION_STR,
      version: v,
      checkedAt: new Date().toISOString(),
    });
  }
  return v;
}

function warnIfOld(bin, write) {
  const w = write || ((s) => process.stderr.write(s + '\n'));
  const v = cachedClaudeVersion(bin);
  if (v && compareVersion(v, MIN_VERSION) < 0) {
    const msg = `warning: Claude Code ${v.raw} is older than ${MIN_VERSION_STR}. CLAUDE_CONFIG_DIR isolation has known bugs in this range. Run \`claude update\` before relying on profiles.`;
    w(color.stderr.yellow(msg));
  }
}

function escapeArgWin(arg) {
  let s = String(arg);
  s = s.replace(/(\\*)"/g, '$1$1\\"');
  s = s.replace(/(\\*)$/, '$1$1');
  s = `"${s}"`;
  s = s.replace(CMD_META_RE, '^$1');
  return s;
}

function escapeCommandWin(cmd) {
  return cmd.replace(CMD_META_RE, '^$1');
}

function platformSpawn(bin, args, opts) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const cmdLine = [escapeCommandWin(bin), ...args.map(escapeArgWin)].join(' ');
    return spawn(
      process.env.COMSPEC || 'cmd.exe',
      ['/d', '/s', '/c', `"${cmdLine}"`],
      { ...opts, windowsVerbatimArguments: true },
    );
  }
  return spawn(bin, args, opts);
}

function spawnClaude({ args = [], profileDir = null, extraEnv = {} } = {}) {
  const bin = findClaude();
  if (!bin) {
    const err = new Error(
      'Claude Code does not appear to be installed (no `claude` on PATH).\n' +
      'Install it:  npm install -g @anthropic-ai/claude-code\n' +
      'Docs:        https://code.claude.com',
    );
    err.exitCode = 127;
    throw err;
  }
  warnIfOld(bin);

  const childEnv = { ...process.env, ...extraEnv };
  if (profileDir) {
    childEnv.CLAUDE_CONFIG_DIR = profileDir;
  } else {
    delete childEnv.CLAUDE_CONFIG_DIR;
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = platformSpawn(bin, args, {
        stdio: 'inherit',
        env: childEnv,
        windowsHide: false,
      });
    } catch (err) {
      console.error(`Failed to launch claude: ${err.message}`);
      resolve(127);
      return;
    }

    child.on('error', (err) => {
      console.error(`Failed to launch claude: ${err.message}`);
      resolve(127);
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        try {
          process.kill(process.pid, signal);
        } catch {
          resolve(128);
        }
      } else {
        resolve(code == null ? 0 : code);
      }
    });
  });
}

module.exports = {
  findClaude,
  getClaudeVersion,
  cachedClaudeVersion,
  parseVersion,
  compareVersion,
  warnIfOld,
  platformSpawn,
  spawnClaude,
  escapeArgWin,
  escapeCommandWin,
  MIN_VERSION,
  CACHE_FILE,
};
