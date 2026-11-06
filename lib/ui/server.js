'use strict';

// `cchost ui` — a local web view over the same actions the CLI runs.
//
// Security model (the page can change real configs and delete profiles):
//   - listens on 127.0.0.1 only;
//   - every request needs the random per-run token (URL query for the page,
//     X-CCHost-Token header for the API), compared in constant time;
//   - the Host header must be 127.0.0.1:<port> or localhost:<port>, which
//     blocks DNS-rebinding pages from reaching the server by name;
//   - POSTs must be application/json and same-origin; no CORS headers are
//     ever sent, so other sites cannot read responses;
//   - responses never contain endpoint tokens; emails are masked.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const actions = require('../actions');

const MAX_BODY = 64 * 1024;
const PAGE_PATH = path.join(__dirname, 'page.html');

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string';
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const GROUP_LABEL = { projects: 'projects', tools: 'tools', config: 'config' };

function titleFor(action, body) {
  const groups = Array.isArray(body.groups) && body.groups.length
    ? body.groups.map((g) => GROUP_LABEL[g] || g).join(' + ')
    : 'all resources';
  switch (action) {
    case 'link': return `Share ${groups} · ${body.profile}`;
    case 'unlink': return `Make ${groups} private · ${body.profile}`;
    case 'copy': return `Copy from ~/.claude${body.force ? ' (overwrite)' : ''} · ${body.profile}`;
    case 'add': return `Add profile · ${body.name}`;
    case 'remove': return `Remove profile · ${body.profile}`;
    case 'doctor-fix': return 'Apply doctor fixes';
    default: return action;
  }
}

function createServer({ token, log = () => {} }) {
  const activity = [];
  let nextId = 1;
  let port = 0;

  function page() {
    const nonce = crypto.randomBytes(16).toString('base64');
    const { version } = require('../../package.json');
    const html = fs.readFileSync(PAGE_PATH, 'utf8')
      .replace(/__NONCE__/g, nonce)
      .replace('__TOKEN__', token)
      .replace('__VERSION__', version);
    return {
      html,
      csp: [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        // Inline style attributes only (stagger index, small layout tweaks);
        // they cannot run code.
        "style-src-attr 'unsafe-inline'",
        "connect-src 'self'",
        "img-src 'self' data:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    };
  }

  async function handle(req, res) {
    const host = req.headers.host || '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return send(res, 403, 'Forbidden host');
    }
    const url = new URL(req.url, `http://${host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      if (!sameToken(url.searchParams.get('t'), token)) {
        return send(res, 403, 'Open the link printed by `cchost ui` (it carries an access token).');
      }
      const { html, csp } = page();
      return send(res, 200, html, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': csp,
        'X-Frame-Options': 'DENY',
      });
    }

    if (!url.pathname.startsWith('/api/')) return send(res, 404, 'Not found');
    if (!sameToken(req.headers['x-cchost-token'], token)) return send(res, 403, { error: 'Bad token' });

    if (req.method === 'GET') {
      if (url.pathname === '/api/state') return send(res, 200, actions.state());
      if (url.pathname === '/api/doctor') return send(res, 200, { checks: actions.doctorChecks() });
      if (url.pathname === '/api/activity') return send(res, 200, { activity });
      return send(res, 404, { error: 'Not found' });
    }

    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return send(res, 403, { error: 'Cross-origin request refused' });
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      return send(res, 415, { error: 'Expected application/json' });
    }

    const body = await readJson(req);
    const fn = actions.ACTIONS[body.action];
    if (!fn) return send(res, 400, { error: `Unknown action "${body.action}"` });

    if (url.pathname === '/api/preview') {
      const lines = await fn(body, { dryRun: true });
      return send(res, 200, { lines });
    }
    if (url.pathname === '/api/apply') {
      let lines;
      let ok = true;
      let error = null;
      try {
        lines = await fn(body, { dryRun: false });
        ok = !lines.some((l) => l.kind === 'error');
      } catch (err) {
        ok = false;
        error = err.message;
        lines = [{ n: null, resource: null, label: null, kind: 'error', text: err.message }];
      }
      const entry = { id: nextId++, at: new Date().toISOString(), action: body.action, title: titleFor(body.action, body), ok, lines };
      activity.unshift(entry);
      if (activity.length > 200) activity.length = 200;
      log(`${ok ? '✓' : '✗'} ${entry.title}`);
      if (error && !lines.length) return send(res, 400, { error });
      return send(res, 200, { entry, state: actions.state() });
    }
    return send(res, 404, { error: 'Not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err.status || (err.exitCode ? 400 : 500);
      send(res, status, { error: err.message || String(err) });
    });
  });

  server.on('listening', () => { port = server.address().port; });
  return server;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* the URL is printed anyway */ }
}

function startUi({ port = 0, open = true } = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  const server = createServer({ token, log: (m) => process.stdout.write(`  ${m}\n`) });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/?t=${token}`;
      process.stdout.write(`cchost ui running at ${url}\n`);
      process.stdout.write('Only this machine can reach it. Press Ctrl+C to stop.\n');
      if (open) openBrowser(url);
      resolve({ server, url, token });
    });
  });
}

module.exports = { createServer, startUi, sameToken };
