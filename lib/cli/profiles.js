'use strict';

// Profile commands: add, list, link, unlink, copy, remove, token.

const fs = require('fs');

const profiles = require('../profiles');
const share = require('../share');
const envLib = require('../env');
const { hasPrivateContent } = require('../fsutil');
const actions = require('../actions');
const { renderTable } = require('../format');
const color = require('../color');
const errors = require('../errors');
const { parseArgs, printLines, linesOk, runAction, prompt, requireTerminal, readStdin } = require('./term');

function groupsFrom(flags) {
  return ['projects', 'tools', 'config'].filter((g) => flags.has(`--${g}`));
}

function resourceLabel(resource) {
  return share.isFileResource(resource) ? resource : `${resource}/`;
}

// One-line explanation per resource state for `cchost list <profile>`.
const RESOURCE_STATE_NOTES = {
  private: 'only this profile sees it',
  empty: 'private, but empty',
  missing: 'not present; cchost link would share it',
  'foreign-link': 'points outside ~/.claude/; cchost leaves it alone',
};

// How many of the 7 shared resources are linked (symlink, or hard link on Windows).
function countSharedResources(profileDir) {
  let n = 0;
  for (const r of share.SHARED_RESOURCES) {
    if (share.isSharedResource(profileDir, r)) n += 1;
  }
  return n;
}

// Flag name -> .cc-env.json field, for `cchost add --custom`.
const ENDPOINT_VALUE_FLAGS = {
  '--base-url': 'base_url',
  '--token': 'auth_token',
  '--model': 'model',
  '--opus': 'opus',
  '--sonnet': 'sonnet',
  '--haiku': 'haiku',
  '--subagent': 'subagent',
};

// `--private` → all groups; `--private=projects,tools,config` → those groups.
// Returns the share.resolveSubset() options for the private groups.
const PRIVATE_GROUPS = ['projects', 'tools', 'config'];

function parsePrivateFlag(value) {
  if (value === null) return { projects: true, tools: true, config: true };
  const groups = value.split(',').map((g) => g.trim()).filter(Boolean);
  if (groups.length === 0) {
    throw errors.usage(`--private= needs at least one of: ${PRIVATE_GROUPS.join(', ')}`);
  }
  const opts = {};
  for (const g of groups) {
    if (!PRIVATE_GROUPS.includes(g)) {
      throw errors.usage(`Unknown --private group "${g}". Use: ${PRIVATE_GROUPS.join(', ')}`);
    }
    opts[g] = true;
  }
  return opts;
}

async function cmdAdd(rest) {
  const { flags, values, positional } = parseArgs(rest, {
    flags: ['--existing', '--json', '--dry-run', '--custom', '--private'],
    values: ['--private', ...Object.keys(ENDPOINT_VALUE_FLAGS)],
  });
  const [name, ...extra] = positional;
  if (!name) throw errors.usage('Usage: cchost add <profile> [--existing] [--private[=projects,tools,config]] [--custom [--base-url=URL ...]] [--dry-run] [--json]');
  if (extra.length > 0) throw errors.usage(`cchost add takes no extra arguments: ${extra[0]}`);
  profiles.validateProfileName(name);
  const json = flags.has('--json');
  const dryRun = flags.has('--dry-run');
  const custom = flags.has('--custom');
  const privateOpts = flags.has('--private') || values['--private'] ? parsePrivateFlag(values['--private'] ?? null) : null;
  const provided = {};
  for (const [flag, field] of Object.entries(ENDPOINT_VALUE_FLAGS)) if (values[flag] !== undefined) provided[field] = values[flag];

  if (Object.keys(provided).length > 0 && !custom) {
    throw errors.usage(`Endpoint flags (--base-url, --token, --model, ...) require --custom: cchost add ${name} --custom ...`);
  }
  if (flags.has('--existing')) {
    if (custom || privateOpts) throw errors.usage('--existing names your current account; it takes no --custom or --private.');
    return runAction('add', { name, existing: true }, { dryRun, json });
  }
  if (provided.auth_token) {
    process.stderr.write(color.stderr.yellow(`[cchost] note: a token passed as --token stays in your shell history. Next time use: cchost token ${name}`) + '\n');
  }
  const dir = profiles.profileDir(name);
  if (custom && fs.existsSync(dir)) {
    if (privateOpts) throw errors.usage(`--private only applies when creating a profile; "${name}" already exists. Use: cchost unlink ${name} [--projects|--tools|--config]`);
    return (await envLib.runConfigure(name, dir, provided)).code;
  }
  let endpoint;
  if (custom) {
    endpoint = provided;
    if (!provided.base_url) {
      if (json || dryRun) throw errors.usage('--json/--dry-run with --custom needs --base-url=URL (the token can be set later with: cchost token <profile>).');
      if (Object.keys(provided).length > 0) throw errors.usage('Creating an endpoint profile requires --base-url.');
      endpoint = await envLib.askEndpoint(name);
      if (!endpoint) {
        console.log(`Cancelled. Profile "${name}" was not created.`);
        return 0;
      }
    }
  }
  const code = await runAction('add', { name, private: privateOpts ? Object.keys(privateOpts) : [], endpoint }, { dryRun, json });
  if (code === 0 && !json && !dryRun) console.log(`\nNext: cchost use ${name}`);
  return code;
}

// `cchost list <profile>`: one profile's detail, including any custom endpoint.
function cmdListOne(name, { json, reveal }) {
  if (json && reveal) {
    throw errors.usage('--reveal cannot be combined with --json.');
  }
  if (reveal) requireTerminal('--reveal');
  profiles.validateProfileName(name);
  const dir = profiles.profileDir(name);
  if (!fs.existsSync(dir) && profiles.isAlias(name)) {
    const acct = profiles.readDefaultAccount();
    const email = reveal ? acct.email : (acct.email ? envLib.maskEmail(acct.email) : '');
    if (json) {
      process.stdout.write(`${JSON.stringify({ name, existingAccount: true, dir: profiles.defaultClaudeDir(), loggedIn: acct.loggedIn, credentialSource: acct.credentialSource, email, shared: share.SHARED_RESOURCES.length, endpoint: 'subscription' }, null, 2)}\n`);
      return 0;
    }
    console.log(`Profile:   ${name} (your existing account, plain \`claude\`)`);
    console.log(`Directory: ${profiles.defaultClaudeDir()} (the shared pool itself)`);
    console.log(`Logged in: ${acct.loggedIn}${email ? ` (${email})` : ''}`);
    console.log('Endpoint:  subscription');
    return 0;
  }
  if (!fs.existsSync(dir)) {
    throw errors.refused(`Profile "${name}" does not exist. Create it with: cchost add ${name}`);
  }

  const total = share.SHARED_RESOURCES.length;
  const resources = {};
  for (const r of share.SHARED_RESOURCES) resources[r] = share.resourceState(dir, r);
  const sharedCount = Object.values(resources).filter((st) => st === 'shared').length;
  const read = profiles.readProfile(dir);
  const token = endpointToken(dir);
  const { email } = read;
  const loggedIn = token === null ? read.loggedIn : token;
  const credentialSource = token === null ? read.credentialSource : (token ? 'token' : 'none');
  const displayEmail = reveal ? email : (email ? envLib.maskEmail(email) : email);

  let config = null;
  let configError = false;
  try {
    config = envLib.readEnvConfig(dir);
  } catch {
    configError = true;
  }

  if (json) {
    const obj = {
      name,
      dir,
      loggedIn,
      credentialSource,
      email: displayEmail,
      shared: sharedCount,
      resources,
      endpoint: envLib.endpointSummary(dir),
    };
    if (config) {
      obj.endpointConfig = {
        base_url: config.base_url || null,
        auth_token: config.auth_token ? envLib.maskToken(config.auth_token) : null,
        model: config.model || null,
        opus: config.opus || config.model || null,
        sonnet: config.sonnet || config.model || null,
        haiku: config.haiku || config.model || null,
        subagent: config.subagent || config.model || null,
      };
    }
    process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
    return 0;
  }

  console.log(`Profile:   ${name}`);
  console.log(`Directory: ${dir}`);
  console.log(
    `LoggedIn:  ${loggedIn ? 'true' : 'false'}` +
      (credentialSource === 'keychain' ? ' (macOS Keychain)' : ''),
  );
  console.log(`Email:     ${displayEmail || '-'}`);
  console.log(`Shared:    ${sharedCount}/${total}`);
  const width = Math.max(...share.SHARED_RESOURCES.map((r) => resourceLabel(r).length));
  for (const r of share.SHARED_RESOURCES) {
    const st = resources[r];
    const note = st === 'shared' ? `→ ~/.claude/${r}` : (RESOURCE_STATE_NOTES[st] || '');
    console.log(`  ${resourceLabel(r).padEnd(width)}  ${st.padEnd(12)} ${note}`.trimEnd());
  }

  if (configError) {
    console.log('Endpoint:  (invalid config — .cc-env.json is malformed)');
    return 0;
  }
  if (!config) {
    console.log('Endpoint:  subscription');
    return 0;
  }

  console.log(
    `Endpoint:  ${config.base_url ? envLib.hostOf(config.base_url) : '(invalid config)'}`,
  );
  console.log(`  Base URL:  ${config.base_url || '-'}`);
  if (reveal) {
    console.log(`  Token:     ${config.auth_token || '-'}`);
  } else {
    console.log(`  Token:     ${config.auth_token ? envLib.maskToken(config.auth_token) : '-'}`);
  }
  console.log(`  Model:     ${config.model || '-'}`);
  console.log(`  Opus:      ${config.opus || config.model || '-'}`);
  console.log(`  Sonnet:    ${config.sonnet || config.model || '-'}`);
  console.log(`  Haiku:     ${config.haiku || config.model || '-'}`);
  console.log(`  Subagent:  ${config.subagent || config.model || '-'}`);
  if (reveal) {
    console.log('');
    console.log('WARNING: the full API key and email are printed above. Do not paste this');
    console.log('output into chats, issues, screenshots, or logs.');
  }
  return 0;
}

function cmdList(rest) {
  const { flags, positional } = parseArgs(rest, { flags: ['--json', '--reveal'] });
  const json = flags.has('--json');
  const reveal = flags.has('--reveal');
  const [name, ...extra] = positional;
  if (extra.length > 0) throw errors.usage(`Unexpected argument: ${extra[0]}`);

  if (name) {
    return cmdListOne(name, { json, reveal });
  }
  if (json && reveal) {
    throw errors.usage('--reveal cannot be combined with --json.');
  }
  if (reveal) requireTerminal('--reveal');

  const list = profiles.listProfiles();
  const total = share.SHARED_RESOURCES.length;

  const enriched = list.map((p) => {
    const sharedCount = p.alias ? share.SHARED_RESOURCES.length : countSharedResources(p.dir);
    const token = p.alias ? null : endpointToken(p.dir);
    return {
      name: p.alias ? `${p.name}*` : p.name,
      existingAccount: Boolean(p.alias),
      dir: p.dir,
      loggedIn: token === null ? p.loggedIn : token,
      credentialSource: token === null ? p.credentialSource : (token ? 'token' : 'none'),
      email: reveal ? p.email : (p.email ? envLib.maskEmail(p.email) : p.email),
      shared: sharedCount,
      endpoint: p.alias ? 'subscription' : envLib.endpointSummary(p.dir),
    };
  });
  if (json) for (const e of enriched) e.name = e.name.replace(/\*$/, '');

  if (json) {
    process.stdout.write(JSON.stringify(enriched, null, 2) + '\n');
    return 0;
  }

  if (enriched.length === 0) {
    console.log(`No profiles yet in ${profiles.baseDir()}.`);
    console.log('Create one with:  cchost add <name>');
    return 0;
  }

  const rows = [['Profile', 'LoggedIn', 'Email', 'Shared', 'Endpoint']];
  for (const p of enriched) {
    rows.push([
      p.name,
      p.loggedIn ? 'true' : 'false',
      p.email ? p.email : '-',
      `${p.shared}/${total}`,
      p.endpoint,
    ]);
  }
  console.log(renderTable(rows));
  if (enriched.some((p) => p.existingAccount)) console.log('* your existing account (~/.claude, plain `claude`)');
  return 0;
}

// Endpoint profiles are "logged in" once their token is set. Null: not an endpoint profile.
function endpointToken(dir) {
  try {
    const cfg = envLib.readEnvConfig(dir);
    return cfg ? Boolean(cfg.auth_token) : null;
  } catch {
    return null;
  }
}

async function cmdRemove(rest) {
  const { flags, positional } = parseArgs(rest, { flags: ['--force', '--yes', '--dry-run', '--json'] });
  const [name, ...extra] = positional;
  if (!name) throw errors.usage('Usage: cchost remove <profile> [--force] [--yes] [--dry-run] [--json]');
  if (extra.length > 0) throw errors.usage(`Unexpected argument: ${extra[0]}`);
  const dryRun = flags.has('--dry-run');
  const json = flags.has('--json');
  profiles.validateProfileName(name);
  const dir = profiles.profileDir(name);
  if (!dryRun && fs.existsSync(dir) && hasPrivateContent(dir) && !flags.has('--force')) {
    throw errors.refused(`Profile "${name}" has private (unlinked) resources whose content is not in ~/.claude/. ` +
      `Removing the profile will delete that content permanently.\nRe-run with --force to confirm: cchost remove ${name} --force`);
  }
  if (dryRun) return runAction('remove', { profile: name }, { dryRun, json });
  if (!flags.has('--yes')) {
    if (!process.stdin.isTTY) throw errors.usage(`Removing "${name}" needs confirmation. Ask the user, then re-run with --yes.`);
    if (!json) {
      console.log('This will:');
      printLines(await actions.ACTIONS.remove({ profile: name }, { dryRun: true }));
    }
    const answer = await prompt(`Type the profile name "${name}" to confirm: `);
    if (answer.trim() !== name) {
      console.log('Aborted.');
      return 0;
    }
  }
  return runAction('remove', { profile: name, confirm: name }, { json });
}

async function cmdLink(rest) {
  const { flags, positional } = parseArgs(rest, { flags: ['--tools', '--projects', '--config', '--dry-run', '--backup', '--json'] });
  if (positional.length === 0) {
    throw errors.usage('Usage: cchost link <profile> [<profile>...] [--projects|--tools|--config] [--backup] [--dry-run] [--json]');
  }
  const json = flags.has('--json');
  if (json && positional.length !== 1) throw errors.usage('--json takes one profile at a time.');
  const params = { groups: groupsFrom(flags), backup: flags.has('--backup') };
  const dryRun = flags.has('--dry-run');
  if (json) return runAction('link', { ...params, profile: positional[0] }, { dryRun, json });

  if (dryRun) console.log('Dry run — nothing will be changed.');
  let code = 0;
  let refused = false;
  for (const name of positional) {
    if (positional.length > 1) console.log(`\n[${name}]`);
    try {
      const lines = await actions.ACTIONS.link({ ...params, profile: name }, { dryRun });
      printLines(lines);
      if (!linesOk(lines)) code = 1;
      refused = refused || lines.some((l) => l.code === 'private-content');
    } catch (err) {
      if (positional.length === 1) throw err;
      process.stderr.write(color.stderr.red(`  error: ${err.message}`) + '\n');
      code = 1;
    }
  }
  if (refused && !params.backup) console.log('\nTo share a profile\'s own copy anyway, add --backup: it is kept as <name>.cchost-backup-<time>.');
  return code;
}

async function cmdUnlink(rest) {
  const { flags, positional } = parseArgs(rest, { flags: ['--tools', '--projects', '--config', '--dry-run', '--json'] });
  const [name, ...extra] = positional;
  if (!name) throw errors.usage('Usage: cchost unlink <profile> [--projects|--tools|--config] [--dry-run] [--json]');
  if (extra.length > 0) throw errors.usage(`Unexpected argument: ${extra[0]}`);
  return runAction('unlink', { profile: name, groups: groupsFrom(flags) }, { dryRun: flags.has('--dry-run'), json: flags.has('--json') });
}

async function cmdCopy(rest) {
  const { flags, positional } = parseArgs(rest, { flags: ['--force', '--dry-run', '--json'] });
  const [src, dest, ...extra] = positional;
  if (!src || !dest) throw errors.usage('Usage: cchost copy default <profile> [--force] [--dry-run] [--json]');
  if (extra.length > 0) throw errors.usage(`Unexpected extra arguments: ${extra.join(' ')}`);
  const force = flags.has('--force');
  const dryRun = flags.has('--dry-run');
  const json = flags.has('--json');
  if (force && !json) console.log(`--force: items already in "${dest}" ${dryRun ? 'would' : 'will'} be overwritten.`);
  return runAction('copy', { from: src, profile: dest, force }, { dryRun, json });
}

async function cmdMigrate(rest) {
  process.stderr.write(
    color.stderr.yellow(
      "[cchost] 'cchost migrate' is deprecated — use 'cchost copy' instead. " +
        'This alias will be removed in a future version.',
    ) + '\n',
  );
  return cmdCopy(rest);
}

async function cmdToken(rest) {
  const { flags, positional } = parseArgs(rest, { flags: ['--stdin'] });
  const [name, ...extra] = positional;
  if (!name || extra.length) throw errors.usage('Usage: cchost token <profile> [--stdin]');
  const p = profiles.resolveProfile(name);
  if (p.alias || !envLib.hasEnvConfig(p.dir)) {
    throw Object.assign(new Error(`"${name}" is not a custom-endpoint profile; it logs in with /login instead.`), { exitCode: 1 });
  }
  let token;
  if (flags.has('--stdin')) {
    token = await readStdin();
  } else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw errors.usage(`Setting a token needs a person at a terminal. Ask the user to run: cchost token ${name}`);
    }
    token = (await envLib.defaultWizardIo().readHidden(`Token for ${name} (input hidden): `)).trim();
  }
  if (!token) throw errors.usage('No token given; nothing changed.');
  envLib.validateField('auth_token', token, (m) => process.stderr.write(`${m}\n`));
  const cfg = envLib.readEnvConfig(p.dir) || {};
  envLib.writeEnvConfig(p.dir, { ...cfg, auth_token: token });
  process.stdout.write(`Token saved for "${name}" (readable by you only).\n`);
  return 0;
}

module.exports = { cmdAdd, cmdList, cmdRemove, cmdLink, cmdUnlink, cmdCopy, cmdMigrate, cmdToken };
