import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import cli from '../lib/cli.js';
import profiles from '../lib/profiles.js';
import agent from '../lib/agent.js';
import commands from '../lib/commands.js';

const SECRET = 'sk-SENTINEL-5e4d3c2b1a0987654321';
const OAUTH = 'oauth-SENTINEL-refresh-abcdef0123456789';

let home;
let realHomedir;
let out;
let realWrite;
let realLog;
let realErr;
let stdinTTY;
let stdoutTTY;

async function run(...args) {
  out = '';
  const code = await cli.run(args);
  return { code, out };
}
const json = async (...args) => {
  const r = await run(...args);
  return { code: r.code, data: JSON.parse(r.out) };
};
const write = (f, d) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d));
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-agent-'));
  realHomedir = os.homedir;
  os.homedir = () => home;
  realWrite = process.stdout.write;
  realLog = console.log;
  realErr = process.stderr.write;
  process.stdout.write = (s) => { out += s; return true; };
  console.log = (...a) => { out += `${a.join(' ')}\n`; };
  process.stderr.write = () => true;
  stdinTTY = process.stdin.isTTY;
  stdoutTTY = process.stdout.isTTY;
  process.stdin.isTTY = false;
  process.stdout.isTTY = false;
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  write(path.join(home, '.claude.json'), { oauthAccount: { emailAddress: 'me@example.com' }, mcpServers: { db: { command: 'db', env: { K: SECRET } } } });
  write(path.join(home, '.claude', '.credentials.json'), { claudeAiOauth: {} });
});

afterEach(() => {
  os.homedir = realHomedir;
  process.stdout.write = realWrite;
  console.log = realLog;
  process.stderr.write = realErr;
  process.stdin.isTTY = stdinTTY;
  process.stdout.isTTY = stdoutTTY;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('existing account (alias)', () => {
  it('names the existing account without touching ~/.claude', async () => {
    const before = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
    const preview = await json('add', 'personal', '--existing', '--dry-run', '--json');
    expect(preview.data.ok).toBe(true);
    expect(profiles.getAlias()).toBe(null);
    expect((await run('add', 'personal', '--existing')).code).toBe(0);
    expect(profiles.getAlias()).toBe('personal');
    expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(home, '.claude-profiles', 'personal'))).toBe(false);
  });

  it('refuses link, unlink and copy on it', async () => {
    profiles.setAlias('personal');
    await expect(run('link', 'personal')).rejects.toThrow(/shared pool itself/);
    await expect(run('unlink', 'personal')).rejects.toThrow(/shared pool itself/);
    await expect(run('copy', 'default', 'personal')).rejects.toThrow(/shared pool itself/);
    const r = await json('link', 'personal', '--json');
    expect(r.data.ok).toBe(false);
  });

  it('remove only forgets the name, and never deletes ~/.claude', async () => {
    profiles.setAlias('personal');
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'keep');
    const r = await json('remove', 'personal', '--yes', '--json');
    expect(r.data.ok).toBe(true);
    expect(profiles.getAlias()).toBe(null);
    expect(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe('keep');
    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(true);
  });

  it('cannot collide with a profile folder', async () => {
    await run('add', 'work');
    await expect(run('add', 'work', '--existing')).rejects.toThrow(/already exists/);
    profiles.setAlias('me');
    await expect(run('add', 'me')).rejects.toThrow(/already the name of your existing account/);
  });

  it('shows up in list with the pool counted as shared', async () => {
    profiles.setAlias('personal');
    const r = await json('list', '--json');
    const p = r.data.find((x) => x.name === 'personal');
    expect(p).toMatchObject({ existingAccount: true, shared: 7, loggedIn: true });
  });

  it('naming it writes the pool\'s MCP servers into ~/.claude.json', async () => {
    write(path.join(home, '.claude', 'mcp.json'), { mcpServers: { plate: { command: 'plate' } } });
    const preview = await json('add', 'me', '--existing', '--dry-run', '--json');
    expect(preview.data.lines.map((l) => l.text).join('\n')).toMatch(/pool's MCP servers: plate/);
    await run('add', 'me', '--existing');
    const data = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    expect(data.mcpServers.plate.command).toBe('plate');
    expect(data.mcpServers.db.env.K).toBe(SECRET);
  });

  it('hidden folders in ~/.claude-profiles are not profiles', async () => {
    fs.mkdirSync(path.join(home, '.claude-profiles', '.mcp-backup-x'), { recursive: true });
    expect(profiles.listProfiles().map((p) => p.name)).toEqual([]);
  });
});

describe('agent-safe CLI', () => {
  it('remove without a terminal needs --yes', async () => {
    await run('add', 'work');
    await expect(run('remove', 'work')).rejects.toThrow(/needs confirmation/);
    expect(fs.existsSync(path.join(home, '.claude-profiles', 'work'))).toBe(true);
    expect((await json('remove', 'work', '--yes', '--json')).data.ok).toBe(true);
    expect(fs.existsSync(path.join(home, '.claude-profiles', 'work'))).toBe(false);
  });

  it('add --dry-run --json changes nothing', async () => {
    const r = await json('add', 'work', '--private=config', '--dry-run', '--json');
    expect(r.data).toMatchObject({ ok: true, dryRun: true });
    expect(fs.existsSync(path.join(home, '.claude-profiles', 'work'))).toBe(false);
  });

  it('endpoint profiles can be created without a token, and use refuses until it is set', async () => {
    await run('add', 'kimi', '--custom', '--base-url=https://api.moonshot.ai/anthropic');
    const st = await json('status', '--json');
    expect(st.data.profiles.find((p) => p.name === 'kimi').needsToken).toBe(true);
    expect(st.data.next.join('\n')).toMatch(/cchost token kimi/);
    await expect(run('use', 'kimi', '--version')).rejects.toThrow(/no token yet/);
  });

  it('token refuses without a terminal', async () => {
    await run('add', 'kimi', '--custom', '--base-url=https://x.io');
    await expect(run('token', 'kimi')).rejects.toThrow(/needs a person at a terminal/);
  });

  it('JSON errors keep stdout parseable', async () => {
    const r = await json('mcp', 'copy', 'ghost', 'pool', '--json');
    expect(r.code).toBe(1);
    expect(r.data.ok).toBe(false);
    expect(r.data.error).toMatch(/does not exist/);
  });

  it('doctor --fix --dry-run --json previews fixes', async () => {
    const r = await json('doctor', '--fix', '--dry-run', '--json');
    expect(r.data.dryRun).toBe(true);
  });

  it('status suggests the next steps for a fresh machine', async () => {
    const r = await json('status', '--json');
    expect(r.data.existing).toMatchObject({ found: true, loggedIn: true, name: null, mcp: ['db'] });
    expect(r.data.next.join('\n')).toMatch(/--existing/);
    expect(r.data.next.join('\n')).toMatch(/skill install/);
  });
});

describe('agent guides and skills', () => {
  it('prints every topic and rejects unknown ones', async () => {
    for (const t of agent.topics()) {
      const r = await run('agent', t);
      expect(r.code).toBe(0);
      expect(r.out.length).toBeGreaterThan(200);
    }
    await expect(run('agent', '../etc/passwd')).rejects.toThrow(/Unknown topic/);
    expect(agent.topics()).toEqual(['backups', 'doctor', 'mcp', 'overview', 'profiles', 'setup', 'sharing']);
  });

  it('help points agents at cchost agent', async () => {
    const r = await run('--help');
    expect(r.out).toMatch(/AI agents: run `cchost agent`/);
  });

  it('skills have frontmatter and point at cchost agent', () => {
    for (const name of agent.skillNames()) {
      const text = fs.readFileSync(path.join(agent.SKILLS_DIR, name, 'SKILL.md'), 'utf8');
      expect(text).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: .{40,}\\n---`));
      expect(text).toMatch(/cchost agent/);
      expect(text).toMatch(/--reveal/);
    }
  });

  it('installs into the pool, is idempotent, and never replaces a folder it did not create', async () => {
    expect((await json('skill', 'install', '--json')).data.lines.every((l) => l.kind === 'change')).toBe(true);
    expect(agent.skillStatus()).toMatchObject({ installed: true, current: true });
    expect((await json('skill', 'install', '--json')).data.lines.every((l) => l.kind === 'same')).toBe(true);
    fs.rmSync(path.join(home, '.claude', 'skills', 'cchost-setup'), { recursive: true });
    write(path.join(home, '.claude', 'skills', 'cchost-setup', 'SKILL.md'), 'mine');
    const r = await json('skill', 'install', '--json');
    expect(r.data.lines.find((l) => l.label === 'cchost-setup')).toMatchObject({ kind: 'warn', code: 'not-ours' });
    expect(fs.readFileSync(path.join(home, '.claude', 'skills', 'cchost-setup', 'SKILL.md'), 'utf8')).toBe('mine');
  });

  // Every `cchost ...` command in the guides and skills must parse.
  it('every command in the guides is a real command with real flags', async () => {
    const files = [
      ...agent.topics().map((t) => path.join(agent.GUIDES_DIR, `${t}.md`)),
      ...agent.skillNames().map((n) => path.join(agent.SKILLS_DIR, n, 'SKILL.md')),
    ];
    const known = {
      status: ['--json'], add: ['--existing', '--dry-run', '--json', '--private', '--custom', '--base-url'],
      use: null, list: ['--json'], link: ['--projects', '--tools', '--config', '--backup', '--dry-run', '--json'],
      unlink: ['--projects', '--tools', '--config', '--dry-run', '--json'], copy: ['--force', '--dry-run', '--json'],
      remove: ['--yes', '--force', '--dry-run', '--json'], doctor: ['--fix', '--force', '--dry-run', '--json'],
      mcp: ['--server', '--scope', '--project', '--force', '--dry-run', '--json'], backups: ['--json'],
      restore: ['--dry-run', '--json'], agent: [], skill: ['--profile', '--dry-run', '--json'], token: ['--stdin'],
      ui: [], help: [],
    };
    const found = [];
    for (const f of files) {
      const md = fs.readFileSync(f, 'utf8');
      const code = [...md.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1])
        .concat([...md.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map((m) => m[1]));
      const text = code.join('\n');
      for (const m of text.matchAll(/(?:^|! |\s)cchost ([a-z]+)((?: [^\n|#]*)?)/gm)) {
        const [, cmd, rest] = m;
        found.push(cmd);
        expect(Object.keys(known), `${path.basename(f)}: cchost ${cmd}`).toContain(cmd);
        if (known[cmd] === null) continue;
        for (const flag of rest.match(/--[a-z-]+/g) || []) {
          expect(known[cmd], `${path.basename(f)}: cchost ${cmd} ${flag}`).toContain(flag);
        }
      }
    }
    expect(found.length).toBeGreaterThan(30);
  });
});

describe('secrets never leave cchost', () => {
  beforeEach(async () => {
    write(path.join(home, '.claude', '.credentials.json'), { claudeAiOauth: { refreshToken: OAUTH } });
    await run('add', 'personal', '--existing');
    await run('add', 'work');
    write(path.join(home, '.claude-profiles', 'work', '.claude.json'), {
      oauthAccount: { emailAddress: 'w@corp.io' },
      mcpServers: { api: { type: 'http', url: `https://h.io/mcp?key=${SECRET}`, headers: { Authorization: `Bearer ${SECRET}` } } },
      projects: { '/p': { mcpServers: { l: { command: 'x', args: ['--token', SECRET] } } } },
    });
    write(path.join(home, '.claude-profiles', 'work', '.credentials.json'), { claudeAiOauth: { refreshToken: OAUTH } });
    await run('add', 'kimi', '--custom', '--base-url=https://api.example.com', `--token=${SECRET}`);
  });

  const commandsToCheck = [
    ['status'], ['status', '--json'], ['list'], ['list', '--json'], ['list', 'work', '--json'], ['list', 'kimi', '--json'],
    ['mcp', 'list'], ['mcp', 'list', '--json'], ['mcp', 'copy', 'work', 'pool', '--scope=all', '--dry-run', '--json'],
    ['mcp', 'copy', 'personal', 'work', '--json'], ['mcp', 'copy', 'work', 'pool', '--server=api', '--json'],
    ['mcp', 'sync', '--json'], ['backups', '--json'], ['doctor', '--json'], ['agent'], ['agent', 'setup'],
  ];
  for (const args of commandsToCheck) {
    it(`cchost ${args.join(' ')}`, async () => {
      const r = await run(...args);
      expect(r.out).not.toContain('SENTINEL');
    });
  }

  it('the web view state and MCP data carry no secrets', async () => {
    const actions = (await import('../lib/actions.js')).default;
    const mcp = (await import('../lib/mcp.js')).default;
    const text = JSON.stringify([actions.state(), mcp.listAll(), mcp.drift(), commands.status()]);
    expect(text).not.toContain('SENTINEL');
  });
});
