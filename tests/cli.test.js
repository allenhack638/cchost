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

  it('treats a single positional as a profile name (cc list <profile>)', async () => {
    await expect(cli.run(['list', 'extra'])).rejects.toThrow(/Profile "extra" does not exist/);
  });

  it('rejects a second positional argument on cc list', async () => {
    await expect(cli.run(['list', 'a', 'b'])).rejects.toThrow(/Unexpected argument: b/);
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

describe('cc link / cc unlink — --tools and --projects flags', () => {
  let tmpHome;
  let originalHomedir;
  let originalLog;
  let originalErr;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-link-flags-'));
    originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
    originalLog = console.log;
    console.log = () => {};
    originalErr = process.stderr.write;
    process.stderr.write = () => true;
  });

  afterEach(() => {
    os.homedir = originalHomedir;
    console.log = originalLog;
    process.stderr.write = originalErr;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('cc link <profile> --tools links only skills/agents/commands', async () => {
    await cli.run(['add', 'work']);
    // Wipe all artifacts back to nothing to start clean
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    for (const sub of ['projects', 'skills', 'agents', 'commands']) {
      try { fs.unlinkSync(path.join(pdir, sub)); } catch { /* ignore */ }
      try { fs.rmdirSync(path.join(pdir, sub)); } catch { /* ignore */ }
    }
    await cli.run(['link', 'work', '--tools']);
    expect(fs.existsSync(path.join(pdir, 'projects'))).toBe(false);
    for (const sub of ['skills', 'agents', 'commands']) {
      expect(fs.lstatSync(path.join(pdir, sub)).isSymbolicLink()).toBe(true);
    }
  });

  it('cc unlink <profile> --projects only unlinks projects/', async () => {
    await cli.run(['add', 'work']);
    await cli.run(['unlink', 'work', '--projects']);
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    expect(fs.lstatSync(path.join(pdir, 'projects')).isSymbolicLink()).toBe(false);
    for (const sub of ['skills', 'agents', 'commands']) {
      expect(fs.lstatSync(path.join(pdir, sub)).isSymbolicLink()).toBe(true);
    }
  });

  it('cc link rejects unknown flags', async () => {
    await cli.run(['add', 'work']);
    await expect(cli.run(['link', 'work', '--bogus'])).rejects.toThrow(/Unknown flag/);
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
    await expect(cli.run(['use', 'ghost'])).rejects.toThrow(/does not exist.*cchost add ghost/i);
  });

  it('errors when no profile is given', async () => {
    await expect(cli.run(['use'])).rejects.toThrow(/Usage: cchost use/);
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
    await expect(cli.run(['add', '--resume'])).rejects.toThrow(/Unknown flag: --resume/);
    expect(fs.existsSync(path.join(tmpHome, '.claude-profiles', '--resume'))).toBe(false);
  });

  it('rejects an unknown flag after the profile name', async () => {
    await expect(cli.run(['add', 'work', '--bogus=x'])).rejects.toThrow(/Unknown flag: --bogus/);
  });

  it('rejects an extra positional argument after the profile name', async () => {
    await expect(cli.run(['add', 'work', 'extra'])).rejects.toThrow(/no extra arguments/);
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

  it('help migrate prints command-specific help without the banner', async () => {
    let out = '';
    const noop = process.stdout.write;
    process.stdout.write = (s) => { out += s; return true; };
    try {
      await expect(cli.run(['help', 'migrate'])).resolves.toBe(0);
    } finally {
      process.stdout.write = noop;
    }
    expect(out).toMatch(/Deprecated alias/);
    expect(out).not.toMatch(/████/);
  });

  it('bare help prints the banner with the package version', async () => {
    let out = '';
    const noop = process.stdout.write;
    process.stdout.write = (s) => { out += s; return true; };
    try {
      await expect(cli.run(['help'])).resolves.toBe(0);
    } finally {
      process.stdout.write = noop;
    }
    expect(out).toMatch(/cchost \d+\.\d+\.\d+/);
  });

  it('cc env (removed in v0.3.1) returns exit 2 with a migration hint', async () => {
    let err = '';
    process.stderr.write = (s) => { err += s; return true; };
    const code = await cli.run(['env', 'kimi']);
    expect(code).toBe(2);
    expect(err).toMatch(/removed in v0\.3\.1/);
    expect(err).toMatch(/cchost add <profile> --custom/);
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

describe('cc — v0.4.1 surface', () => {
  let tmpHome;
  let originalHomedir;
  let originalLog;
  let originalErr;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-v041-'));
    originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
    originalLog = console.log;
    console.log = () => {};
    originalErr = process.stderr.write;
    process.stderr.write = () => true;
  });

  afterEach(() => {
    os.homedir = originalHomedir;
    console.log = originalLog;
    process.stderr.write = originalErr;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('cc add auto-links all 7 resources by default', async () => {
    await cli.run(['add', 'work']);
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    for (const sub of ['projects', 'skills', 'agents', 'commands']) {
      expect(fs.lstatSync(path.join(pdir, sub)).isSymbolicLink()).toBe(true);
    }
    const share = (await import('../lib/share.js')).default;
    for (const f of ['mcp.json', 'settings.json', 'CLAUDE.md']) {
      expect(share.isSharedResource(pdir, f)).toBe(true);
    }
  });

  it('cc link --config links only mcp.json, settings.json, CLAUDE.md', async () => {
    await cli.run(['add', 'work']);
    await cli.run(['unlink', 'work']);
    // Now everything is private. Re-link only --config.
    // First clear the private config files so link doesn't refuse them.
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    for (const f of ['mcp.json', 'settings.json', 'CLAUDE.md']) {
      try { fs.unlinkSync(path.join(pdir, f)); } catch { /* skip */ }
    }
    const code = await cli.run(['link', 'work', '--config']);
    expect(code).toBe(0);
    const share = (await import('../lib/share.js')).default;
    for (const f of ['mcp.json', 'settings.json', 'CLAUDE.md']) {
      expect(share.isSharedResource(pdir, f)).toBe(true);
    }
    // Tool dirs stay unlinked
    for (const sub of ['skills', 'agents', 'commands']) {
      expect(fs.lstatSync(path.join(pdir, sub)).isSymbolicLink()).toBe(false);
    }
  });

  it('cc link refuses to overwrite private content (does not auto-merge)', async () => {
    await cli.run(['add', 'work']);
    await cli.run(['unlink', 'work', '--projects']);
    // Add private content to projects/
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(path.join(pdir, 'projects', 'MyProject'), { recursive: true });
    fs.writeFileSync(path.join(pdir, 'projects', 'MyProject', 'note.txt'), 'private');

    const code = await cli.run(['link', 'work', '--projects']);
    expect(code).toBe(1);
    // Private content stays where it was
    expect(fs.existsSync(path.join(pdir, 'projects', 'MyProject', 'note.txt'))).toBe(true);
    // Still not a symlink
    expect(fs.lstatSync(path.join(pdir, 'projects')).isSymbolicLink()).toBe(false);
  });

  it('cc remove without --force errors when private content exists', async () => {
    await cli.run(['add', 'work']);
    await cli.run(['unlink', 'work', '--projects']);
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.mkdirSync(path.join(pdir, 'projects', 'X'), { recursive: true });
    fs.writeFileSync(path.join(pdir, 'projects', 'X', 'priv.txt'), 'cant-lose');

    await expect(cli.run(['remove', 'work'])).rejects.toThrow(/private[\s\S]*--force/i);
    // Profile still exists
    expect(fs.existsSync(pdir)).toBe(true);
  });

  it('cc migrate forwards to cc copy with a deprecation warning', async () => {
    // Seed default with content the copy can act on
    const def = path.join(tmpHome, '.claude');
    fs.mkdirSync(path.join(def, 'projects', 'X'), { recursive: true });
    fs.writeFileSync(path.join(def, 'projects', 'X', 'p.txt'), 'pool');

    // Create profile without auto-linking the projects dir
    await cli.run(['add', 'work']);
    await cli.run(['unlink', 'work', '--projects']);
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');

    let stderr = '';
    process.stderr.write = (s) => { stderr += s; return true; };

    const code = await cli.run(['migrate', 'default', 'work']);
    expect(code).toBe(0);
    expect(stderr).toMatch(/deprecated/i);
    expect(stderr).toMatch(/cchost copy/);
    // Pool content reached the profile via the forwarded copy
    expect(fs.existsSync(path.join(pdir, 'projects', 'X', 'p.txt'))).toBe(true);
  });

  it('cc list shows N/7 in the Shared column', async () => {
    let captured = '';
    console.log = (...args) => { captured += args.join(' ') + '\n'; };
    await cli.run(['add', 'work']);
    captured = '';
    await cli.run(['list']);
    expect(captured).toMatch(/\b\d\/7\b/);
  });
});

describe('cchost list <profile> resources, --dry-run, help sharing', () => {
  let tmpHome;
  let originalHomedir;
  let originalLog;
  let originalWrite;
  let out;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cli-res-'));
    originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
    out = '';
    originalLog = console.log;
    console.log = (...a) => { out += a.join(' ') + '\n'; };
    originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => { out += String(chunk); return true; };
  });

  afterEach(() => {
    os.homedir = originalHomedir;
    console.log = originalLog;
    process.stdout.write = originalWrite;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('list <profile> --json reports the state of each resource', async () => {
    await cli.run(['add', 'work']);
    await cli.run(['unlink', 'work', '--config']);
    out = '';
    await cli.run(['list', 'work', '--json']);
    const obj = JSON.parse(out);
    expect(obj.shared).toBe(4);
    expect(obj.resources).toMatchObject({
      projects: 'shared',
      skills: 'shared',
      'settings.json': 'empty',
    });
  });

  it('link, unlink, and copy accept --dry-run and say so', async () => {
    await cli.run(['add', 'work']);
    for (const argv of [
      ['link', 'work', '--dry-run'],
      ['unlink', 'work', '--dry-run'],
      ['copy', 'default', 'work', '--dry-run'],
    ]) {
      out = '';
      await expect(cli.run(argv)).resolves.toBe(0);
      expect(out).toMatch(/Dry run — nothing will be changed/);
    }
    expect(fs.lstatSync(path.join(tmpHome, '.claude-profiles', 'work', 'skills')).isSymbolicLink())
      .toBe(true);
  });

  it('help sharing prints the task guide', async () => {
    await cli.run(['help', 'sharing']);
    expect(out).toMatch(/what profiles share/);
    expect(out).toMatch(/cchost unlink work --config/);
  });
});
