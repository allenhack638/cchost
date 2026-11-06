import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import uiServer from '../lib/ui/server.js';
import cli from '../lib/cli.js';

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

describe('cchost ui server', () => {
  let tmpHome;
  let originalHomedir;
  let originalLog;
  let server;
  let port;
  const token = 'a'.repeat(48);

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ui-'));
    originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
    originalLog = console.log;
    console.log = () => {};
    await cli.run(['add', 'work']);
    await cli.run(['add', 'kimi', '--custom', '--base-url=https://api.moonshot.ai/anthropic', '--token=sk-secret-token-123']);
    server = uiServer.createServer({ token });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    os.homedir = originalHomedir;
    console.log = originalLog;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const host = () => ({ Host: `127.0.0.1:${port}` });
  const auth = () => ({ ...host(), 'X-CCHost-Token': token });
  const post = (p, body, extra = {}) => request(port, {
    method: 'POST', path: p, body, headers: { ...auth(), 'Content-Type': 'application/json', ...extra },
  });

  it('serves the page only with the token, with a strict CSP', async () => {
    expect((await request(port, { headers: host() })).status).toBe(403);
    const res = await request(port, { path: `/?t=${token}`, headers: host() });
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(res.headers['content-security-policy']).toMatch(/script-src 'nonce-/);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.text).not.toContain('__NONCE__');
  });

  it('rejects other Host headers (DNS rebinding)', async () => {
    const res = await request(port, { path: `/?t=${token}`, headers: { Host: `evil.example:${port}` } });
    expect(res.status).toBe(403);
  });

  it('requires the token on the API', async () => {
    expect((await request(port, { path: '/api/state', headers: host() })).status).toBe(403);
    expect((await request(port, { path: '/api/state', headers: { ...host(), 'X-CCHost-Token': 'b'.repeat(48) } })).status).toBe(403);
  });

  it('refuses cross-origin and non-JSON POSTs', async () => {
    const body = { action: 'remove', profile: 'work', confirm: 'work' };
    expect((await post('/api/apply', body, { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await post('/api/apply', body, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect(fs.existsSync(path.join(tmpHome, '.claude-profiles', 'work'))).toBe(true);
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
});
