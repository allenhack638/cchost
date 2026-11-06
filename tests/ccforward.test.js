import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import ccforward from '../lib/ccforward.js';

const posix = process.platform !== 'win32';

describe('cc forwarding — which calls go to the compiler', () => {
  it('only applies when invoked through a file named cc', () => {
    expect(ccforward.invokedAsCc('/usr/local/bin/cc')).toBe(true);
    expect(ccforward.invokedAsCc('/usr/local/bin/cchost')).toBe(false);
    expect(ccforward.invokedAsCc('/x/node_modules/cchost/bin/cc.js')).toBe(false);
    expect(ccforward.invokedAsCc(undefined)).toBe(false);
  });

  it('keeps cchost commands and bare cc, forwards compiler-style calls', () => {
    for (const cmd of ['use', 'list', 'link', 'doctor', 'help', '--help']) {
      expect(ccforward.shouldForward([cmd, 'x'])).toBe(false);
    }
    expect(ccforward.shouldForward([])).toBe(false);
    for (const args of [['-c', 'a.c'], ['-o', 'a', 'a.c'], ['a.c'], ['--version'], ['-v'], ['-E', '-']]) {
      expect(ccforward.shouldForward(args)).toBe(true);
    }
  });
});

describe.runIf(posix)('cc forwarding — finding and running the compiler', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fwd-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function script(dir, name, body) {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(p, 0o755);
    return p;
  }

  // Layout: <tmp>/self/cc -> fake cchost; <tmp>/other/cc -> another cchost
  // install; <tmp>/sys/cc -> the "compiler".
  function layout() {
    const selfTarget = script(path.join(tmp, 'a', 'node_modules', 'cchost', 'bin'), 'cc.js', 'exit 0');
    const otherTarget = script(path.join(tmp, 'b', 'node_modules', 'cchost', 'bin'), 'cc.js', 'exit 0');
    fs.mkdirSync(path.join(tmp, 'self'));
    fs.mkdirSync(path.join(tmp, 'other'));
    fs.symlinkSync(selfTarget, path.join(tmp, 'self', 'cc'));
    fs.symlinkSync(otherTarget, path.join(tmp, 'other', 'cc'));
    const compiler = script(path.join(tmp, 'sys'), 'cc', 'echo "compiled $*"; exit 7');
    const PATH = ['self', 'other', 'sys'].map((d) => path.join(tmp, d)).join(path.delimiter);
    return { self: path.join(tmp, 'self', 'cc'), compiler, PATH };
  }

  it('skips this and other cchost installs and finds the real compiler', () => {
    const { self, compiler, PATH } = layout();
    expect(ccforward.findCompiler({ env: { PATH }, self })).toBe(compiler);
  });

  it('returns null when no compiler is on PATH', () => {
    const { self } = layout();
    const PATH = [path.join(tmp, 'self'), path.join(tmp, 'other')].join(path.delimiter);
    expect(ccforward.findCompiler({ env: { PATH }, self })).toBeNull();
    expect(ccforward.maybeForward(['-c', 'a.c'], { argv1: self, env: { PATH } })).toBeNull();
  });

  it('runs the compiler with the original args and returns its exit code', () => {
    const { self, PATH } = layout();
    expect(ccforward.maybeForward(['-c', 'a.c'], { argv1: self, env: { PATH } })).toBe(7);
  });

  it('does not forward cchost commands', () => {
    const { self, PATH } = layout();
    expect(ccforward.maybeForward(['list'], { argv1: self, env: { PATH } })).toBeNull();
  });
});
