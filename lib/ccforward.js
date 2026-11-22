'use strict';

// The `cc` alias can shadow the C compiler on PATH, so build tools run cchost.
// Invoked as `cc` without a cchost command, hand off to the next real `cc`.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Anything else goes to the compiler, including `-v` / `--version`, which build
// tools use as a probe.
const CCHOST_FIRST_ARGS = new Set([
  'add', 'use', 'list', 'copy', 'migrate', 'link', 'unlink', 'remove',
  'doctor', 'ui', 'help', 'env', '--help', '-h',
  'status', 'mcp', 'backups', 'restore', 'update', 'agent', 'skill', 'skills', 'token',
  'pin', 'unpin', 'pins', 'which', 'go', 'find', 'open', 'index',
]);

function invokedAsCc(argv1 = process.argv[1]) {
  // POSIX npm symlinks `cc`, so argv[1] keeps that name. Windows shims call
  // bin/cc.js directly, so this is false there.
  return Boolean(argv1) && path.basename(argv1) === 'cc';
}

function shouldForward(args) {
  // Bare `cc` keeps printing cchost help, as it always has.
  return args.length > 0 && !CCHOST_FIRST_ARGS.has(args[0]);
}

function realpathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

// The first executable `cc` on PATH that is not cchost (this install or any
// other cchost install, e.g. under another nvm Node version).
function findCompiler({ env = process.env, self = process.argv[1] } = {}) {
  const selfReal = realpathOrNull(self);
  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, 'cc');
    const real = realpathOrNull(candidate);
    if (!real || real === selfReal) continue;
    if (/[\\/]cchost[\\/]bin[\\/]cc\.js$/.test(real)) continue;
    try {
      if (!fs.statSync(real).isFile()) continue;
      fs.accessSync(real, fs.constants.X_OK);
    } catch {
      continue;
    }
    return candidate;
  }
  return null;
}

// Returns the compiler's exit code, or null when the call is not forwarded
// (not invoked as `cc`, a cchost command, or no compiler found).
function maybeForward(args, { argv1 = process.argv[1], env = process.env } = {}) {
  if (!invokedAsCc(argv1) || !shouldForward(args)) return null;
  const compiler = findCompiler({ env, self: argv1 });
  if (!compiler) return null;
  const res = spawnSync(compiler, args, { stdio: 'inherit', env });
  if (res.error) throw res.error;
  if (res.signal) {
    process.kill(process.pid, res.signal);
    return 1;
  }
  return res.status === null ? 1 : res.status;
}

module.exports = { invokedAsCc, shouldForward, findCompiler, maybeForward };
