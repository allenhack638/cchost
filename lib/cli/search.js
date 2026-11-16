'use strict';

// Folder pins and cross-account search: pin, which, find, open, index.

const fs = require('fs');

const profiles = require('../profiles');
const pinsLib = require('../pins');
const findLib = require('../find');
const color = require('../color');
const errors = require('../errors');
const paths = require('../paths');
const { launch } = require('./launch');
const { parseArgs, runAction, interactive, choose } = require('./term');

const PIN_USAGE = `Usage:
  cchost pin <profile> [--path=DIR] [--dry-run] [--json]
  cchost unpin [--path=DIR] [--dry-run] [--json]
  cchost pins [--json]
  cchost which [--json]
  cchost go [...claude args]`;

async function cmdPin(rest) {
  const { flags, values, positional } = parseArgs(rest, { flags: ['--dry-run', '--json'], values: ['--path'] });
  const [profile, ...extra] = positional;
  if (!profile || extra.length) throw errors.usage(PIN_USAGE);
  return runAction('pin', { profile, dir: values['--path'] }, { dryRun: flags.has('--dry-run'), json: flags.has('--json') });
}

async function cmdUnpin(rest) {
  const { flags, values, positional } = parseArgs(rest, { flags: ['--dry-run', '--json'], values: ['--path'] });
  if (positional.length) throw errors.usage(PIN_USAGE);
  return runAction('unpin', { dir: values['--path'] }, { dryRun: flags.has('--dry-run'), json: flags.has('--json') });
}

async function cmdPins(rest) {
  const { flags } = parseArgs(rest, { flags: ['--json'] });
  const list = pinsLib.list();
  if (flags.has('--json')) {
    process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
    return 0;
  }
  if (!list.length) {
    process.stdout.write('No pinned folders. Pin one with: cchost pin <profile>   (run it inside the folder)\n');
    return 0;
  }
  const width = Math.max(...list.map((p) => paths.shortPath(p.dir).length));
  for (const p of list) {
    const note = !p.exists ? color.stdout.yellow('  folder missing') : !p.profileExists ? color.stdout.yellow('  profile missing') : '';
    process.stdout.write(`${paths.shortPath(p.dir).padEnd(width)}  ${p.profile}${note}\n`);
  }
  return 0;
}

function whichInfo(cwd = process.cwd()) {
  const hit = pinsLib.resolve(cwd);
  let scope = null;
  let scopeError = null;
  try {
    scope = pinsLib.scope(cwd);
  } catch (err) {
    scopeError = err.message;
  }
  const alias = profiles.getAlias();
  let launch = null;
  let reason;
  if (hit && hit.kind === 'pin') {
    launch = hit.profile;
    reason = `pinned at ${paths.shortPath(hit.dir)}`;
  } else if (hit && hit.profile) {
    reason = `${pinsLib.FILE} in ${paths.shortPath(hit.dir)} suggests ${hit.profile}; \`cchost go\` asks once before using it`;
  } else if (hit) {
    reason = hit.error;
  } else if (alias) {
    launch = alias;
    reason = `no pin here; the existing account "${alias}" is the default`;
  } else {
    reason = 'no pin here and no default; run `cchost pin <profile>` or `cchost use <profile>`';
  }
  return {
    cwd,
    launch,
    reason,
    pin: hit ? { kind: hit.kind, dir: hit.dir, profile: hit.profile, confirmed: hit.confirmed } : null,
    scope: scope ? { ...scope, short: paths.shortPath(scope.root) } : null,
    scopeError,
  };
}

async function cmdWhich(rest) {
  const { flags } = parseArgs(rest, { flags: ['--json'] });
  const w = whichInfo();
  if (flags.has('--json')) {
    process.stdout.write(`${JSON.stringify(w, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`cchost go here runs: ${w.launch ? color.stdout.bold(w.launch) : color.stdout.yellow('nothing')}  (${w.reason})\n`);
  if (w.scope) {
    const who = w.scope.profiles === null ? 'every account' : w.scope.profiles.length ? `account ${w.scope.profiles.join(', ')}` : 'no account';
    process.stdout.write(`cchost find here sees: ${w.scope.short} and subfolders, ${who}\n`);
  } else {
    process.stdout.write(`cchost find here sees: ${color.stdout.yellow('nothing')} — ${w.scopeError}\n`);
  }
  return 0;
}

// --- find / index ----------------------------------------------------------------

const FIND_USAGE = `Usage:
  cchost find <words...> [--since=30d] [-n=20] [--json]
  cchost find <words...> [--profile=NAME[,NAME...]] [--global] [--project=PATH]   (--global: terminal only)
  cchost open [<session-id-prefix>] [--fork] [--global] [--profile=NAME] [--cwd=PATH]
  cchost index [--global] [--json]`;

function globalAllowed() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// The scope a find/open/index call runs in. --global is the only way out of
// the folder's scope, and it needs a person at a terminal.
function scopeFromFlags(flags, values, what) {
  if (flags.has('--global')) {
    if (!globalAllowed()) {
      throw errors.usage(`--global shows every account's conversations and only works in a terminal. Ask the user to run \`cchost ${what} --global\` themselves.`);
    }
    return { root: null, profiles: null, source: 'global', confirmed: true };
  }
  return pinsLib.scope();
}

function ago(iso) {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 14 * 86400) return `${Math.round(s / 86400)}d ago`;
  if (s < 60 * 86400) return `${Math.round(s / 604800)}w ago`;
  return String(iso).slice(0, 10);
}

function highlight(text, terms) {
  if (!terms.length) return text;
  const re = new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  return text.replace(re, (m) => color.stdout.mark(m));
}

function clip(text, width) {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

function printFind(res, scope) {
  const w = (t = '') => process.stdout.write(`${t}\n`);
  const width = Math.max(60, Math.min(process.stdout.columns || 100, 120)) - 4;
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const more = res.total > res.results.length ? color.stdout.dim(`  (top ${res.results.length}; more with -n=${res.total})`) : '';
  w(`${color.stdout.bold(n(res.total, 'match', 'matches'))} ${color.stdout.dim(`in ${n(res.sessions, 'conversation', 'conversations')} · ${res.scope.text}`)}${more}`);
  if (!res.total) {
    w(color.stdout.dim('  Every word must appear in the same message. Try fewer or different words.'));
    if (scope.source !== 'global' && globalAllowed()) w(color.stdout.dim('  Search every folder and account: add --global'));
    return;
  }
  for (const r of res.results) {
    const who = r.accounts.length ? r.accounts.join(', ') : 'unknown account';
    const where = `${r.short || ''}${r.branch ? ` (${r.branch})` : ''}`;
    w();
    w(`  ${color.stdout.bold(color.stdout.cyan(r.id.slice(0, 8)))}  ${who} ${color.stdout.dim(`· ${ago(r.lastSeen)} · ${where}`)}`);
    if (r.title && !r.snippet.startsWith(r.title.replace(/…$/, ''))) w(`  ${color.stdout.bold(clip(r.title, width))}`);
    w(`  ${color.stdout.dim(r.where === 'prompt' ? 'you   ' : 'claude')} ${highlight(clip(r.snippet, width - 7), res.query)}`);
  }
  w();
  w(`${color.stdout.dim('→ resume:')} ${color.stdout.bold(`cchost open ${res.results[0].id.slice(0, 8)}`)}${color.stdout.dim('   (or any id above; add --fork to branch off)')}`);
}

async function cmdFind(rest) {
  const { flags, values, positional } = parseArgs(rest, { flags: ['--json', '--global'], values: ['--since', '-n', '--profile', '--project'] });
  if (!positional.length) throw errors.usage(FIND_USAGE);
  const json = flags.has('--json');
  const limit = values['-n'] ? Number(values['-n']) : 20;
  if (!Number.isInteger(limit) || limit < 1) throw errors.usage('-n wants a positive number');
  let scope;
  try {
    scope = scopeFromFlags(flags, values, 'find');
  } catch (err) {
    if (json && err.exitCode !== 2) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
      return 1;
    }
    throw err;
  }
  await findLib.refresh(scope);
  let res;
  try {
    res = findLib.search(scope, positional.join(' '), { profile: values['--profile'], project: values['--project'], since: values['--since'], limit });
  } catch (err) {
    if (json && err.exitCode !== 2) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
      return 1;
    }
    throw Object.assign(err, { exitCode: err.exitCode || 1 });
  }
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...res }, null, 2)}\n`);
    return 0;
  }
  printFind(res, scope);
  return 0;
}

function recentLabel(r) {
  const who = r.accounts.length ? r.accounts.join(', ') : 'unknown account';
  const width = Math.max(50, Math.min(process.stdout.columns || 100, 120)) - 12;
  return `${color.stdout.cyan(r.id.slice(0, 8))}  ${clip(r.title || r.last, width - 10)}\n        ${color.stdout.dim(`${who} · ${ago(r.lastSeen)} · ${r.short || ''}${r.branch ? ` (${r.branch})` : ''}`)}`;
}

function printRecent(res) {
  process.stdout.write(`${color.stdout.bold('Recent conversations')} ${color.stdout.dim(`· ${res.scope.text}`)}\n`);
  for (const r of res.results) process.stdout.write(`  ${recentLabel(r)}\n`);
  process.stdout.write(`${color.stdout.dim('→ resume one:')} ${color.stdout.bold(`cchost open ${res.results[0].id.slice(0, 8)}`)}\n`);
}

async function cmdIndex(rest) {
  const { flags } = parseArgs(rest, { flags: ['--json', '--global'] });
  const scope = scopeFromFlags(flags, {}, 'index');
  const stats = await findLib.refresh(scope, { prune: scope.source === 'global' });
  const summary = findLib.indexSummary();
  if (flags.has('--json')) {
    process.stdout.write(`${JSON.stringify({ ok: true, scope: { root: scope.root, profiles: scope.profiles, source: scope.source }, ...stats, index: summary }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`indexed ${stats.indexed}, unchanged ${stats.unchanged}, outside scope ${stats.skipped}${stats.pruned ? `, pruned ${stats.pruned}` : ''}\n`);
  for (const i of summary) {
    if (i.sessions) process.stdout.write(`  ${i.account.padEnd(16)} ${String(i.sessions).padStart(5)} sessions  ${(i.bytes / 1e6).toFixed(1)} MB  ${i.dir}\n`);
  }
  return 0;
}

// --- token ---------------------------------------------------------------------

// `cchost open <id>`: resume a session found with `find`, in its own folder,
// under the account that used it. Only sessions inside the scope resolve.
async function cmdOpen(rest) {
  const { flags, values, positional } = parseArgs(rest, { flags: ['--fork', '--global'], values: ['--profile', '--cwd'] });
  let [prefix, ...extra] = positional;
  if (extra.length) throw errors.usage(FIND_USAGE);
  const scope = scopeFromFlags(flags, {}, 'open');
  await findLib.refresh(scope);
  if (!prefix) {
    const recent = findLib.recent(scope, { profile: values['--profile'], limit: 10 });
    if (!recent.results.length) {
      console.log(`No conversations yet in ${recent.scope.text}.`);
      return 0;
    }
    if (!interactive()) {
      printRecent(recent);
      return 0;
    }
    process.stdout.write(`${color.stdout.bold('Recent conversations')} ${color.stdout.dim(`· ${recent.scope.text}`)}\n`);
    const i = await choose('Resume', recent.results.map(recentLabel), { defaultIndex: 0 });
    if (i < 0) {
      console.log('Cancelled.');
      return 1;
    }
    prefix = recent.results[i].id;
  }
  let target;
  try {
    target = findLib.resolveOpen(scope, prefix, { profile: values['--profile'] });
  } catch (err) {
    throw Object.assign(err, { exitCode: err.exitCode || 1 });
  }
  let cwd = values['--cwd'] ? paths.realpath(values['--cwd']) : target.cwd;
  if (!cwd || !fs.existsSync(cwd)) {
    throw errors.refused(`The session's folder ${target.cwd ? paths.shortPath(target.cwd) : ''} no longer exists. Resume it elsewhere: cchost open ${prefix} --cwd=PATH`);
  }
  if (scope.root && !paths.isUnderReal(cwd, scope.root)) {
    throw errors.refused(`${paths.shortPath(cwd)} is outside this folder's scope. Add --global.`);
  }
  process.stderr.write(`[cchost] resuming ${target.id.slice(0, 8)}${target.title ? ` "${target.title.slice(0, 60)}"` : ''} in ${paths.shortPath(cwd)} as '${target.account}'\n`);
  return launch(target.account, ['--resume', target.id, ...(flags.has('--fork') ? ['--fork-session'] : [])], { cwd });
}

module.exports = { cmdPin, cmdUnpin, cmdPins, cmdWhich, cmdFind, cmdIndex, cmdOpen };
