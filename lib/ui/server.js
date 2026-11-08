'use strict';

// `cchost ui` — a local web view over the same actions the CLI runs.
//
// Security model (the page can change real configs and delete profiles):
//   - listens on 127.0.0.1 only;
//   - sign-in like `rclone rcd --rc-web-gui`: a username and a per-run random
//     password are printed in the terminal, and the browser is opened with a
//     one-time sign-in link (single use, expires in 2 minutes). Either way
//     the browser gets an HttpOnly, SameSite=Strict session cookie that
//     expires (default 8h) and dies with the process;
//   - password attempts are rate-limited; comparisons are constant-time;
//   - the Host header must be 127.0.0.1:<port> or localhost:<port>, which
//     blocks DNS-rebinding pages from reaching the server by name;
//   - every API call needs the X-CCHost header (a cross-site page cannot send
//     it without a CORS preflight, which is never granted); POSTs must be
//     application/json and same-origin; no CORS headers are ever sent;
//   - responses never contain endpoint tokens; emails are masked.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn, execFile } = require('child_process');

const actions = require('../actions');

const MAX_BODY = 64 * 1024;
const PAGE_PATH = path.join(__dirname, 'page.html');
const LOGIN_PATH = path.join(__dirname, 'login.html');
const TOKENS_PATH = path.join(__dirname, 'tokens.css');
const COOKIE = 'cchost_session';
const CODE_TTL_MS = 2 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60 * 1000;

// Doctor's checks are synchronous and spawn `claude --version`, which would
// block every other request for a second or more. Run them in a child Node
// process (same HOME) so previews and applies stay responsive.
function doctorInChild() {
  const actionsPath = path.join(__dirname, '..', 'actions.js');
  const script = `process.stdout.write(JSON.stringify(require(${JSON.stringify(actionsPath)}).doctorChecks()))`;
  const home = os.homedir();
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', script], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60000,
    }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Readable random password, e.g. "k7Qp-3mZx-Wb9t-Lr2v".
function randomPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    if (i && i % 4 === 0) out += '-';
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
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
    case 'link': return `Share ${groups}${body.backup ? ' (with backup)' : ''} · ${body.profile}`;
    case 'unlink': return `Make ${groups} private · ${body.profile}`;
    case 'copy': return `Copy from ~/.claude${body.force ? ' (overwrite)' : ''} · ${body.profile}`;
    case 'add': return `Add profile · ${body.name}`;
    case 'remove': return `Remove profile · ${body.profile}`;
    case 'doctor-fix': return body.name ? `Fix ${body.name}` : 'Apply doctor fixes';
    default: return action;
  }
}

function createServer({ user, pass, sessionTtlMs = 8 * 60 * 60 * 1000, log = () => {} }) {
  if (!user || !pass) throw new Error('createServer needs a user and pass');
  const activity = [];
  const sessions = new Map(); // id -> { user, expires }
  const codes = new Map(); // one-time sign-in code -> expires
  let failures = [];
  let lockedUntil = 0;
  let nextId = 1;
  let port = 0;

  function newSession() {
    const id = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + sessionTtlMs;
    sessions.set(id, { user, expires });
    const cookie = `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionTtlMs / 1000)}`;
    return { cookie, expires };
  }
  function sessionOf(req) {
    const id = parseCookies(req.headers.cookie)[COOKIE];
    if (!id) return null;
    const s = sessions.get(id);
    if (!s) return null;
    if (s.expires <= Date.now()) {
      sessions.delete(id);
      return null;
    }
    return { id, ...s };
  }
  function issueCode() {
    const code = crypto.randomBytes(24).toString('hex');
    codes.set(code, Date.now() + CODE_TTL_MS);
    return code;
  }
  function takeCode(code) {
    if (typeof code !== 'string') return false;
    for (const [c, exp] of codes) {
      if (exp <= Date.now()) codes.delete(c);
      else if (sameToken(c, code)) {
        codes.delete(c);
        return true;
      }
    }
    return false;
  }

  function render(file) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const { version } = require('../../package.json');
    const html = fs.readFileSync(file, 'utf8')
      .replace('/*__TOKENS__*/', fs.readFileSync(TOKENS_PATH, 'utf8'))
      .replace(/__NONCE__/g, nonce)
      .replace(/__VERSION__/g, version);
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
    let url;
    try {
      url = new URL(req.url, `http://${host}`);
    } catch {
      return send(res, 404, { error: 'Not found' });
    }
    if (req.url.startsWith('//')) return send(res, 404, { error: 'Not found' });

    const htmlHeaders = (csp) => ({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp,
      'X-Frame-Options': 'DENY',
    });

    if (req.method === 'GET' && url.pathname === '/') {
      // One-time sign-in link from the terminal: trade it for a session and
      // drop the code from the address bar.
      if (url.searchParams.has('code')) {
        if (takeCode(url.searchParams.get('code'))) {
          const { cookie } = newSession();
          log('signed in with the one-time link');
          return send(res, 303, '', { Location: '/', 'Set-Cookie': cookie });
        }
        return send(res, 303, '', { Location: '/?expired=1' });
      }
      const { html, csp } = render(sessionOf(req) ? PAGE_PATH : LOGIN_PATH);
      return send(res, 200, html, htmlHeaders(csp));
    }

    if (!url.pathname.startsWith('/api/')) return send(res, 404, 'Not found');
    // A custom header forces a CORS preflight for any cross-site caller, and
    // preflights are never answered, so only this page can call the API.
    if (req.headers['x-cchost'] !== '1') return send(res, 403, { error: 'Missing X-CCHost header' });

    if (req.method === 'POST' && (url.pathname === '/api/login' || url.pathname === '/api/logout')) {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}`) return send(res, 403, { error: 'Cross-origin request refused' });
      if (url.pathname === '/api/logout') {
        const s = sessionOf(req);
        if (s) sessions.delete(s.id);
        return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
      }
      if (Date.now() < lockedUntil) {
        const wait = Math.ceil((lockedUntil - Date.now()) / 1000);
        return send(res, 429, { error: `Too many attempts. Try again in ${wait}s.` });
      }
      const body = await readJson(req);
      const okUser = sameToken(String(body.user || ''), user);
      const okPass = sameToken(String(body.pass || ''), pass);
      if (!(okUser && okPass)) {
        const now = Date.now();
        failures = failures.filter((t) => now - t < LOCKOUT_MS);
        failures.push(now);
        if (failures.length >= MAX_FAILURES) {
          lockedUntil = now + LOCKOUT_MS;
          failures = [];
          log('too many failed sign-ins; locked for 60s');
        }
        return send(res, 401, { error: 'Wrong username or password.' });
      }
      failures = [];
      const { cookie, expires } = newSession();
      log('signed in with username and password');
      return send(res, 200, { ok: true, expires: new Date(expires).toISOString() }, { 'Set-Cookie': cookie });
    }

    const session = sessionOf(req);
    if (!session) return send(res, 401, { error: 'Signed out. Sign in again.' });
    if (req.method === 'GET' && url.pathname === '/api/session') {
      return send(res, 200, { user: session.user, expires: new Date(session.expires).toISOString() });
    }

    if (req.method === 'GET') {
      if (url.pathname === '/api/state') return send(res, 200, actions.state());
      if (url.pathname === '/api/doctor') return send(res, 200, { checks: await doctorInChild() });
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
  server.issueCode = issueCode;
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

function formatTtl(ms) {
  const m = Math.round(ms / 60000);
  if (m % (60 * 24) === 0) return `${m / 60 / 24}d`;
  if (m % 60 === 0) return `${m / 60}h`;
  return `${m}m`;
}

function startUi({ port = 0, open = true, user = 'cchost', pass = null, sessionTtlMs } = {}) {
  require('../update').checkInBackground();
  const password = pass || randomPassword();
  const server = createServer({ user, pass: password, sessionTtlMs, log: (m) => process.stdout.write(`  ${m}\n`) });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}/`;
      const link = `${base}?code=${server.issueCode()}`;
      const ttl = formatTtl(sessionTtlMs || 8 * 60 * 60 * 1000);
      process.stdout.write(`cchost ui running at ${base}\n\n`);
      process.stdout.write(`  Username:  ${user}\n`);
      process.stdout.write(`  Password:  ${pass ? '(the one you passed with --pass)' : password}\n`);
      process.stdout.write(`  Sessions last ${ttl}. The password is new every run.\n\n`);
      if (open) {
        openBrowser(link);
        process.stdout.write('Opened your browser with a one-time sign-in link (valid 2 minutes).\n');
      } else {
        process.stdout.write(`One-time sign-in link (valid 2 minutes):\n  ${link}\n`);
      }
      process.stdout.write('Only this machine can reach it. Press Ctrl+C to stop.\n');
      resolve({ server, url: base, link, user, password });
    });
  });
}

module.exports = { createServer, startUi, sameToken, randomPassword };
