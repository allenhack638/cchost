import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import uiServer from '../lib/ui/server.js';
import cli from '../lib/cli.js';
import update from '../lib/update.js';

// Raw http.request so tests control the Host header (fetch forbids it).
function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* html or text */ }
        resolve({ status: res.statusCode, headers: res.headers, text: data, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const USER = 'cchost';
const PASS = 'correct-horse-9';

function cookieOf(res) {
  const set = res.headers['set-cookie'];
  return set ? set[0].split(';')[0] : null;
}

describe('cchost ui server', () => {
  let tmpHome;
  let originalHomedir;
  let originalLog;
  let server;
  let port;
  let cookie;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ui-'));
    originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
    originalLog = console.log;
    console.log = () => {};
    await cli.run(['add', 'work']);
    await cli.run(['add', 'kimi', '--custom', '--base-url=https://api.moonshot.ai/anthropic', '--token=sk-secret-token-123']);
    server = uiServer.createServer({ user: USER, pass: PASS });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
    const login = await request(port, {
      method: 'POST', path: '/api/login', body: { user: USER, pass: PASS },
      headers: { Host: `127.0.0.1:${port}`, 'X-CCHost': '1', 'Content-Type': 'application/json' },
    });
    cookie = cookieOf(login);
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    os.homedir = originalHomedir;
    console.log = originalLog;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const host = () => ({ Host: `127.0.0.1:${port}` });
  const auth = () => ({ ...host(), 'X-CCHost': '1', Cookie: cookie });
  const post = (p, body, extra = {}) => request(port, {
    method: 'POST', path: p, body, headers: { ...auth(), 'Content-Type': 'application/json', ...extra },
  });

  it('issues an HttpOnly, SameSite=Strict session cookie on sign-in', async () => {
    expect(cookie).toMatch(/^cchost_session=[0-9a-f]{64}$/);
    const res = await request(port, {
      method: 'POST', path: '/api/login', body: { user: USER, pass: PASS },
      headers: { ...host(), 'X-CCHost': '1', 'Content-Type': 'application/json' },
    });
    expect(res.headers['set-cookie'][0]).toMatch(/HttpOnly; SameSite=Strict; Path=\/; Max-Age=28800/);
  });

  it('shows the sign-in page without a session and the app with one', async () => {
    const out = await request(port, { headers: host() });
    expect(out.status).toBe(200);
    expect(out.text).toContain('Sign in');
    expect(out.text).not.toContain('id="view"');
    const inside = await request(port, { headers: { ...host(), Cookie: cookie } });
    expect(inside.text).toContain('id="view"');
    expect(inside.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(inside.headers['content-security-policy']).toMatch(/script-src 'nonce-/);
    expect(inside.text).not.toContain('__NONCE__');
    expect(inside.text).not.toContain('/*__TOKENS__*/');
  });

  it('accepts a one-time sign-in link exactly once', async () => {
    const code = server.issueCode();
    const first = await request(port, { path: `/?code=${code}`, headers: host() });
    expect(first.status).toBe(303);
    expect(first.headers.location).toBe('/');
    expect(cookieOf(first)).toMatch(/^cchost_session=/);
    const again = await request(port, { path: `/?code=${code}`, headers: host() });
    expect(again.headers.location).toBe('/?expired=1');
    expect(again.headers['set-cookie']).toBeUndefined();
  });

  it('rejects wrong passwords and locks out after repeated failures', async () => {
    const bad = () => request(port, {
      method: 'POST', path: '/api/login', body: { user: USER, pass: 'nope' },
      headers: { ...host(), 'X-CCHost': '1', 'Content-Type': 'application/json' },
    });
    for (let i = 0; i < 4; i++) expect((await bad()).status).toBe(401);
    expect((await bad()).status).toBe(401);
    const locked = await request(port, {
      method: 'POST', path: '/api/login', body: { user: USER, pass: PASS },
      headers: { ...host(), 'X-CCHost': '1', 'Content-Type': 'application/json' },
    });
    expect(locked.status).toBe(429);
  });

  it('signs out', async () => {
    const out = await post('/api/logout', {});
    expect(out.headers['set-cookie'][0]).toMatch(/Max-Age=0/);
    expect((await request(port, { path: '/api/state', headers: auth() })).status).toBe(401);
  });

  it('rejects other Host headers (DNS rebinding)', async () => {
    const res = await request(port, { headers: { Host: `evil.example:${port}`, Cookie: cookie } });
    expect(res.status).toBe(403);
  });

  it('answers malformed paths with 404, not a server error', async () => {
    const res = await request(port, { method: 'GET', path: '//', headers: auth() });
    expect(res.status).toBe(404);
  });

  it('requires a session and the X-CCHost header on the API', async () => {
    expect((await request(port, { path: '/api/state', headers: { ...host(), 'X-CCHost': '1' } })).status).toBe(401);
    expect((await request(port, { path: '/api/state', headers: { ...host(), Cookie: cookie } })).status).toBe(403);
    expect((await request(port, { path: '/api/state', headers: { ...host(), 'X-CCHost': '1', Cookie: 'cchost_session=deadbeef' } })).status).toBe(401);
  });

  it('refuses cross-origin and non-JSON POSTs', async () => {
    const body = { action: 'remove', profile: 'work', confirm: 'work' };
    expect((await post('/api/apply', body, { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await post('/api/apply', body, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect(fs.existsSync(path.join(tmpHome, '.claude-profiles', 'work'))).toBe(true);
  });

  it('includes an available update in the state', async () => {
    update.writeCache({ checkedAt: Date.now(), latest: '99.0.0' });
    const res = await request(port, { path: '/api/state', headers: auth() });
    expect(res.json.update).toMatchObject({ latest: '99.0.0' });
  });

  it('reports state without endpoint tokens', async () => {
    const res = await request(port, { path: '/api/state', headers: auth() });
    expect(res.text).not.toContain('sk-secret-token-123');
    const kimi = res.json.profiles.find((p) => p.name === 'kimi');
    expect(kimi).toMatchObject({ kind: 'endpoint', endpoint: 'api.moonshot.ai' });
    expect(res.json.profiles.find((p) => p.name === 'work').resources.skills).toBe('shared');
  });

  it('previews without changing anything, then applies and logs activity', async () => {
    const skills = path.join(tmpHome, '.claude-profiles', 'work', 'skills');
    const preview = await post('/api/preview', { action: 'unlink', profile: 'work', groups: ['tools'] });
    expect(preview.json.lines.map((l) => l.resource)).toEqual(['skills', 'agents', 'commands']);
    expect(fs.lstatSync(skills).isSymbolicLink()).toBe(true);

    const applied = await post('/api/apply', { action: 'unlink', profile: 'work', groups: ['tools'] });
    expect(applied.json.entry).toMatchObject({ ok: true, title: 'Make tools private · work' });
    expect(fs.lstatSync(skills).isSymbolicLink()).toBe(false);
    expect(applied.json.state.profiles.find((p) => p.name === 'work').resources.skills).toBe('private');

    const activity = await request(port, { path: '/api/activity', headers: auth() });
    expect(activity.json.activity).toHaveLength(1);
  });

  it('flags private content on share, then shares it with a backup', async () => {
    const pdir = path.join(tmpHome, '.claude-profiles', 'work');
    fs.unlinkSync(path.join(pdir, 'CLAUDE.md'));
    fs.writeFileSync(path.join(pdir, 'CLAUDE.md'), '# work only');
    const plain = await post('/api/preview', { action: 'link', profile: 'work', groups: ['config'] });
    const held = plain.json.lines.find((l) => l.resource === 'CLAUDE.md');
    expect(held).toMatchObject({ kind: 'warn', code: 'private-content' });
    expect(plain.json.lines.some((l) => l.kind === 'change')).toBe(false);

    const withBackup = await post('/api/preview', { action: 'link', profile: 'work', groups: ['config'], backup: true });
    expect(withBackup.json.lines.find((l) => l.resource === 'CLAUDE.md')).toMatchObject({ kind: 'change' });
    const applied = await post('/api/apply', { action: 'link', profile: 'work', groups: ['config'], backup: true });
    expect(applied.json.entry).toMatchObject({ ok: true, title: 'Share config (with backup) · work' });
    const backups = fs.readdirSync(pdir).filter((f) => f.startsWith('CLAUDE.md.cchost-backup-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(pdir, backups[0]), 'utf8')).toBe('# work only');
  });

  it('refuses to remove a profile without the typed name', async () => {
    const res = await post('/api/apply', { action: 'remove', profile: 'work' });
    expect(res.json.entry.ok).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, '.claude-profiles', 'work'))).toBe(true);
    const ok = await post('/api/apply', { action: 'remove', profile: 'work', confirm: 'work' });
    expect(ok.json.entry.ok).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.claude-profiles', 'work'))).toBe(false);
  });

  it('adds a private endpoint profile and validates names', async () => {
    const bad = await post('/api/preview', { action: 'add', name: 'bad name' });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/whitespace/);

    const res = await post('/api/apply', {
      action: 'add', name: 'or', private: ['config'],
      endpoint: { base_url: 'https://openrouter.ai/api', auth_token: 'sk-or-1' },
    });
    expect(res.json.entry.ok).toBe(true);
    expect(res.text).not.toContain('sk-or-1');
    const p = res.json.state.profiles.find((x) => x.name === 'or');
    expect(p).toMatchObject({ kind: 'endpoint', endpoint: 'openrouter.ai' });
    expect(p.resources['settings.json']).toBe('private');
    expect(p.resources.skills).toBe('shared');
  });

  it('lists MCP servers with secrets masked, and copies them through preview and apply', async () => {
    const SECRET = 'SENTINEL-mcp-secret-0123456789abc';
    const f = path.join(tmpHome, '.claude-profiles', 'kimi', '.claude.json');
    fs.writeFileSync(f, JSON.stringify({ mcpServers: { db: { command: 'db', args: ['--api-key', SECRET], env: { K: SECRET }, headers: { A: SECRET } } } }));
    const list = await request(port, { path: '/api/mcp', headers: auth() });
    expect(list.status).toBe(200);
    expect(list.text).not.toContain(SECRET);
    const kimi = list.json.targets.find((t) => t.target === 'kimi');
    expect(kimi.servers[0]).toMatchObject({ name: 'db', envKeys: ['K'], headerKeys: ['A'] });
    expect(kimi.servers[0].fp).toMatch(/^[0-9a-f]{12}$/);

    const body = { action: 'mcp-copy', from: 'kimi', to: ['work'], servers: ['db'] };
    const prev = await post('/api/preview', body);
    expect(prev.json.lines[0]).toMatchObject({ kind: 'change', text: 'copy to work' });
    expect(fs.existsSync(path.join(tmpHome, '.claude-profiles', 'work', '.claude.json'))).toBe(false);
    const res = await post('/api/apply', body);
    expect(res.json.entry).toMatchObject({ ok: true, title: 'Copy db · kimi → work' });
    expect(res.text).not.toContain(SECRET);
    const work = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude-profiles', 'work', '.claude.json'), 'utf8'));
    expect(work.mcpServers.db.env.K).toBe(SECRET);

    const backups = await request(port, { path: '/api/backups', headers: auth() });
    expect(backups.json.backups[0].files).toEqual(['~/.claude-profiles/work/.claude.json']);
    const undo = await post('/api/apply', { action: 'restore', id: backups.json.backups[0].id });
    expect(undo.json.entry.ok).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.claude-profiles', 'work', '.claude.json'))).toBe(false);
  });

  it('names the existing account and refuses sharing changes on it', async () => {
    fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } }));
    let st = await request(port, { path: '/api/state', headers: auth() });
    expect(st.json.existing).toMatchObject({ found: true, loggedIn: true, name: null, email: 'm*********.com' });
    const res = await post('/api/apply', { action: 'add', name: 'personal', existing: true });
    expect(res.json.entry.ok).toBe(true);
    const me = res.json.state.profiles.find((p) => p.name === 'personal');
    expect(me).toMatchObject({ alias: true, shared: 7 });
    const link = await post('/api/preview', { action: 'link', profile: 'personal' });
    expect(link.status).toBe(409);
    const rm = await post('/api/apply', { action: 'remove', profile: 'personal', confirm: 'personal' });
    expect(rm.json.entry.ok).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.claude.json'))).toBe(true);
  });

  it('fixes one named doctor issue, and needs confirmation for unsafe fixes', async () => {
    // A missing resource link is a safe fix; a corrupt .claude.json needs --force.
    fs.rmSync(path.join(tmpHome, '.claude-profiles', 'work', 'skills'));
    fs.writeFileSync(path.join(tmpHome, '.claude-profiles', 'work', '.claude.json'), '{nope');

    const one = await post('/api/apply', { action: 'doctor-fix', name: '"work" skills/' });
    expect(one.json.entry).toMatchObject({ ok: true, title: 'Fix "work" skills/' });
    expect(fs.lstatSync(path.join(tmpHome, '.claude-profiles', 'work', 'skills')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(tmpHome, '.claude-profiles', 'work', '.claude.json'), 'utf8')).toBe('{nope');

    const refused = await post('/api/preview', { action: 'doctor-fix', name: '"work" .claude.json' });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toMatch(/needs confirmation/);
    const forced = await post('/api/apply', { action: 'doctor-fix', name: '"work" .claude.json', force: true });
    expect(forced.json.entry.ok).toBe(true);
    expect(fs.readFileSync(path.join(tmpHome, '.claude-profiles', 'work', '.claude.json'), 'utf8')).toBe('{}');
  });
});

describe('cchost ui server — doctor', () => {
  it('runs doctor checks for the current home without blocking', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ui-doc-'));
    const originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
    const server = uiServer.createServer({ user: USER, pass: PASS });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      const login = await request(port, {
        method: 'POST', path: '/api/login', body: { user: USER, pass: PASS },
        headers: { Host: `127.0.0.1:${port}`, 'X-CCHost': '1', 'Content-Type': 'application/json' },
      });
      const headers = { Host: `127.0.0.1:${port}`, 'X-CCHost': '1', Cookie: cookieOf(login) };
      const doctorP = request(port, { path: '/api/doctor', headers });
      // A state request answers while doctor is still running in its child.
      const state = await request(port, { path: '/api/state', headers });
      expect(state.status).toBe(200);
      const doc = await doctorP;
      expect(doc.status).toBe(200);
      expect(doc.json.checks.find((c) => c.name === '~/.claude-profiles/')).toBeTruthy();
    } finally {
      await new Promise((r) => server.close(r));
      os.homedir = originalHomedir;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 60000);
});

describe('randomPassword', () => {
  it('is 16 unambiguous characters in 4 groups', () => {
    const pw = uiServer.randomPassword();
    expect(pw).toMatch(/^[a-zA-Z2-9]{4}(-[a-zA-Z2-9]{4}){3}$/);
    expect(pw).not.toMatch(/[01lIoO]/);
  });
});
