'use strict';

// The legacy `cc` alias shares its name with the POSIX C compiler, and npm's
// global bin dir often sits ahead of /usr/bin on PATH. Build tools (make,
// node-gyp, configure scripts) then run cchost instead of the compiler. When
// we are invoked as `cc` with arguments that are not a cchost command, hand
// the call to the next real `cc` on PATH so both uses keep working.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// First arguments that mean "this is cchost". Everything else — `-c`, `-o`,
// `foo.c`, and `--version` / `-v`, which build tools use to probe the
// compiler — goes to the compiler. Use `cchost --version` for cchost itself.
const CCHOST_FIRST_ARGS = new Set([
  'add', 'use', 'list', 'copy', 'migrate', 'link', 'unlink', 'remove',
  'doctor', 'help', 'env', '--help', '-h',
]);

function invokedAsCc(argv1 = process.argv[1]) {
  // npm installs `cc` as a symlink on POSIX and Node keeps the symlink's name
  // in argv[1]. Windows .cmd shims call bin/cc.js directly, so this is false
  // there — `cc` is rarely a compiler on Windows anyway.
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

module.exports = { invokedAsCc, shouldForward, findCompiler, maybeForward, CCHOST_FIRST_ARGS };
