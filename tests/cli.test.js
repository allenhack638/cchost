import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import cli from '../lib/cli.js';

describe('cc list — strict flag parsing', () => {
  let tmpHome;
  let originalHomedir;
  let originalLog;
  let originalWrite;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cli-'));
    originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
    originalLog = console.log;
    console.log = () => {};
    originalWrite = process.stdout.write;
    process.stdout.write = () => true;
  });

  afterEach(() => {
    os.homedir = originalHomedir;
    console.log = originalLog;
    process.stdout.write = originalWrite;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('rejects unknown flags on cc list', async () => {
    await expect(cli.run(['list', '--foo'])).rejects.toThrow(/Unknown flag: --foo/);
  });

  it('rejects positional argument on cc list', async () => {
    await expect(cli.run(['list', 'extra'])).rejects.toThrow(/Unexpected argument: extra/);
  });

  it('accepts --json on cc list', async () => {
    await expect(cli.run(['list', '--json'])).resolves.toBe(0);
  });

  it('rejects --original (removed with alias feature)', async () => {
    await expect(cli.run(['list', '--original'])).rejects.toThrow(/Unknown flag: --original/);
  });

  it('cc current is no longer a known command — returns 2 with help', async () => {
    await expect(cli.run(['current'])).resolves.toBe(2);
  });
});

describe('cc use — refuses to launch missing profile', () => {
  let tmpHome;
  let originalHomedir;
  let originalLog;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-use-miss-'));
    originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
    originalLog = console.log;
    console.log = () => {};
  });

  afterEach(() => {
    os.homedir = originalHomedir;
    console.log = originalLog;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('errors with a helpful message when the profile does not exist', async () => {
    await expect(cli.run(['use', 'ghost'])).rejects.toThrow(/does not exist.*cc add ghost/i);
  });

  it('errors when no profile is given', async () => {
    await expect(cli.run(['use'])).rejects.toThrow(/Usage: cc use/);
  });
});

describe('cc add — input validation', () => {
  let tmpHome;
  let originalHomedir;
  let originalLog;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-add-flag-'));
    originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
    originalLog = console.log;
    console.log = () => {};
  });

  afterEach(() => {
    os.homedir = originalHomedir;
    console.log = originalLog;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('rejects `cc add --resume` rather than creating ~/.claude-profiles/--resume', async () => {
    await expect(cli.run(['add', '--resume'])).rejects.toThrow(/looks like a flag/);
    expect(fs.existsSync(path.join(tmpHome, '.claude-profiles', '--resume'))).toBe(false);
  });

  it('rejects any extra argument after the profile name', async () => {
    await expect(cli.run(['add', 'work', '--bogus=x'])).rejects.toThrow(/no extra arguments/);
  });
});

describe('cc unknown action', () => {
  let originalErr;
  let originalWrite;

  beforeEach(() => {
    originalErr = process.stderr.write;
    process.stderr.write = () => true;
    originalWrite = process.stdout.write;
    process.stdout.write = () => true;
  });

  afterEach(() => {
    process.stderr.write = originalErr;
    process.stdout.write = originalWrite;
  });

  it('returns exit 2 and prints help', async () => {
    await expect(cli.run(['bogus-command'])).resolves.toBe(2);
  });
});

describe('cc --version', () => {
  let originalWrite;
  let captured;

  beforeEach(() => {
    captured = '';
    originalWrite = process.stdout.write;
    process.stdout.write = (s) => {
      captured += s;
      return true;
    };
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it('prints the package version for --version', async () => {
    const code = await cli.run(['--version']);
    expect(code).toBe(0);
    expect(captured.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('prints the package version for -v', async () => {
    const code = await cli.run(['-v']);
    expect(code).toBe(0);
    expect(captured.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('reports the same version as package.json', async () => {
    const pkg = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    await cli.run(['--version']);
    expect(captured.trim()).toBe(pkg.version);
  });
});
