'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const profiles = require('./profiles');
const share = require('./share');
const envLib = require('./env');
const { findClaude, getClaudeVersion, compareVersion, MIN_VERSION } = require('./spawn');
const color = require('./color');

const GROUP_ORDER = ['Environment', 'Storage', 'Platform', 'Sanity'];

// Default sink for fix progress. JSON mode passes a stderr writer instead.
const stdoutWrite = (text) => process.stdout.write(text);

// fix: { safe, description, cmd, apply }
//   safe=true  → auto-applied by --fix
//   safe=false → needs --fix --force, prompted y/N
//   cmd        → printed when fix cannot be auto-applied
//   apply      → async fn to execute, receives the progress writer

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

function checkConflictingEnv() {
  const set = envLib.authEnvConflicts();
  if (set.length === 0) return mk('Environment', 'conflicting env vars', 'ok', 'none set');
  const cmd = process.platform === 'win32'
    ? set.map(k => `Remove-Item Env:${k}`).join('; ')
    : set.map(k => `unset ${k}`).join('; ');
  return mk('Environment', 'conflicting env vars', 'warn', `set: ${set.join(', ')}`, {
    safe: false, description: 'Unset to avoid auth interference with cchost use', cmd, apply: null,
  });
}

function findAllOnPath(name, platform = process.platform) {
  const PATH = process.env.PATH || process.env.Path || '';
  const sep = platform === 'win32' ? ';' : ':';
  const exts = platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(s => s.trim()).filter(Boolean)
    : [''];
  const found = [];
  const seen = new Set();
  for (const dir of PATH.split(sep).filter(Boolean)) {
    for (const ext of exts) {
      try {
        const full = path.join(dir, name + ext);
        if (fs.statSync(full).isFile()) {
          const key = platform === 'win32' ? full.toLowerCase() : full;
          if (!seen.has(key)) { seen.add(key); found.push(full); }
          break;
        }
      } catch { /* skip */ }
    }
  }
  return found;
}

// Resolve a path to the object it points at.
function pathIdentity(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// True only when `p` really is the cchost CLI. A bare `cc` may be a compiler
// (clang, gcc, ccache, conda) and must not be mistaken for the legacy alias.
function isCchostBinary(p) {
  const target = pathIdentity(p);
  if (/[\\/]cchost[\\/]bin[\\/]cc\.js$/i.test(target)) return true;
  try {
    const st = fs.statSync(target);
    if (!st.isFile() || st.size > 256 * 1024) return false;
    const text = fs.readFileSync(target, 'utf8');
    return /cchost/i.test(text) && /(node_modules|cc\.js)/i.test(text);
  } catch {
    return false;
  }
}

// Windows npm writes separate cc.cmd and cchost.cmd shims. Extract the
// bin/cc.js they invoke so shims from the same install share an identity while
// a stale shim pointing elsewhere still counts as a separate install.
function shimTarget(p) {
  if (!/\.(cmd|bat|ps1)$/i.test(p)) return null;
  try {
    const text = fs.readFileSync(p, 'utf8');
    const m = text.match(
      /(?:[A-Za-z]:[\\/]|%dp0%[\\/]|%~dp0[\\/]|(?:\.\.?[\\/]))[^"\r\n]*?node_modules[\\/]+cchost[\\/]+bin[\\/]+cc\.js/i,
    );
    if (!m) return null;
    const raw = m[0];
    if (/^[A-Za-z]:[\\/]/.test(raw)) {
      return raw.replace(/[\\/]/g, '\\').toLowerCase();
    }
    const relative = raw
      .replace(/^%dp0%|^%~dp0/i, '')
      .replace(/^[\\/]+/, '')
      .replace(/[\\/]/g, path.sep);
    return path.resolve(path.dirname(p), relative).replace(/[\\/]/g, '\\').toLowerCase();
  } catch {
    return null;
  }
}

function shadowIdentity(p, platform = process.platform) {
  if (platform === 'win32') {
    const target = shimTarget(p);
    if (target) return `shim:${target}`;
  }
  return pathIdentity(p);
}

function checkCcShadow(platform = process.platform) {
  const found = [];
  for (const name of ['cchost', 'cc']) {
    for (const p of findAllOnPath(name, platform)) {
      if (name === 'cc' && !isCchostBinary(p)) continue;
      found.push({ name, path: p });
    }
  }

  const unique = [];
  const seen = new Set();
  for (const entry of found) {
    const key = shadowIdentity(entry.path, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }

  if (unique.length <= 1) {
    return mk(
      'Environment',
      'cchost on PATH',
      'ok',
      unique.length ? unique[0].path : 'not found yet (expected after npm install -g cchost)',
    );
  }
  return mk('Environment', 'cchost on PATH', 'warn', `multiple: ${unique.map((e) => e.path).join(', ')}`, {
    safe: false,
    description: 'Remove duplicate cchost/cc entries to avoid version confusion',
    cmd: null,
    apply: null,
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
      apply: async (write = stdoutWrite) => {
        fs.mkdirSync(base, { recursive: true });
        write(`  Created ${base}\n`);
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
      apply: async (write = stdoutWrite) => {
        const bak = `${p}.bak.${Date.now()}`;
        fs.renameSync(p, bak);
        fs.writeFileSync(p, '{}');
        write(`  Backed up to ${path.basename(bak)}, reset to {}\n`);
      },
    });
  }
}

function checkProfileLinks(prof) {
  const results = [];
  for (const resource of share.SHARED_RESOURCES) {
    const pp = path.join(prof.dir, resource);
    const isFile = share.isFileResource(resource);
    const label = isFile ? resource : `${resource}/`;
    const expected = path.join(profiles.defaultClaudeDir(), resource);

    let stat;
    try { stat = fs.lstatSync(pp); } catch { stat = null; }

    if (!stat) {
      // Resource missing entirely — safe to auto-create the link.
      results.push(
        mk('Storage', `"${prof.name}" ${label}`, 'warn', 'missing — not linked', {
          safe: true,
          description: `Create link to ~/.claude/${resource}`,
          cmd: null,
          apply: async (write = stdoutWrite) => {
            const r = share.shareLink(prof.name, subsetForResource(resource))[0];
            if (r && r.status === 'linked') {
              write(`  Linked: ${pp} -> ${expected}\n`);
            } else if (r) {
              write(`  Could not link ${pp}: ${r.message || r.status}\n`);
            }
          },
        }),
      );
      continue;
    }

    if (stat.isSymbolicLink()) {
      // Symlink — check it resolves correctly.
      if (share.isSharedResource(prof.dir, resource)) {
        results.push(mk('Storage', `"${prof.name}" ${label} link`, 'ok', 'valid'));
        continue;
      }
      // Broken or points elsewhere.
      results.push(
        mk('Storage', `"${prof.name}" ${label} link`, 'error', 'broken — target missing or wrong', {
          safe: true,
          description: `Recreate link to ${expected}`,
          cmd: null,
          apply: async (write = stdoutWrite) => {
            share.removeLink(pp);
            const r = share.shareLink(prof.name, subsetForResource(resource))[0];
            if (r && (r.status === 'linked' || r.status === 'already-linked')) {
              write(`  Recreated: ${pp} -> ${expected}\n`);
            } else if (r) {
              write(`  Could not recreate ${pp}: ${r.message || r.status}\n`);
            }
          },
        }),
      );
      continue;
    }

    // Not a symlink. Could be (a) hard link sharing (Windows file fallback)
    // → ok, or (b) genuinely private content → warn (no auto-fix).
    if (share.isSharedResource(prof.dir, resource)) {
      results.push(mk('Storage', `"${prof.name}" ${label} link`, 'ok', 'valid (hard link)'));
      continue;
    }

    // Private — distinguish empty (safe to auto-link) from has-content (warn).
    let hasContent = false;
    try {
      if (isFile) hasContent = stat.size > 0;
      else hasContent = fs.readdirSync(pp).length > 0;
    } catch { hasContent = true; }

    if (!hasContent) {
      results.push(
        mk('Storage', `"${prof.name}" ${label}`, 'warn', 'private (empty) — not linked', {
          safe: true,
          description: `Replace with link to ~/.claude/${resource}`,
          cmd: null,
          apply: async (write = stdoutWrite) => {
            try {
              if (isFile) fs.unlinkSync(pp);
              else fs.rmdirSync(pp);
            } catch { /* fall through */ }
            const r = share.shareLink(prof.name, subsetForResource(resource))[0];
            if (r && r.status === 'linked') {
              write(`  Linked: ${pp} -> ${expected}\n`);
            } else if (r) {
              write(`  Could not link ${pp}: ${r.message || r.status}\n`);
            }
          },
        }),
      );
      continue;
    }

    results.push(
      mk('Storage', `"${prof.name}" ${label}`, 'warn', 'private (has content) — not linked', {
        safe: false,
        description: 'Move or remove the private content, then re-run cchost link',
        cmd: `cchost copy default ${prof.name}  # if you want to merge it the other way; ` +
          `or manually move ${pp} aside, then: cchost link ${prof.name}`,
        apply: null,
      }),
    );
  }
  return results;
}

// Build the share.shareLink opts to target exactly one resource.
function subsetForResource(resource) {
  if (share.PROJECT_SUBDIRS.includes(resource)) return { projects: true };
  if (share.TOOL_SUBDIRS.includes(resource)) {
    // shareLink with {tools:true} targets all 3 tool dirs; that's fine for
    // backfilling, the others are no-ops if already linked.
    return { tools: true };
  }
  if (share.CONFIG_FILES.includes(resource)) return { config: true };
  return {};
}

// v0.3 → v0.4 migration nudge. If the legacy ~/.claude-shared/ pool still
// exists, surface it as a warning with a safe auto-fix that runs the
// one-time migration.
function checkLegacyPool() {
  const legacy = profiles.sharedDir();
  if (!fs.existsSync(legacy)) return null;
  // Self-referencing pre-v0.4 setup: `~/.claude/projects/` was made a junction
  // into `~/.claude-shared/projects/`. The two locations are the same physical
  // dir on disk — no migration is possible (or needed). Flag it as a warning
  // with a manual cleanup hint instead of a self-move auto-fix.
  const pool = profiles.defaultClaudeDir();
  for (const sub of share.SHARED_DIRS) {
    const poolSub = path.join(pool, sub);
    const legacySub = path.join(legacy, sub);
    try {
      if (fs.existsSync(poolSub) && fs.realpathSync(poolSub) === fs.realpathSync(legacySub)) {
        return mk('Storage', '~/.claude-shared/ (legacy)', 'warn',
          `~/.claude/${sub}/ is a junction into ~/.claude-shared/${sub}/ — same physical dir, safe to remove the junction and migrate by hand`,
          {
            safe: false,
            description: 'Manually move ~/.claude-shared/<sub>/ contents to ~/.claude/<sub>/, remove the junction, then delete ~/.claude-shared/',
            cmd: null,
            apply: null,
          });
      }
    } catch { /* fall through */ }
  }
  let hasContent = false;
  try {
    hasContent = fs.readdirSync(legacy).length > 0;
  } catch {
    // Unreadable — still flag it.
    hasContent = true;
  }
  if (!hasContent) {
    // Empty dir — safe to remove silently.
    return mk('Storage', '~/.claude-shared/ (legacy)', 'warn', 'empty dir from a prior cchost version', {
      safe: true,
      description: 'Remove the empty legacy pool',
      cmd: null,
      apply: async (write = stdoutWrite) => {
        try { fs.rmdirSync(legacy); write(`  Removed ${legacy}\n`); } catch (e) {
          write(`  Could not remove ${legacy}: ${e.message}\n`);
        }
      },
    });
  }
  return mk('Storage', '~/.claude-shared/ (legacy)', 'warn', 'pre-v0.4 pool with content — migrate into ~/.claude/', {
    safe: true,
    description: 'Move legacy pool contents into ~/.claude/ and re-point profile symlinks',
    cmd: null,
    apply: async (write = stdoutWrite) => {
      const result = share.migrateLegacyPool({ log: (line) => write(`  ${line}\n`) });
      write(
        `  Done: ${result.moves.length} item(s) moved, ${result.relinked.length} link(s) repointed.\n`,
      );
    },
  });
}

// Damaged session filenames left inside projects/<X>/ by an earlier
// (v0.4.2-and-earlier) heal that injected `__legacy` into UUID filenames on
// collision. These break `claude --resume` because it expects strict
// <uuid>.jsonl. Safe auto-fix strips the suffix (or reissues a fresh UUID
// when the canonical name is taken).
function checkDamagedSessionFilenames() {
  const projectsDir = path.join(profiles.defaultClaudeDir(), 'projects');
  if (!fs.existsSync(projectsDir)) return null;
  let folders;
  try {
    folders = fs.readdirSync(projectsDir);
  } catch {
    return null;
  }
  const damagedRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:__legacy(?:_\d+)?)+(\.jsonl)?$/i;
  let count = 0;
  const sampleFolders = new Set();
  for (const folder of folders) {
    const folderPath = path.join(projectsDir, folder);
    let st;
    try { st = fs.statSync(folderPath); } catch { continue; }
    if (!st.isDirectory()) continue;
    let children;
    try { children = fs.readdirSync(folderPath); } catch { continue; }
    for (const child of children) {
      if (damagedRe.test(child)) {
        count += 1;
        if (sampleFolders.size < 3) sampleFolders.add(folder);
      }
    }
  }
  if (count === 0) return null;
  const sample = Array.from(sampleFolders).join(', ') + (sampleFolders.size < 3 ? '' : ', ...');
  return mk(
    'Storage',
    '~/.claude/projects/ damaged session filenames',
    'warn',
    `${count} session file${count === 1 ? '' : 's'} with __legacy in UUID — invisible to claude --resume (${sample})`,
    {
      safe: true,
      description: 'Restore <uuid>.jsonl filenames (reissue a fresh UUID when canonical is taken)',
      cmd: null,
      apply: async (write = stdoutWrite) => {
        const result = share.repairProjectFilenames({
          log: (line) => write(`${line}\n`),
        });
        write(
          `  Done: ${result.repaired.length} filename${result.repaired.length === 1 ? '' : 's'} restored.\n`,
        );
        if (result.failures.length) {
          for (const f of result.failures) {
            write(`  Failure (${f.kind}): ${f.folder ? f.folder + '/' : ''}${f.name || ''} ${f.message}\n`);
          }
        }
      },
    },
  );
}

// Stranded projects/<base>__legacy* folders left by older v0.4 migrations.
// Each one hides its session files from `claude --resume` because resume
// filters by cwd-encoded folder name. Safe auto-fix merges them into the
// canonical sibling (or renames in place if no sibling exists).
function checkLegacyProjectFolders() {
  const projectsDir = path.join(profiles.defaultClaudeDir(), 'projects');
  if (!fs.existsSync(projectsDir)) return null;
  let entries;
  try {
    entries = fs.readdirSync(projectsDir);
  } catch {
    return null;
  }
  const legacy = entries.filter((e) => /__legacy(?:_\d+)?$/.test(e));
  if (legacy.length === 0) return null;
  const sample = legacy.slice(0, 3).join(', ') + (legacy.length > 3 ? ', ...' : '');
  return mk(
    'Storage',
    '~/.claude/projects/ legacy folders',
    'warn',
    `${legacy.length} folder${legacy.length === 1 ? '' : 's'} with __legacy suffix hide sessions from --resume (${sample})`,
    {
      safe: true,
      description: 'Merge each legacy projects/ folder into its canonical sibling',
      cmd: null,
      apply: async (write = stdoutWrite) => {
        const result = share.healProjectsLegacy({
          log: (line) => write(`  ${line}\n`),
        });
        write(
          `  Done: ${result.healed.length} folder${result.healed.length === 1 ? '' : 's'} healed.\n`,
        );
        if (result.failures.length) {
          for (const f of result.failures) {
            write(`  Failure (${f.kind}): ${f.name || ''} ${f.message}\n`);
          }
        }
      },
    },
  );
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
  return mk('Platform', 'WindowsApps cc.cmd', 'warn', `${p} may shadow npm-installed cchost`, {
    safe: false, description: 'Delete the stale stub', cmd: `del "${p}"`, apply: null,
  });
}

function checkStaleBinCc() {
  if (process.platform !== 'win32') return null;
  const p = path.join(os.homedir(), 'bin', 'cc');
  if (!fs.existsSync(p)) return null;
  return mk('Platform', '~/bin/cc', 'warn', `${p} may be an old version shadowing npm-installed cchost`, {
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

// macOS keeps OAuth tokens in the login Keychain rather than in the profile
// directory. The Keychain item is scoped to the macOS user, not to
// CLAUDE_CONFIG_DIR, so two logged-in subscription profiles can end up sharing
// the same account. One profile (or none) cannot collide, so don't warn then.
function checkMacKeychain(platform = process.platform) {
  if (platform !== 'darwin') return null;
  let profilesList = [];
  try {
    profilesList = profiles.listProfiles(platform);
  } catch {
    return null;
  }
  const keychainProfiles = profilesList.filter(
    (p) => !envLib.hasEnvConfig(p.dir) && p.credentialSource === 'keychain',
  );
  if (keychainProfiles.length < 2) {
    return mk(
      'Platform',
      'macOS credentials (Keychain)',
      'ok',
      `${keychainProfiles.length} logged-in subscription profile(s); Keychain sharing cannot mix accounts`,
    );
  }
  return mk(
    'Platform',
    'macOS credentials (Keychain)',
    'warn',
    `${keychainProfiles.length} logged-in subscription profiles use the same login Keychain; accounts can be mixed up. Use custom-endpoint profiles or separate macOS users for guaranteed isolation (see README Platform notes)`,
    {
      safe: false,
      description: 'Use custom-endpoint profiles or separate macOS users for guaranteed isolation',
      cmd: null,
      apply: null,
    },
  );
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
  results.push(checkLegacyPool());
  results.push(checkLegacyProjectFolders());
  results.push(checkDamagedSessionFilenames());
  for (const prof of profiles.listProfiles()) {
    results.push(checkProfileClaudeJson(prof));
    results.push(...checkProfileLinks(prof));
  }
  results.push(
    checkMacKeychain(),
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
          lines.push(`       → Run: ${r.fix.safe ? 'cchost doctor --fix' : 'cchost doctor --fix --force'}`);
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

async function applyFixes(results, force, promptFn, write = stdoutWrite) {
  const toFix = results.filter(r => r.fix && r.fix.apply && (r.fix.safe || force));
  if (toFix.length === 0) {
    write('Nothing auto-fixable found.\n');
    return 0;
  }
  let applied = 0;
  for (const r of toFix) {
    if (r.fix.safe) {
      write(`Fixing: ${r.name}\n`);
      await r.fix.apply(write);
      applied += 1;
    } else {
      const ans = await promptFn(`Fix "${r.name}" — ${r.fix.description || r.name}? [y/N]: `);
      if (ans.trim().toLowerCase() === 'y') {
        await r.fix.apply(write);
        applied += 1;
      } else {
        write('  Skipped.\n');
      }
    }
  }
  return applied;
}

function doctorExitCode(results) {
  if (results.some(r => r.status === 'error')) return 2;
  if (results.some(r => r.status === 'warn')) return 1;
  return 0;
}

// --- Entry point ---

async function runDoctor({ fix, force, json, prompt: promptFn }) {
  let results = runChecks();

  if (json && fix) {
    // Fix progress must not corrupt the JSON document: send it (and any
    // prompts) to stderr, then emit one report of the post-fix state.
    const stderrWrite = (text) => process.stderr.write(text);
    const promptOnStderr = (question) => promptFn(question, process.stderr);
    const applied = await applyFixes(results, force, promptOnStderr, stderrWrite);
    if (applied > 0) results = runChecks();
    process.stdout.write(formatJson(results) + '\n');
    return doctorExitCode(results);
  }

  if (json) {
    process.stdout.write(formatJson(results) + '\n');
    return doctorExitCode(results);
  }

  process.stdout.write(formatText(results));

  if (fix) {
    process.stdout.write('Applying fixes...\n');
    const applied = await applyFixes(results, force, promptFn);
    if (applied > 0) {
      results = runChecks();
      process.stdout.write('\nAfter fixes:\n' + formatText(results));
    }
  } else {
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
      if (hasAutoFix) process.stdout.write('Run: cchost doctor --fix\n');
      else if (hasForce) process.stdout.write('Run: cchost doctor --fix --force\n');
    }
  }

  return doctorExitCode(results);
}

module.exports = { runChecks, runDoctor, checkCcShadow, checkMacKeychain };
