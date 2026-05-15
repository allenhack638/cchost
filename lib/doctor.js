'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const profiles = require('./profiles');
const { findClaude, getClaudeVersion, compareVersion, MIN_VERSION } = require('./spawn');
const color = require('./color');

const GROUP_ORDER = ['Environment', 'Storage', 'Platform', 'Sanity'];

// fix: { safe, description, cmd, apply }
//   safe=true  → auto-applied by --fix
//   safe=false → needs --fix --force, prompted y/n
//   cmd        → printed when fix cannot be auto-applied
//   apply      → async fn to execute

function mk(group, name, status, message, fix) {
  return { group, name, status, message, fix: fix || null };
}

// --- Environment ---

function checkNodeVersion() {
  const v = `v${process.versions.node}`;
  if (parseInt(process.versions.node.split('.')[0], 10) >= 18) {
    return mk('Environment', 'Node.js version', 'ok', `${v} (>=18)`);
  }
  return mk('Environment', 'Node.js version', 'error', `${v} — requires >=18`, {
    safe: false, description: 'Install Node.js 18+', cmd: 'https://nodejs.org', apply: null,
  });
}

function checkClaudeOnPath() {
  const bin = findClaude();
  if (bin) return mk('Environment', 'claude on PATH', 'ok', bin);
  return mk('Environment', 'claude on PATH', 'error', 'not found', {
    safe: false,
    description: 'Install Claude Code',
    cmd: 'npm install -g @anthropic-ai/claude-code',
    apply: null,
  });
}

function checkClaudeVersion() {
  const bin = findClaude();
  if (!bin) return null;
  const v = getClaudeVersion(bin);
  const minStr = MIN_VERSION.join('.');
  if (!v) {
    return mk('Environment', 'claude version', 'warn', 'could not determine', {
      safe: false, description: 'Update Claude Code', cmd: 'claude update', apply: null,
    });
  }
  if (compareVersion(v, MIN_VERSION) >= 0) return mk('Environment', 'claude version', 'ok', `${v.raw} (>=${minStr})`);
  return mk('Environment', 'claude version', 'warn', `${v.raw} < ${minStr} — CLAUDE_CONFIG_DIR isolation unreliable`, {
    safe: false, description: 'Update Claude Code', cmd: 'claude update', apply: null,
  });
}

const CONFLICT_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

function checkConflictingEnv() {
  const set = CONFLICT_VARS.filter(k => process.env[k]);
  if (set.length === 0) return mk('Environment', 'conflicting env vars', 'ok', 'none set');
  const cmd = process.platform === 'win32'
    ? set.map(k => `Remove-Item Env:${k}`).join('; ')
    : set.map(k => `unset ${k}`).join('; ');
  return mk('Environment', 'conflicting env vars', 'warn', `set: ${set.join(', ')}`, {
    safe: false, description: 'Unset to avoid auth interference with cc use', cmd, apply: null,
  });
}

function findAllOnPath(name) {
  const PATH = process.env.PATH || process.env.Path || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(s => s.trim()).filter(Boolean)
    : [''];
  const found = [];
  const seen = new Set();
  for (const dir of PATH.split(sep).filter(Boolean)) {
    for (const ext of exts) {
      try {
        const full = path.join(dir, name + ext);
        if (fs.statSync(full).isFile()) {
          const key = process.platform === 'win32' ? full.toLowerCase() : full;
          if (!seen.has(key)) { seen.add(key); found.push(full); }
          break;
        }
      } catch { /* skip */ }
    }
  }
  return found;
}

function checkCcShadow() {
  const all = findAllOnPath('cc');
  if (all.length <= 1) {
    return mk('Environment', 'cc on PATH', 'ok', all[0] || 'not found yet (expected after npm install -g)');
  }
  return mk('Environment', 'cc on PATH', 'warn', `multiple: ${all.join(', ')}`, {
    safe: false, description: 'Remove duplicate cc entries to avoid version confusion', cmd: null, apply: null,
  });
}

// --- Storage ---

function checkProfilesDirWritable() {
  const base = profiles.baseDir();
  if (!fs.existsSync(base)) {
    return mk('Storage', '~/.claude-profiles/', 'warn', 'does not exist', {
      safe: true,
      description: `Create ${base}`,
      cmd: null,
      apply: async () => {
        fs.mkdirSync(base, { recursive: true });
        process.stdout.write(`  Created ${base}\n`);
      },
    });
  }
  try {
    fs.accessSync(base, fs.constants.W_OK);
    return mk('Storage', '~/.claude-profiles/', 'ok', 'writable');
  } catch {
    const cmd = process.platform === 'win32'
      ? `icacls "${base}" /grant "%USERNAME%:F"`
      : `chmod u+w "${base}"`;
    return mk('Storage', '~/.claude-profiles/', 'error', `not writable: ${base}`, {
      safe: false, description: 'Fix directory permissions', cmd, apply: null,
    });
  }
}

function checkProfileClaudeJson(prof) {
  const p = path.join(prof.dir, '.claude.json');
  if (!fs.existsSync(p)) return mk('Storage', `"${prof.name}" .claude.json`, 'ok', 'not yet logged in');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    if (raw.trim()) JSON.parse(raw);
    return mk('Storage', `"${prof.name}" .claude.json`, 'ok', 'valid JSON');
  } catch (e) {
    return mk('Storage', `"${prof.name}" .claude.json`, 'error', `parse error: ${e.message}`, {
      safe: false,
      description: `Back up ${path.basename(p)} and reset to {}`,
      cmd: null,
      apply: async () => {
        const bak = `${p}.bak.${Date.now()}`;
        fs.renameSync(p, bak);
        fs.writeFileSync(p, '{}');
        process.stdout.write(`  Backed up to ${path.basename(bak)}, reset to {}\n`);
      },
    });
  }
}

function checkProfileLinks(prof) {
  const results = [];
  const pp = path.join(prof.dir, 'projects');
  let isLinkNode = false;
  try { isLinkNode = fs.lstatSync(pp).isSymbolicLink(); } catch { return results; }
  if (!isLinkNode) return results;

  try {
    fs.statSync(pp);
    results.push(mk('Storage', `"${prof.name}" projects/ link`, 'ok', 'valid'));
    return results;
  } catch { /* broken */ }

  const expected = path.join(profiles.sharedDir(), 'projects');
  const targetExists = fs.existsSync(expected);
  results.push(mk('Storage', `"${prof.name}" projects/ link`, 'error', 'broken — target missing', {
    safe: targetExists,
    description: targetExists ? `Recreate junction/symlink to ${expected}` : 'Target missing',
    cmd: targetExists ? null : `cc link ${prof.name}`,
    apply: targetExists ? async () => {
      try { fs.unlinkSync(pp); } catch { try { fs.rmdirSync(pp); } catch { /* ignore */ } }
      fs.symlinkSync(expected, pp, process.platform === 'win32' ? 'junction' : 'dir');
      process.stdout.write(`  Recreated: ${pp} -> ${expected}\n`);
    } : null,
  }));
  return results;
}

// --- Platform ---

function checkOneDrive() {
  if (process.platform !== 'win32') return null;
  if (/onedrive/i.test(os.homedir()) || /onedrive/i.test(process.env.USERPROFILE || '')) {
    return mk('Platform', 'OneDrive home folder', 'warn',
      'home is OneDrive-synced — can corrupt directory junctions', {
      safe: false, description: 'Exclude ~/.claude-profiles from OneDrive sync', cmd: null, apply: null,
    });
  }
  return mk('Platform', 'OneDrive home folder', 'ok', 'not OneDrive-redirected');
}

function checkWindowsAppsCc() {
  if (process.platform !== 'win32') return null;
  const p = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'cc.cmd');
  if (!fs.existsSync(p)) return mk('Platform', 'WindowsApps cc.cmd', 'ok', 'not present');
  return mk('Platform', 'WindowsApps cc.cmd', 'warn', `${p} may shadow npm-installed cc`, {
    safe: false, description: 'Delete the stale stub', cmd: `del "${p}"`, apply: null,
  });
}

function checkStaleBinCc() {
  if (process.platform !== 'win32') return null;
  const p = path.join(os.homedir(), 'bin', 'cc');
  if (!fs.existsSync(p)) return null;
  return mk('Platform', '~/bin/cc', 'warn', `${p} may be an old version shadowing npm-installed cc`, {
    safe: false, description: 'Remove the old script', cmd: `Remove-Item "${p}"`, apply: null,
  });
}

function checkCygpath() {
  if (process.platform !== 'win32') return null;
  if (!process.env.MSYSTEM && !process.env.MINGW_PREFIX) return null;
  if (findAllOnPath('cygpath').length > 0) return mk('Platform', 'cygpath (Git Bash)', 'ok', 'available');
  return mk('Platform', 'cygpath (Git Bash)', 'warn', 'not found — path conversion may fail', {
    safe: false, description: 'Use Git for Windows which bundles cygpath', cmd: null, apply: null,
  });
}

// --- Sanity ---

function checkSpawnClaude() {
  const bin = findClaude();
  if (!bin) return null;
  const v = getClaudeVersion(bin);
  if (v) return mk('Sanity', 'test-spawn claude --version', 'ok', v.raw);
  return mk('Sanity', 'test-spawn claude --version', 'error', 'no version output', {
    safe: false, description: 'Reinstall Claude Code', cmd: 'npm install -g @anthropic-ai/claude-code', apply: null,
  });
}

// --- Collect all ---

function runChecks() {
  const results = [
    checkNodeVersion(),
    checkClaudeOnPath(),
    checkClaudeVersion(),
    checkConflictingEnv(),
    checkCcShadow(),
    checkProfilesDirWritable(),
  ];
  for (const prof of profiles.listProfiles()) {
    results.push(checkProfileClaudeJson(prof));
    results.push(...checkProfileLinks(prof));
  }
  results.push(
    checkOneDrive(),
    checkWindowsAppsCc(),
    checkStaleBinCc(),
    checkCygpath(),
    checkSpawnClaude(),
  );
  return results.filter(Boolean);
}

// --- Output formatting ---

function colorIcon(status) {
  const icon = status === 'ok' ? '✓' : status === 'warn' ? '⚠' : '✗';
  if (!color.colorEnabled(process.stdout)) return icon;
  if (status === 'ok') return `\x1b[32m${icon}\x1b[39m`;
  if (status === 'warn') return `\x1b[33m${icon}\x1b[39m`;
  return `\x1b[31m${icon}\x1b[39m`;
}

function formatText(results) {
  const groups = {};
  for (const g of GROUP_ORDER) groups[g] = [];
  for (const r of results) {
    if (groups[r.group]) groups[r.group].push(r);
  }

  const lines = [];
  for (const g of GROUP_ORDER) {
    if (groups[g].length === 0) continue;
    lines.push(g);
    for (const r of groups[g]) {
      lines.push(`  ${colorIcon(r.status)}  ${r.name}: ${r.message}`);
      if (r.status !== 'ok' && r.fix) {
        if (r.fix.cmd) {
          lines.push(`       → Run: ${r.fix.cmd}`);
        } else if (r.fix.apply) {
          lines.push(`       → Run: ${r.fix.safe ? 'cc doctor --fix' : 'cc doctor --fix --force'}`);
        }
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function serializeFix(fix) {
  if (!fix) return null;
  return { safe: fix.safe, description: fix.description || null, cmd: fix.cmd || null };
}

function formatJson(results) {
  const counts = { ok: 0, warn: 0, error: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  return JSON.stringify({
    summary: counts,
    checks: results.map(r => ({
      group: r.group, name: r.name, status: r.status, message: r.message,
      fix: serializeFix(r.fix),
    })),
  }, null, 2);
}

// --- Fix runner ---

async function applyFixes(results, force, promptFn) {
  const toFix = results.filter(r => r.fix && r.fix.apply && (r.fix.safe || force));
  if (toFix.length === 0) {
    process.stdout.write('Nothing auto-fixable found.\n');
    return;
  }
  for (const r of toFix) {
    if (r.fix.safe) {
      process.stdout.write(`Fixing: ${r.name}\n`);
      await r.fix.apply();
    } else {
      const ans = await promptFn(`Fix "${r.name}" — ${r.fix.description || r.name}? [y/N]: `);
      if (ans.trim().toLowerCase() === 'y') {
        await r.fix.apply();
      } else {
        process.stdout.write('  Skipped.\n');
      }
    }
  }
}

// --- Entry point ---

async function runDoctor({ fix, force, json, prompt: promptFn }) {
  const results = runChecks();

  if (json) {
    process.stdout.write(formatJson(results) + '\n');
  } else {
    process.stdout.write(formatText(results));
  }

  if (fix) {
    if (!json) process.stdout.write('Applying fixes...\n');
    await applyFixes(results, force, promptFn);
  } else if (!json) {
    const errors = results.filter(r => r.status === 'error');
    const warns = results.filter(r => r.status === 'warn');
    if (errors.length === 0 && warns.length === 0) {
      process.stdout.write('All checks passed.\n');
    } else {
      const parts = [];
      if (errors.length) parts.push(`${errors.length} error${errors.length !== 1 ? 's' : ''}`);
      if (warns.length) parts.push(`${warns.length} warning${warns.length !== 1 ? 's' : ''}`);
      process.stdout.write(`${parts.join(', ')}.\n`);
      const hasAutoFix = results.some(r => r.fix && r.fix.apply && r.fix.safe);
      const hasForce = results.some(r => r.fix && r.fix.apply && !r.fix.safe);
      if (hasAutoFix) process.stdout.write('Run: cc doctor --fix\n');
      else if (hasForce) process.stdout.write('Run: cc doctor --fix --force\n');
    }
  }

  if (results.some(r => r.status === 'error')) return 2;
  if (results.some(r => r.status === 'warn')) return 1;
  return 0;
}

module.exports = { runChecks, runDoctor };
