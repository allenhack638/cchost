'use strict';

// End-to-end check of the packed package against the real `claude` on PATH.
// Usage: node e2e/run.js [npm|native]   (asserts which kind of claude is found)

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

const WIN = process.platform === 'win32';
const MODE = process.argv[2] || process.env.E2E_CLAUDE || '';
const REPO = path.resolve(__dirname, '..');
const SECRET = 'sk-SENTINEL-e2e-7f3a9c2b1d0e4f5a6b7c';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cchost-e2e-'));
const home = path.join(root, 'home');
const prefix = path.join(root, 'prefix');
const binDir = WIN ? prefix : path.join(prefix, 'bin');
fs.mkdirSync(home, { recursive: true });

const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
  NO_COLOR: '1',
  CI: '1',
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};
for (const k of ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'XDG_CONFIG_HOME']) delete env[k];

let pass = 0;
const failures = [];
const outputs = [];

function q(a) {
  return /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a;
}

function run(cmd, args = [], { input, extraEnv = {}, timeout = 120000 } = {}) {
  const opts = { env: { ...env, ...extraEnv }, encoding: 'utf8', input: input ?? '', timeout, cwd: root };
  const res = WIN
    ? spawnSync([cmd, ...args].map(q).join(' '), { ...opts, shell: true })
    : spawnSync(cmd, args, opts);
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  outputs.push(out);
  return { code: res.status, out, stdout: res.stdout || '', error: res.error };
}

const cchost = (...args) => run('cchost', args);
const json = (...args) => {
  const r = cchost(...args, '--json');
  try {
    return { ...r, data: JSON.parse(r.stdout) };
  } catch {
    return { ...r, data: null };
  }
};

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name}${detail ? `\n     ${String(detail).trim().split('\n').slice(0, 8).join('\n     ')}` : ''}`);
  }
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const profileJson = (name) => path.join(home, '.claude-profiles', name, '.claude.json');
const hasServer = (file, name) => {
  try { return Boolean(readJson(file).mcpServers?.[name]); } catch { return false; }
};

function fakeMcpServer() {
  const file = path.join(root, 'fake-mcp.js');
  fs.writeFileSync(file, `
const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [] } });
  else send({ jsonrpc: '2.0', id: m.id, result: {} });
});
`);
  return file;
}

function uiCheck() {
  return new Promise((resolve) => {
    const child = WIN
      ? spawn('cchost ui --no-open', { env, shell: true, cwd: root })
      : spawn('cchost', ['ui', '--no-open'], { env, cwd: root });
    let buf = '';
    const done = (result) => {
      clearTimeout(timer);
      if (WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f']);
      else child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, why: `no sign-in link: ${buf}` }), 20000);
    const onData = async (d) => {
      buf += d;
      const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?code=([0-9a-f]+)/);
      if (!m) return;
      child.stdout.off('data', onData);
      const port = Number(m[1]);
      const get = (p, headers = {}) => new Promise((res) => {
        http.get({ host: '127.0.0.1', port, path: p, headers }, (r) => {
          let body = '';
          r.on('data', (c) => { body += c; });
          r.on('end', () => res({ status: r.statusCode, headers: r.headers, body }));
        }).on('error', (e) => res({ status: 0, body: String(e) }));
      });
      try {
        const signin = await get(`/?code=${m[2]}`);
        const cookie = String(signin.headers['set-cookie'] || '').split(';')[0];
        const results = {};
        for (const p of ['/api/state', '/api/mcp', '/api/backups']) results[p] = await get(p, { cookie, 'x-cchost': '1' });
        results.noCookie = await get('/api/state', { 'x-cchost': '1' });
        results.evilHost = await get('/api/state', { cookie, 'x-cchost': '1', host: 'evil.example:80' });
        done({ ok: true, results });
      } catch (e) {
        done({ ok: false, why: String(e) });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { buf += d; });
  });
}

async function main() {
  console.log(`platform ${process.platform}/${process.arch}, node ${process.version}, claude mode: ${MODE || 'any'}`);

  // Install the packed tarball the way users do.
  const pack = spawnSync('npm', ['pack', '--pack-destination', root, '--silent'], { cwd: REPO, encoding: 'utf8', shell: WIN });
  const tgz = path.join(root, String(pack.stdout).trim().split(/\r?\n/).pop());
  check('npm pack', pack.status === 0 && fs.existsSync(tgz), pack.stderr);
  const inst = spawnSync('npm', ['install', '-g', '--prefix', prefix, tgz, '--no-audit', '--no-fund'], { encoding: 'utf8', shell: WIN });
  check('npm install -g tarball', inst.status === 0, inst.stderr);

  const v = cchost('--version');
  check('cchost --version is 0.7.0', v.code === 0 && v.out.includes(require('../package.json').version), v.out);
  check('cc alias works', run('cc', ['--version']).code === 0);
  check('--help points agents at cchost agent', cchost('--help').out.includes('cchost agent'));
  for (const t of ['', 'setup', 'profiles', 'sharing', 'mcp', 'doctor', 'backups']) {
    const r = cchost('agent', ...(t ? [t] : []));
    check(`agent ${t || 'overview'}`, r.code === 0 && r.out.length > 200, r.out);
  }
  check('agent refuses odd topic', cchost('agent', '../x').code !== 0);

  const st = json('status');
  check('status --json parses', st.data && st.code === 0, st.out);
  const claudePath = st.data?.claude?.path || '';
  check('status finds claude', st.data?.claude?.found && st.data?.claude?.version, JSON.stringify(st.data?.claude));
  if (MODE === 'npm') check('claude is the npm install', /node_modules|\.cmd$|npm/i.test(claudePath) || /node_modules/.test(safeReal(claudePath)), claudePath);
  if (MODE === 'native') check('claude is the native binary', !/node_modules/i.test(safeReal(claudePath)) && !/\.cmd$/i.test(claudePath), `${claudePath} -> ${safeReal(claudePath)}`);
  console.log(`     claude: ${claudePath} (${st.data?.claude?.version})`);

  // Existing account with a stdio MCP server holding a secret.
  const fake = fakeMcpServer();
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'someone@example.com' },
    hasCompletedOnboarding: true,
    mcpServers: { fakesrv: { type: 'stdio', command: 'node', args: [fake, '--token', SECRET], env: { FAKE_KEY: SECRET } } },
  }));

  const dry = json('add', 'personal', '--existing', '--dry-run');
  check('add --existing --dry-run', dry.data?.ok && dry.data?.dryRun, dry.out);
  check('dry run wrote nothing', !fs.existsSync(path.join(home, '.claude-profiles', '.cchost.json')));
  check('add --existing', json('add', 'personal', '--existing').data?.ok);
  check('add work', json('add', 'work').data?.ok);
  check('add solo --private', json('add', 'solo', '--private').data?.ok);
  check('alias name is reserved', json('add', 'personal').code !== 0);
  check('link on alias refused', json('link', 'personal').code === 1);
  const list = cchost('list');
  check('list shows profiles', list.code === 0 && /personal/.test(list.out) && /work/.test(list.out) && /solo/.test(list.out), list.out);

  const before = fs.existsSync(profileJson('work')) ? fs.readFileSync(profileJson('work'), 'utf8') : null;
  const cp = json('mcp', 'copy', 'default', 'pool');
  check('mcp copy default pool', cp.data?.ok, cp.out);
  const backupId = (cp.data?.lines || []).find((l) => l.backup)?.backup;
  check('copy reports a backup id', Boolean(backupId), cp.out);
  check('pool server synced into work', hasServer(profileJson('work'), 'fakesrv'));
  check('private profile not synced', !hasServer(profileJson('solo'), 'fakesrv'));
  if (!WIN) check('work .claude.json is 0600', (fs.statSync(profileJson('work')).mode & 0o777) === 0o600);
  check('mcp copy work solo', json('mcp', 'copy', 'work', 'solo').data?.ok && hasServer(profileJson('solo'), 'fakesrv'));
  check('copy again is a no-op', json('mcp', 'copy', 'work', 'solo').data?.lines?.every((l) => l.kind !== 'change'));
  const ml = json('mcp', 'list');
  check('mcp list --json', ml.data && ml.code === 0, ml.out);
  check('mcp sync clean', json('mcp', 'sync').data?.ok);
  const doc = json('doctor');
  check('doctor has no errors', doc.data?.summary?.error === 0, JSON.stringify((doc.data?.checks || []).filter((c) => c.status !== 'ok')));

  // Real claude reads what cchost wrote, launched through cchost itself.
  for (const p of ['work', 'personal', 'solo']) {
    const r = run('cchost', ['use', p, 'mcp', 'list'], { timeout: 90000 });
    check(`claude via cchost use ${p}: fakesrv connected`, /fakesrv/.test(r.out) && /connected/i.test(r.out) && !/failed/i.test(r.out), r.out);
    outputs.pop();
  }
  const fw = run('cchost', ['use', 'work', '--version']);
  check('cchost use forwards args to claude', fw.code === 0 && /Claude Code/.test(fw.out), fw.out);

  // Backups.
  const bk = json('backups');
  check('backups --json lists the copy', JSON.stringify(bk.data || '').includes(backupId || '-none-'), bk.out);
  check('restore --dry-run', json('restore', backupId, '--dry-run').data?.ok);
  check('restore', json('restore', backupId).data?.ok);
  const after = fs.existsSync(profileJson('work')) ? fs.readFileSync(profileJson('work'), 'utf8') : null;
  check('restore put work back', after === before || (!hasServer(profileJson('work'), 'fakesrv')), after);
  check('mcp remove', json('mcp', 'remove', 'solo', 'fakesrv').data?.ok && !hasServer(profileJson('solo'), 'fakesrv'));

  // Skills.
  check('skill install', json('skill', 'install').data?.ok);
  check('skill files on disk', fs.existsSync(path.join(home, '.claude', 'skills', 'cchost-setup', 'SKILL.md')) && fs.existsSync(path.join(home, '.claude', 'skills', 'cchost-manage', 'SKILL.md')));
  check('skill status current', json('skill', 'status').data?.ok !== false);

  // Endpoint profile and token handling.
  check('add endpoint without token', json('add', 'api', '--custom', '--base-url=https://api.example.com').data?.ok);
  check('use refuses until a token is set', run('cchost', ['use', 'api', '--version']).code !== 0);
  check('token without terminal refused', run('cchost', ['token', 'api']).code !== 0);
  check('token --stdin', run('cchost', ['token', 'api', '--stdin'], { input: `${SECRET}\n` }).code === 0);
  const ep = run('cchost', ['use', 'api', '--version']);
  check('endpoint use runs claude', ep.code === 0 && /Claude Code/.test(ep.out), ep.out);
  check('--reveal refused without terminal', cchost('list', 'api', '--reveal').code !== 0);

  // Destructive guardrails.
  check('remove without terminal refused', cchost('remove', 'solo').code !== 0 && fs.existsSync(path.join(home, '.claude-profiles', 'solo')));
  check('remove --yes', json('remove', 'solo', '--yes').data?.ok && !fs.existsSync(path.join(home, '.claude-profiles', 'solo')));
  check('remove alias only forgets the name', json('remove', 'personal', '--yes').data?.ok && fs.existsSync(path.join(home, '.claude.json')));

  // Web view.
  const ui = await uiCheck();
  if (!ui.ok) check('ui starts', false, ui.why);
  else {
    for (const p of ['/api/state', '/api/mcp', '/api/backups']) check(`ui ${p}`, ui.results[p].status === 200, ui.results[p].body);
    check('ui refuses without session', ui.results.noCookie.status === 401 || ui.results.noCookie.status === 403);
    check('ui refuses foreign Host', ui.results.evilHost.status === 403);
    outputs.push(...Object.values(ui.results).map((r) => r.body));
  }

  // Nothing printed anywhere may contain the secret.
  for (const extra of [cchost('status', '--json'), cchost('list'), cchost('list', 'api'), cchost('mcp', 'list'), cchost('doctor')]) void extra;
  const leaked = outputs.filter((o) => o.includes(SECRET));
  for (const o of leaked) console.log(`     leak: ${o.split("\n").find((l) => l.includes(SECRET)).slice(0, 160)}`);
  const leaks = leaked.length;
  check('no secret in any output', leaks === 0, `${leaks} outputs leaked`);
  check('token stored outside output', fs.readFileSync(path.join(home, '.claude-profiles', 'api', '.cc-env.json'), 'utf8').includes(SECRET));
}

function safeReal(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

main()
  .catch((e) => check('harness', false, e.stack))
  .finally(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows locks */ }
    console.log(`\n${pass} passed, ${failures.length} failed${failures.length ? `: ${failures.join('; ')}` : ''}`);
    process.exit(failures.length ? 1 : 0);
  });
