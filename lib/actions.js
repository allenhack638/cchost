'use strict';

// Structured versions of cchost's mutating commands, for `cchost ui`. Each
// action runs in two modes on the same code path the CLI uses: dryRun (the
// preview) and real (the apply). Both return per-resource lines:
//   { n, resource, label, kind, text }
// where kind is 'change' | 'same' | 'warn' | 'error' | 'info', so the page can
// show exactly what will happen, then exactly what did.
//
// Nothing returned here ever contains an endpoint token, and emails are masked.

const fs = require('fs');
const path = require('path');

const profiles = require('./profiles');
const share = require('./share');
const copyLib = require('./copy');
const envLib = require('./env');
const updateLib = require('./update');
const { removeRecursivelyPreservingLinks } = require('./fsutil');
const mcpLib = require('./mcp');
const backupLib = require('./backup');

const GROUPS = {
  projects: share.PROJECT_SUBDIRS,
  tools: share.TOOL_SUBDIRS,
  config: share.CONFIG_FILES,
};
const GROUP_NAMES = Object.keys(GROUPS);

function groupOf(resource) {
  return GROUP_NAMES.find((g) => GROUPS[g].includes(resource));
}

const RESOURCES = share.SHARED_RESOURCES.map((id, i) => ({
  id,
  n: String(i + 1).padStart(2, '0'),
  label: share.isFileResource(id) ? id : `${id}/`,
  group: groupOf(id),
}));
const META = Object.fromEntries(RESOURCES.map((r) => [r.id, r]));

function actionError(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// `label` names a profile-level line (no resource), e.g. 'profile', 'login'.
function line(resource, kind, text, label = null) {
  if (!resource) return { n: null, resource: null, label, kind, text };
  const m = META[resource];
  return { n: m.n, resource, label: m.label, kind, text };
}

// ['tools', 'config'] -> { tools: true, config: true }. Empty means all 7.
function groupOpts(groups) {
  const list = Array.isArray(groups) ? groups : [];
  const opts = {};
  for (const g of list) {
    if (!GROUP_NAMES.includes(g)) throw actionError(`Unknown group "${g}". Use: ${GROUP_NAMES.join(', ')}`);
    opts[g] = true;
  }
  return opts;
}

function existingProfile(name) {
  if (typeof name !== 'string') throw actionError('profile is required');
  profiles.validateProfileName(name);
  if (profiles.isAlias(name) && !fs.existsSync(profiles.profileDir(name))) {
    throw actionError(`"${name}" is your existing account in ~/.claude, which is the shared pool itself — there is nothing to link, unlink or copy.`, 409);
  }
  const dir = profiles.profileDir(name);
  if (!fs.existsSync(dir)) throw actionError(`Profile "${name}" does not exist.`, 404);
  return dir;
}

function profileSummary(p) {
  if (p.alias) {
    const resources = Object.fromEntries(share.SHARED_RESOURCES.map((r) => [r, 'pool']));
    return {
      name: p.name,
      alias: true,
      loggedIn: p.loggedIn,
      credentialSource: p.credentialSource,
      email: p.email ? envLib.maskEmail(p.email) : '',
      kind: 'subscription',
      endpoint: 'Anthropic',
      resources,
      shared: share.SHARED_RESOURCES.length,
    };
  }
  const resources = {};
  for (const r of share.SHARED_RESOURCES) resources[r] = share.resourceState(p.dir, r);
  let endpoint;
  try {
    endpoint = envLib.endpointSummary(p.dir);
  } catch {
    endpoint = '(invalid config)';
  }
  return {
    name: p.name,
    loggedIn: p.loggedIn,
    credentialSource: p.credentialSource,
    email: p.email ? envLib.maskEmail(p.email) : '',
    kind: envLib.hasEnvConfig(p.dir) ? 'endpoint' : 'subscription',
    endpoint,
    resources,
    shared: Object.values(resources).filter((s) => s === 'shared').length,
  };
}

function existingAccount() {
  const found = fs.existsSync(profiles.defaultClaudeJson()) || fs.existsSync(profiles.defaultClaudeDir());
  const acct = profiles.readDefaultAccount();
  return { found, loggedIn: acct.loggedIn, email: acct.email ? envLib.maskEmail(acct.email) : '', name: profiles.getAlias() };
}

function state() {
  return {
    update: updateLib.available(),
    existing: existingAccount(),
    pool: '~/.claude',
    profilesDir: '~/.claude-profiles',
    groups: GROUPS,
    resources: RESOURCES,
    profiles: profiles.listProfiles().map(profileSummary),
  };
}

// --- link / unlink ---------------------------------------------------------

function link({ profile, groups, backup }, { dryRun }) {
  existingProfile(profile);
  const results = share.shareLink(profile, { ...groupOpts(groups), dryRun, backup: Boolean(backup) });
  const lines = results.map(linkLine(dryRun));
  const mcpLinked = results.some((r) => r.resource === 'mcp.json' && r.status === 'linked');
  if (mcpLinked && !dryRun) lines.push(...mcpLib.sync({ profiles: [profile] }, { dryRun: false }));
  else if (mcpLinked) lines.push(line(null, 'info', 'then add the pool\'s MCP servers to this profile', 'mcp'));
  return lines;
}

function linkLine(dryRun) {
  return (r) => {
    if (r.status === 'already-linked') return line(r.resource, 'same', 'already shared');
    if (r.status === 'linked' && r.identical) {
      return line(r.resource, 'change', `${dryRun ? 'link to' : 'linked to'} ~/.claude/${r.resource} (this profile's copy matches it)`);
    }
    if (r.status === 'linked' && r.backup) {
      return line(r.resource, 'change', dryRun
        ? `keep this profile's copy as ${r.resource}.cchost-backup-<time>, then link to ~/.claude/${r.resource}`
        : `kept this profile's copy as ${r.backup}; linked to ~/.claude/${r.resource}`);
    }
    if (r.status === 'linked') {
      const legacy = r.relinkedFromLegacy ? ' (was pointing at legacy ~/.claude-shared/)' : '';
      return line(r.resource, 'change', `${dryRun ? 'link to' : 'linked to'} ~/.claude/${r.resource}${legacy}`);
    }
    if (r.status === 'refused') {
      return { ...line(r.resource, 'warn', 'has its own content — not shared'), code: 'private-content' };
    }
    if (r.status === 'foreign-link') return line(r.resource, 'warn', 'points outside ~/.claude/ — left alone');
    return line(r.resource, 'error', r.message || r.status);
  };
}

function unlink({ profile, groups }, { dryRun }) {
  existingProfile(profile);
  const results = share.shareUnlink(profile, { ...groupOpts(groups), dryRun });
  return results.map((r) => {
    if (r.status === 'not-linked') return line(r.resource, 'same', 'already private');
    if (r.status === 'unlinked') {
      if (!dryRun) return line(r.resource, 'change', 'unlinked; current content copied in');
      if (r.items === 0) return line(r.resource, 'change', 'unlink (nothing to copy in — ~/.claude/ has no items here)');
      const what = r.items === undefined ? 'the current content' : `${r.items} item${r.items === 1 ? '' : 's'}`;
      return line(r.resource, 'change', `copy ${what} in from ~/.claude/, then unlink`);
    }
    return line(r.resource, 'error', r.message || r.status);
  });
}

// --- copy ------------------------------------------------------------------

function copy({ profile, force }, { dryRun }) {
  existingProfile(profile);
  const { results } = copyLib.copy('default', profile, { force: Boolean(force), dryRun, log: () => {} });
  const verb = dryRun ? 'copy' : 'copied';
  return results.map((r) => {
    if (r.status === 'shared') return line(r.resource, 'same', 'shared — nothing to copy');
    if (r.status === 'absent') return line(r.resource, 'same', 'not present in ~/.claude/');
    if (r.status === 'skipped') return line(r.resource, 'same', 'already present (overwrite to replace)');
    if (r.status === 'copied') return line(r.resource, 'change', `${verb} from ~/.claude/`);
    if (r.status === 'dir') {
      if (r.copied === 0 && r.skipped === 0) return line(r.resource, 'same', 'empty in ~/.claude/');
      const skipped = r.skipped ? `, ${r.skipped} already present` : '';
      if (r.copied === 0) return line(r.resource, 'same', `all ${r.skipped} item(s) already present`);
      return line(r.resource, 'change', `${verb} ${r.copied} item${r.copied === 1 ? '' : 's'}${skipped}`);
    }
    return line(r.resource, 'info', r.status);
  });
}

// --- add -------------------------------------------------------------------

function addExisting(name, { dryRun }) {
  const current = profiles.getAlias();
  const found = fs.existsSync(profiles.defaultClaudeJson()) || fs.existsSync(profiles.defaultClaudeDir());
  if (!found) throw actionError('No existing Claude Code account found (~/.claude.json and ~/.claude are missing). Create a new profile instead.', 404);
  if (current === name) return [line(null, 'same', `your existing account is already called "${name}"`, 'profile')];
  const acct = profiles.readDefaultAccount();
  const who = acct.email ? ` (${envLib.maskEmail(acct.email)})` : '';
  const lines = [];
  if (current) lines.push(line(null, 'change', `${dryRun ? 'rename' : 'renamed'} "${current}" to "${name}"`, 'profile'));
  else lines.push(line(null, 'change', `${dryRun ? 'name' : 'named'} your existing account${who} "${name}"`, 'profile'));
  lines.push(line(null, 'info', `nothing is moved or copied; plain claude keeps working, and cchost use ${name} runs the same account`, 'login'));
  if (dryRun) {
    const have = Object.keys(profiles.readJsonObject(profiles.defaultClaudeJson())?.mcpServers || {});
    const missing = mcpLib.readServers(mcpLib.resolveTarget('pool')).map((x) => x.name).filter((n) => !have.includes(n));
    if (missing.length) lines.push(line(null, 'change', `then add the pool's MCP servers: ${missing.join(', ')}`, 'mcp'));
    return lines;
  }
  profiles.setAlias(name);
  lines.push(...mcpLib.sync({ profiles: [name] }, { dryRun: false }).filter((l) => l.kind !== 'same'));
  return lines;
}

function add({ name, private: privateGroups, endpoint, existing }, { dryRun }) {
  if (typeof name !== 'string' || !name) throw actionError('name is required');
  profiles.validateProfileName(name);
  if (profiles.isAlias(name)) throw actionError(`"${name}" is already the name of your existing account.`, 409);
  if (existing) {
    if (fs.existsSync(profiles.profileDir(name))) throw actionError(`A profile folder named "${name}" already exists.`, 409);
    if (privateGroups && privateGroups.length) throw actionError('--private does not apply to your existing account (it is the shared pool).');
    if (endpoint) throw actionError('An endpoint cannot be added to your existing account.');
    return addExisting(name, { dryRun });
  }
  const dir = profiles.profileDir(name);
  if (fs.existsSync(dir)) throw actionError(`Profile "${name}" already exists.`, 409);

  const privateOpts = groupOpts(privateGroups);
  const privateSet = new Set(Object.keys(privateOpts).length ? share.resolveSubset(privateOpts) : []);

  let config = null;
  if (endpoint) {
    config = {};
    for (const key of envLib.FIELDS) {
      const v = endpoint[key];
      if (typeof v === 'string' && v.trim()) config[key] = v.trim();
    }
    if (!config.base_url) throw actionError('An endpoint profile needs a base URL.');
    const warnings = [];
    for (const [key, value] of Object.entries(config)) envLib.validateField(key, value, (m) => warnings.push(m));
  }

  const lines = [line(null, 'change', `${dryRun ? 'create' : 'created'} ~/.claude-profiles/${name}`, 'profile')];
  if (config) {
    lines.push(line(null, 'change', `${dryRun ? 'use' : 'uses'} ${envLib.hostOf(config.base_url)}${config.auth_token ? ' (token stored user-only)' : ''}`, 'endpoint'));
    if (!config.auth_token) lines.push(line(null, 'info', `token not set yet — the person sets it with: cchost token ${name}`, 'token'));
  } else {
    lines.push(line(null, 'info', `Anthropic subscription: sign in on the first "cchost use ${name}"`, 'login'));
  }

  if (dryRun) {
    for (const r of share.SHARED_RESOURCES) {
      lines.push(privateSet.has(r)
        ? line(r, 'change', 'start private and empty')
        : line(r, 'change', `link to ~/.claude/${r}`));
    }
    return lines;
  }

  profiles.addProfile(name);
  try {
    const sharedOpts = {};
    for (const g of GROUP_NAMES) if (!privateOpts[g]) sharedOpts[g] = true;
    const linkResults = Object.keys(sharedOpts).length ? share.shareLink(name, sharedOpts) : [];
    for (const r of share.SHARED_RESOURCES) {
      if (privateSet.has(r)) {
        if (!share.isFileResource(r)) fs.mkdirSync(path.join(dir, r), { recursive: true });
        lines.push(line(r, 'change', 'private and empty'));
        continue;
      }
      const res = linkResults.find((x) => x.resource === r);
      lines.push(res && (res.status === 'linked' || res.status === 'already-linked')
        ? line(r, 'change', `linked to ~/.claude/${r}`)
        : line(r, 'warn', `not linked — ${(res && res.message) || 'unknown'}`));
    }
    share.markPrivate(dir, privateSet);
    if (config) envLib.writeEnvConfig(dir, config);
    if (!privateSet.has('mcp.json')) {
      lines.push(...mcpLib.sync({ profiles: [name] }, { dryRun: false }).filter((l) => l.kind !== 'same'));
    }
  } catch (err) {
    // Same as the CLI: a half-created profile is removed, shared content kept.
    try {
      removeRecursivelyPreservingLinks(dir);
    } catch { /* best effort */ }
    throw err;
  }
  return lines;
}

// --- remove ----------------------------------------------------------------

function remove({ profile, confirm }, { dryRun }) {
  if (typeof profile === 'string' && profiles.isAlias(profile) && !fs.existsSync(profiles.profileDir(profile))) {
    const lines = [
      line(null, 'change', `${dryRun ? 'forget' : 'forgot'} the name "${profile}"`, 'profile'),
      line(null, 'same', 'your existing account in ~/.claude and ~/.claude.json is not touched', 'login'),
    ];
    if (!dryRun) {
      if (confirm !== profile) throw actionError(`Type the profile name "${profile}" to confirm.`);
      profiles.setAlias(null);
    }
    return lines;
  }
  const dir = existingProfile(profile);
  const lines = [];
  for (const r of share.SHARED_RESOURCES) {
    const st = share.resourceState(dir, r);
    if (st === 'shared') lines.push(line(r, 'same', 'shared — only the link is removed, ~/.claude/ keeps the content'));
    else if (st === 'private') lines.push(line(r, 'warn', 'private content deleted permanently'));
    else if (st === 'foreign-link') lines.push(line(r, 'same', 'link removed; its target is left alone'));
    else lines.push(line(r, 'same', 'nothing to delete'));
  }
  lines.push(line(null, 'warn', `login, sessions and settings in ~/.claude-profiles/${profile} deleted`, 'login'));
  if (dryRun) return lines;

  if (confirm !== profile) throw actionError(`Type the profile name "${profile}" to confirm removal.`);
  removeRecursivelyPreservingLinks(dir);
  return [line(null, 'change', `removed ~/.claude-profiles/${profile}`, 'profile'), ...lines];
}

// --- doctor ----------------------------------------------------------------

function doctorChecks() {
  const doctor = require('./doctor');
  return doctor.runChecks().map((c) => ({
    group: c.group,
    name: c.name,
    status: c.status,
    message: c.message,
    fixable: Boolean(c.fix && c.fix.apply && c.fix.safe),
    // Has an automatic fix that `doctor --fix` only runs with --force.
    forceable: Boolean(c.fix && c.fix.apply && !c.fix.safe),
    fix: c.fix ? (c.fix.description || null) : null,
    cmd: c.fix ? (c.fix.cmd || null) : null,
  }));
}

// With no name: every safe fix, the same set `cchost doctor --fix` applies.
// With a name: just that check's fix; one that needs confirmation (the CLI's
// --force) runs only when `force` is true, i.e. the user confirmed it.
async function doctorFix({ name, force } = {}, { dryRun }) {
  const doctor = require('./doctor');
  const results = doctor.runChecks();
  let fixable;
  if (name) {
    const target = results.find((r) => r.name === name && r.status !== 'ok');
    if (!target) return [line(null, 'same', `"${name}" no longer needs fixing`, 'doctor')];
    if (!target.fix || !target.fix.apply) throw actionError(`"${name}" has no automatic fix.`);
    if (!target.fix.safe && !force) throw actionError(`"${name}" needs confirmation to fix.`);
    fixable = [target];
  } else {
    fixable = results.filter((r) => r.fix && r.fix.apply && r.fix.safe);
  }
  if (fixable.length === 0) return [line(null, 'same', 'nothing auto-fixable', 'doctor')];
  if (dryRun) return fixable.map((r) => line(null, 'change', `${r.name}: ${r.fix.description || 'fix'}`, 'fix'));
  const out = [];
  await doctor.applyFixes(fixable, Boolean(name && force), async () => 'y', (text) => {
    for (const t of String(text).split('\n')) if (t.trim()) out.push(line(null, 'change', t.trim(), 'fix'));
  });
  return out;
}

// --- mcp / backups -----------------------------------------------------------

function mcpCopy(params, { dryRun }) {
  return mcpLib.copy(params || {}, { dryRun });
}

function mcpRemove(params, { dryRun }) {
  return mcpLib.remove(params || {}, { dryRun });
}

function mcpSync(params, { dryRun }) {
  return mcpLib.sync(params || {}, { dryRun });
}

function restore({ id } = {}, { dryRun }) {
  if (typeof id !== 'string' || !id) throw actionError('id is required');
  const { plan, backup } = backupLib.restore(id, { dryRun });
  const where = (p) => backupLib.shortPath(path.dirname(p)).replace(/^~\/\.claude-profiles\//, '');
  const lines = plan.map((f) => line(null, 'change', f.action === 'restore'
    ? `${dryRun ? 'put back' : 'restored'} ${path.basename(f.path)}`
    : `${dryRun ? 'delete' : 'deleted'} ${path.basename(f.path)} (it did not exist before)`, where(f.path)));
  if (backup) lines.push(line(null, 'info', `the files as they were just now are saved too — undo with: cchost restore ${backup}`, 'backup'));
  return lines;
}

function skillInstall(params, { dryRun }) {
  return require('./agent').install(params || {}, { dryRun });
}

const ACTIONS = {
  link,
  unlink,
  copy,
  add,
  remove,
  'doctor-fix': doctorFix,
  'mcp-copy': mcpCopy,
  'mcp-remove': mcpRemove,
  'mcp-sync': mcpSync,
  restore,
  'skill-install': skillInstall,
};

module.exports = { state, doctorChecks, ACTIONS, RESOURCES, GROUPS, actionError };
