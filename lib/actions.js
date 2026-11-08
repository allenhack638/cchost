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
  const dir = profiles.profileDir(name);
  if (!fs.existsSync(dir)) throw actionError(`Profile "${name}" does not exist.`, 404);
  return dir;
}

function profileSummary(p) {
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

function state() {
  return {
    update: updateLib.available(),
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
  return results.map((r) => {
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
  });
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

function add({ name, private: privateGroups, endpoint }, { dryRun }) {
  if (typeof name !== 'string' || !name) throw actionError('name is required');
  profiles.validateProfileName(name);
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
    if (!config.base_url || !config.auth_token) {
      throw actionError('An endpoint profile needs both a base URL and a token.');
    }
    const warnings = [];
    for (const [key, value] of Object.entries(config)) envLib.validateField(key, value, (m) => warnings.push(m));
  }

  const lines = [line(null, 'change', `${dryRun ? 'create' : 'created'} ~/.claude-profiles/${name}`, 'profile')];
  if (config) {
    lines.push(line(null, 'change', `${dryRun ? 'use' : 'uses'} ${envLib.hostOf(config.base_url)} (token stored user-only)`, 'endpoint'));
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
  } catch (err) {
    // Same as the CLI: a half-created profile is removed, shared content kept.
    try {
      require('./cli').removeRecursivelyPreservingLinks(dir);
    } catch { /* best effort */ }
    throw err;
  }
  return lines;
}

// --- remove ----------------------------------------------------------------

function remove({ profile, confirm }, { dryRun }) {
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
  require('./cli').removeRecursivelyPreservingLinks(dir);
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

const ACTIONS = { link, unlink, copy, add, remove, 'doctor-fix': doctorFix };

module.exports = { state, doctorChecks, ACTIONS, RESOURCES, GROUPS, actionError };
