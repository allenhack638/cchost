'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const profiles = require('./profiles');
const share = require('./share');
const copyLib = require('./copy');
const envLib = require('./env');
const { spawnClaude } = require('./spawn');
const { renderTable } = require('./format');
const color = require('./color');
const { renderBanner } = require('./banner');

const HELP = `cc - Multi-profile launcher for Claude Code

Usage:
  cc add <profile> [--custom [...]]                Create a profile (auto-links all 7 resources to ~/.claude/)
  cc use <profile> [...args]                       Launch Claude under a named profile
  cc list [<profile>] [--json] [--reveal]          List profiles, or show one in detail
  cc copy default <profile> [--force]              Copy ~/.claude/ resources into a profile (only when unlinked)
  cc link <p>... [--projects|--tools|--config]     (Re-)link a profile's resources to ~/.claude/
  cc unlink <profile> [--projects|--tools|--config]  Restore a profile's private resources (non-destructive)
  cc remove <profile> [--force]                    Delete a profile and all its data
  cc doctor [--fix [--force]] [--json]             Diagnose environment, storage, and platform issues
  cc help [command]                                Show usage (optionally for a single command)
  cc --version                                     Print the installed cchost version

Shared resources (linked into ~/.claude/ by default):
  --projects   projects/                                 (session history)
  --tools      skills/  agents/  commands/               (user tooling)
  --config     mcp.json  settings.json  CLAUDE.md        (MCP, settings, user memory)

Never shared (stay per-profile):
  .credentials.json  .claude.json  .cc-env.json          (identity / auth)

Profiles live in ~/.claude-profiles/<profile>/ and become CLAUDE_CONFIG_DIR
for that launch. Args after the profile name are forwarded verbatim to claude.
`;

const HELP_BY_CMD = {
  add: `cc add <profile> [--custom [--base-url=URL --token=TOKEN ...]]

Create a new profile directory without launching Claude. All 7 shared
resources (projects/, skills/, agents/, commands/, mcp.json, settings.json,
CLAUDE.md) are auto-linked into ~/.claude/ so they're visible to every
profile (and to bare \`claude\`) from the moment the profile is created.

  cc add <profile>
      Create a regular profile. It logs in with your Anthropic
      subscription (OAuth) on the first 'cc use'.

  cc add <profile> --custom
      Create a profile routed through a custom, Anthropic-compatible API
      endpoint — Moonshot/Kimi, OpenRouter, a self-hosted vLLM, a corporate
      proxy, and so on. Opens an interactive wizard; the API token is never
      echoed to the screen.

  cc add <profile> --custom --base-url=URL --token=TOKEN
                          [--model=NAME] [--opus=NAME] [--sonnet=NAME]
                          [--haiku=NAME] [--subagent=NAME]
      Same, non-interactive. --base-url and --token are required.

Re-running 'cc add <profile> --custom' on an existing endpoint profile EDITS
its configuration. View any profile with 'cc list <profile>'.

Billing: a custom-endpoint profile bills through the third-party provider,
NOT your Anthropic subscription. A profile is born subscription or endpoint
and stays that way.

The endpoint config lives at ~/.claude-profiles/<profile>/.cc-env.json with
user-only permissions. It is never linked and never copied.

Examples:
  cc add work
  cc add kimi --custom
  cc add kimi --custom --base-url=https://api.moonshot.ai/anthropic --token=sk-... --model=kimi-k2.5
`,
  use: `cc use <profile> [...args]

Launch Claude under a named profile. The profile must already exist (create
it with 'cc add <profile>'). Its directory under ~/.claude-profiles/<profile>/
becomes CLAUDE_CONFIG_DIR for the spawned claude — credentials and per-
profile config are isolated; the 7 shared resources are visible via symlinks.

All args after the profile name are forwarded verbatim to claude.

Examples:
  cc use work
  cc use work --resume
  cc use personal -p "summarize this codebase"
`,
  list: `cc list [<profile>] [--json] [--reveal]

Without a profile name: list every profile as a table.

Columns:
  Profile   - profile name
  LoggedIn  - true if .credentials.json exists
  Email     - account email from .claude.json (masked by default; pass
              --reveal to show the full value); - if not yet logged in
  Shared    - N/7 resources linked to ~/.claude/. 7/7 = fully shared (the
              v0.4.1 default), 0/7 = fully private
  Endpoint  - custom-endpoint host from .cc-env.json, or "subscription" if
              the profile uses Anthropic's subscription OAuth

With a profile name: print that one profile's detail, including its custom
endpoint configuration if it has one. The API token is masked by default;
--reveal prints both the token and the full email — do not paste that output
anywhere.

  cc list                            Table of all profiles (emails masked)
  cc list --reveal                   Table with full emails shown
  cc list --json                     Same, as a JSON array (always masked)
  cc list <profile>                  Detail for a single profile
  cc list <profile> --reveal         Detail with the full token + email shown
  cc list <profile> --json           Detail as a JSON object (always masked)
`,
  copy: `cc copy default <profile> [--force]

Copy ~/.claude/ resources into a profile. Useful only when the profile has
'unlinked' one or more resources (private content); for fresh v0.4.1
profiles every resource is symlinked, so 'cc copy' is a no-op.

  <src>:   default  (= ~/.claude/, Claude Code's own config dir)
  <dest>:  <profile-name>

Resources considered (same 7 as everywhere):
  --projects   projects/
  --tools      skills/  agents/  commands/
  --config     mcp.json  settings.json  CLAUDE.md

For each resource:
  - If the destination is shared via symlink/hard-link to the source → skipped
  - Else, copy with skip-on-collision (entries already at the destination win)

--force  Overwrite collisions at the destination instead of skipping.

Examples:
  cc copy default work               # only acts on unlinked resources
  cc copy default work --force       # overwrite collisions

Removed in v0.4: 'shared' as src/dest. The shared pool IS ~/.claude/ in v0.4
and is reached via symlinks. Use 'cc link' / 'cc unlink' to manage sharing.
Note: 'cc migrate' is a deprecated alias for 'cc copy' — it still works but
will be removed in a future version.
`,
  link: `cc link <profile> [<profile>...] [--projects|--tools|--config]

(Re-)link a profile's resources into the shared pool at ~/.claude/. 'cc add'
already does this for new profiles; 'cc link' is for re-applying it after
'cc unlink' or for older profiles that pre-date v0.4.1.

No flag         link all 7 resources
--projects      projects/
--tools         skills/, agents/, commands/
--config        mcp.json, settings.json, CLAUDE.md
(flags can be combined: --tools --config)

Refuses to overwrite private content: if the profile has a non-empty resource
that isn't already a symlink, that resource is reported as 'refused' and left
alone — move or remove it manually, then re-run 'cc link'. The other
resources are still linked.

On Windows, dirs use junctions (no admin/Developer Mode needed). File
symlinks may require Developer Mode; without it, files fall back to hard
links so editing-in-place still propagates between profiles.

Examples:
  cc link work                     # link all 7
  cc link work --tools             # only skills/, agents/, commands/
  cc link work --config            # only mcp.json, settings.json, CLAUDE.md
  cc link a b c                    # link 3 profiles in one shot
`,
  unlink: `cc unlink <profile> [--projects|--tools|--config]

Break the symlinks and copy current ~/.claude/ content into the profile as
private resources. Non-destructive: same-name items already private in the
profile are kept, so re-running unlink is idempotent.

No flag         unlink all 7 resources
--projects      projects/
--tools         skills/, agents/, commands/
--config        mcp.json, settings.json, CLAUDE.md

After unlinking, the profile's resource diverges from ~/.claude/. Other
profiles still see the shared pool.

Examples:
  cc unlink work                   # full private profile
  cc unlink work --config          # only mcp.json / settings.json / CLAUDE.md private
  cc unlink work --tools --config  # skills, agents, commands AND config private
`,
  remove: `cc remove <profile> [--force]

Delete a profile and everything inside its directory: credentials, sessions,
and any private resources. To confirm, you must type the exact profile name —
y/n is intentionally not accepted because credential loss is unrecoverable.

If a profile's resources are symlinks to ~/.claude/, only the symlinks are
removed — the shared content in ~/.claude/ is preserved for other profiles.
If any resource is PRIVATE (unlinked), --force is required because its
content is unique to this profile and will be lost forever.
`,
  doctor: `cc doctor [--fix [--force]] [--json]

Run diagnostic checks across four groups:

  Environment  Node >=18, claude on PATH, claude version, no conflicting env vars
  Storage      ~/.claude-profiles/ writable, .claude.json parseable, every
               profile's 7 resource links present and valid; legacy
               ~/.claude-shared/ folded into ~/.claude/ if still present
  Platform     Windows: OneDrive home, WindowsApps stub, stale ~/bin/cc;
               Git Bash: cygpath
  Sanity       Test-spawn claude --version through the same code path cc use uses

Exit codes: 0 = all ok, 1 = warnings, 2 = errors.

--fix           Auto-apply safe fixes: create missing dirs, recreate broken
                links, backfill missing resource links
--fix --force   Also apply confirmation-required fixes (e.g. reset corrupt
                .claude.json)
--json          Machine-readable output for CI / scripting
`,
  help: `cc help [command]

Without an argument: print the summary of all commands.
With a command name: print detail for just that command.
`,
};

function usageError(msg) {
  const e = new Error(msg);
  e.exitCode = 2;
  return e;
}

function printHelp(cmd) {
  if (cmd && Object.prototype.hasOwnProperty.call(HELP_BY_CMD, cmd)) {
    // Per-command help: no banner, just the detail.
    process.stdout.write(HELP_BY_CMD[cmd]);
    return;
  }
  // Top-level help: banner + summary.
  process.stdout.write(renderBanner());
  process.stdout.write(HELP);
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function isLinkLike(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function removeRecursivelyPreservingLinks(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    try {
      fs.unlinkSync(p);
      return;
    } catch (err) {
      if (process.platform === 'win32') {
        fs.rmdirSync(p);
        return;
      }
      throw err;
    }
  }
  if (st.isDirectory()) {
    for (const ent of fs.readdirSync(p)) {
      removeRecursivelyPreservingLinks(path.join(p, ent));
    }
    fs.rmdirSync(p);
    return;
  }
  fs.unlinkSync(p);
}

function parseFlagsStrict(args, flagNames, { allowPositional = false } = {}) {
  const flags = new Set();
  const positional = [];
  for (const a of args) {
    if (a.startsWith('-')) {
      if (!flagNames.includes(a)) {
        throw usageError(`Unknown flag: ${a}`);
      }
      flags.add(a);
    } else {
      positional.push(a);
    }
  }
  if (!allowPositional && positional.length > 0) {
    throw usageError(`Unexpected argument: ${positional[0]}`);
  }
  return { flags, positional };
}

// Count how many of the 7 shared resources a profile currently has linked
// (symlink OR — on Windows file fallback — hard link).
function countSharedResources(profileDir) {
  let n = 0;
  for (const r of share.SHARED_RESOURCES) {
    if (share.isSharedResource(profileDir, r)) n += 1;
  }
  return n;
}

// Flag name -> .cc-env.json field, for `cc add --custom`.
const ENDPOINT_VALUE_FLAGS = {
  '--base-url': 'base_url',
  '--token': 'auth_token',
  '--model': 'model',
  '--opus': 'opus',
  '--sonnet': 'sonnet',
  '--haiku': 'haiku',
  '--subagent': 'subagent',
};

async function cmdAdd(rest) {
  const positional = [];
  const provided = {};
  let custom = false;

  for (const a of rest) {
    if (a.startsWith('-')) {
      const eq = a.indexOf('=');
      const flagName = eq === -1 ? a : a.slice(0, eq);
      if (flagName === '--custom') {
        custom = true;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(ENDPOINT_VALUE_FLAGS, flagName)) {
        if (eq === -1) {
          throw usageError(`Flag ${flagName} requires a value: ${flagName}=VALUE`);
        }
        provided[ENDPOINT_VALUE_FLAGS[flagName]] = a.slice(eq + 1);
        continue;
      }
      throw usageError(`Unknown flag: ${flagName}`);
    }
    positional.push(a);
  }

  const [name, ...extra] = positional;
  if (!name) {
    throw usageError('Usage: cc add <profile> [--custom [--base-url=URL --token=TOKEN ...]]');
  }
  if (extra.length > 0) throw usageError(`cc add takes no extra arguments: ${extra[0]}`);
  profiles.validateProfileName(name);

  if (Object.keys(provided).length > 0 && !custom) {
    throw usageError(
      'Endpoint flags (--base-url, --token, --model, ...) require --custom: ' +
        `cc add ${name} --custom ...`,
    );
  }

  // Fold any legacy ~/.claude-shared/ pool into ~/.claude/ before any link work.
  runLegacyPoolMigration();

  if (!custom) {
    const { dir } = profiles.addProfile(name);
    console.log(`Created profile "${name}" at ${dir}.`);
    autoLinkArtifacts(name);
    console.log(`Next: cc use ${name}`);
    return 0;
  }

  // Custom endpoint profile.
  const dir = profiles.profileDir(name);
  const existed = fs.existsSync(dir);
  if (!existed) {
    profiles.addProfile(name);
    autoLinkArtifacts(name);
  }

  let result;
  try {
    result = await envLib.runConfigure(name, dir, provided);
  } catch (err) {
    if (!existed) {
      try {
        removeRecursivelyPreservingLinks(dir);
      } catch { /* best-effort */ }
    }
    throw err;
  }

  if (!result.written) {
    if (!existed) {
      try { removeRecursivelyPreservingLinks(dir); } catch { /* best-effort */ }
      console.log(`Cancelled. Profile "${name}" was not created.`);
    } else {
      console.log('Cancelled. No changes written.');
    }
    return result.code;
  }

  if (!existed) console.log(`Next: cc use ${name}`);
  return result.code;
}

// One-time v0.3 → v0.4 migration. Folds ~/.claude-shared/ into ~/.claude/ and
// re-points existing profile symlinks. Quiet when there's no legacy pool.
function runLegacyPoolMigration() {
  let result;
  try {
    result = share.migrateLegacyPool({ log: (line) => console.log(line) });
  } catch (err) {
    process.stderr.write(
      color.stderr.yellow(`  warning: legacy pool migration failed: ${err.message}`) + '\n',
    );
    return;
  }
  if (!result.migrated) return;
  const moved = result.moves.length;
  const relinked = result.relinked.length;
  console.log(
    `Migrated legacy ~/.claude-shared/ into ~/.claude/ ` +
      `(${moved} item(s) moved, ${relinked} profile link(s) repointed).`,
  );
  for (const f of result.failures) {
    process.stderr.write(
      color.stderr.yellow(`  warning: ${JSON.stringify(f)}`) + '\n',
    );
  }
}

// On profile creation, symlink all 7 resources into ~/.claude/. Failures emit
// a warning but do NOT abort cc add — the profile is still usable, and the
// user can re-run `cc link <name>` to retry.
function autoLinkArtifacts(name) {
  let results;
  try {
    results = share.shareLink(name);
  } catch (err) {
    process.stderr.write(
      color.stderr.yellow(
        `  warning: could not link resources for "${name}": ${err.message}`,
      ) + '\n',
    );
    return;
  }
  const failed = results.filter((r) => r.status === 'failed' || r.status === 'refused');
  const linked = results.length - failed.length;
  if (failed.length === 0) {
    console.log(`  Linked ${linked}/${results.length} resources to ~/.claude/.`);
    return;
  }
  console.log(`  Linked ${linked}/${results.length} resources to ~/.claude/.`);
  for (const r of failed) {
    process.stderr.write(
      color.stderr.yellow(`  warning: ${r.resource} not linked — ${r.message}`) + '\n',
    );
  }
  process.stderr.write(
    color.stderr.yellow(
      `  Re-run \`cc link ${name}\` after resolving the above.`,
    ) + '\n',
  );
}

async function cmdUse(rest) {
  const [name, ...passthrough] = rest;
  if (!name) throw usageError('Usage: cc use <profile> [...args]');
  profiles.validateProfileName(name);
  const dir = profiles.profileDir(name);
  if (!fs.existsSync(dir)) {
    const err = new Error(`Profile "${name}" does not exist. Create it with: cc add ${name}`);
    err.exitCode = 1;
    throw err;
  }

  let extraEnv = {};
  const envConfig = envLib.readEnvConfig(dir);
  if (envConfig) {
    extraEnv = envLib.buildEnvVars(envConfig);
    const host = envConfig.base_url ? envLib.hostOf(envConfig.base_url) : '(unknown)';
    process.stderr.write(
      `[cchost] Profile '${name}' → ${host} (custom endpoint billing applies)\n`,
    );
  }
  return spawnClaude({ args: passthrough, profileDir: dir, extraEnv });
}

// `cc list <profile>` — detail for a single profile, including its custom
// endpoint configuration if it has one.
function cmdListOne(name, { json, reveal }) {
  if (json && reveal) {
    throw usageError('--reveal cannot be combined with --json.');
  }
  profiles.validateProfileName(name);
  const dir = profiles.profileDir(name);
  if (!fs.existsSync(dir)) {
    const e = new Error(`Profile "${name}" does not exist. Create it with: cc add ${name}`);
    e.exitCode = 1;
    throw e;
  }

  const total = share.SHARED_RESOURCES.length;
  const sharedCount = countSharedResources(dir);
  const loggedIn = profiles.hasCredentials(dir);
  const email = profiles.readEmail(dir);
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
      email: displayEmail,
      shared: sharedCount,
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
  console.log(`LoggedIn:  ${loggedIn ? 'true' : 'false'}`);
  console.log(`Email:     ${displayEmail || '-'}`);
  console.log(`Shared:    ${sharedCount}/${total}`);

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
  const { flags, positional } = parseFlagsStrict(
    rest,
    ['--json', '--reveal'],
    { allowPositional: true },
  );
  const json = flags.has('--json');
  const reveal = flags.has('--reveal');
  const [name, ...extra] = positional;
  if (extra.length > 0) throw usageError(`Unexpected argument: ${extra[0]}`);

  if (name) {
    return cmdListOne(name, { json, reveal });
  }
  if (json && reveal) {
    throw usageError('--reveal cannot be combined with --json.');
  }

  const list = profiles.listProfiles();
  const total = share.SHARED_RESOURCES.length;

  const enriched = list.map((p) => {
    const sharedCount = countSharedResources(p.dir);
    return {
      name: p.name,
      dir: p.dir,
      loggedIn: p.loggedIn,
      email: reveal ? p.email : (p.email ? envLib.maskEmail(p.email) : p.email),
      shared: sharedCount,
      endpoint: envLib.endpointSummary(p.dir),
    };
  });

  if (json) {
    process.stdout.write(JSON.stringify(enriched, null, 2) + '\n');
    return 0;
  }

  if (enriched.length === 0) {
    console.log(`No profiles yet in ${profiles.baseDir()}.`);
    console.log('Create one with:  cc add <name>');
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
  return 0;
}

// True if the profile has any private (non-shared, non-empty) resource that
// would be permanently lost on remove.
function hasPrivateContent(dir) {
  for (const r of share.SHARED_RESOURCES) {
    const p = path.join(dir, r);
    if (!fs.existsSync(p)) continue;
    if (share.isSharedResource(dir, r)) continue;
    if (share.isFileResource(r)) {
      try {
        if (fs.statSync(p).size > 0) return true;
      } catch { /* skip */ }
    } else {
      try {
        if (fs.readdirSync(p).length > 0) return true;
      } catch { /* skip */ }
    }
  }
  return false;
}

async function cmdRemove(rest) {
  const { flags, positional } = parseFlagsStrict(rest, ['--force'], { allowPositional: true });
  const [name, ...extra] = positional;
  if (!name) throw usageError('Usage: cc remove <profile> [--force]');
  if (extra.length > 0) throw usageError(`Unexpected argument: ${extra[0]}`);
  const force = flags.has('--force');
  profiles.validateProfileName(name);
  const dir = profiles.profileDir(name);
  if (!fs.existsSync(dir)) {
    const err = new Error(`Profile "${name}" does not exist at ${dir}.`);
    err.exitCode = 1;
    throw err;
  }

  if (hasPrivateContent(dir) && !force) {
    const err = new Error(
      `Profile "${name}" has private (unlinked) resources whose content is not ` +
        `in ~/.claude/. Removing the profile will delete that content permanently.\n` +
        `Re-run with --force to confirm: cc remove ${name} --force`,
    );
    err.exitCode = 1;
    throw err;
  }

  console.log('This will permanently delete:');
  console.log(`  ${dir}`);
  console.log('including credentials, sessions, and any private resources.');
  for (const sub of share.SHARED_RESOURCES) {
    const sub_p = path.join(dir, sub);
    if (share.isSharedResource(dir, sub)) {
      console.log(`  (${sub} is shared with ~/.claude/ — only the link will be removed)`);
    }
  }
  const answer = await prompt(`Type the profile name "${name}" to confirm: `);
  if (answer.trim() !== name) {
    console.log('Aborted.');
    return 0;
  }
  try {
    removeRecursivelyPreservingLinks(dir);
  } catch (err) {
    throw new Error(`Failed to fully remove ${dir}: ${err.message}`);
  }
  console.log(`Removed ${dir}.`);
  return 0;
}

async function cmdLink(rest) {
  const { flags, positional } = parseFlagsStrict(
    rest,
    ['--tools', '--projects', '--config'],
    { allowPositional: true },
  );
  if (positional.length === 0) {
    throw usageError(
      'Usage: cc link <profile> [<profile>...] [--projects|--tools|--config]',
    );
  }
  const opts = {
    tools: flags.has('--tools'),
    projects: flags.has('--projects'),
    config: flags.has('--config'),
  };
  const multi = positional.length > 1;
  const summary = [];
  for (const name of positional) {
    if (multi) console.log(`\n[${name}]`);
    let results;
    try {
      results = share.shareLink(name, opts);
    } catch (err) {
      process.stderr.write(color.stderr.red(`  error: ${err.message}`) + '\n');
      summary.push({ name, linked: 0, total: 0, error: err.message });
      continue;
    }
    for (const r of results) {
      const label = share.isFileResource(r.resource) ? r.resource : `${r.resource}/`;
      if (r.status === 'failed') {
        process.stderr.write(color.stderr.red(`  ${label}: failed — ${r.message}`) + '\n');
      } else if (r.status === 'refused') {
        process.stderr.write(color.stderr.yellow(`  ${label}: refused — ${r.message}`) + '\n');
      } else if (r.status === 'already-linked') {
        console.log(`  ${label}: already linked`);
      } else if (r.relinkedFromLegacy) {
        console.log(`  ${label}: relinked (was pointing at legacy ~/.claude-shared/)`);
      } else {
        const note = r.kind === 'hardlink' ? ' (hard link — enable Windows Developer Mode for a true symlink)' : '';
        console.log(`  ${label}: linked${note}`);
      }
    }
    const failed = results.filter((r) => r.status === 'failed' || r.status === 'refused');
    const linked = results.length - failed.length;
    console.log(
      `  ${linked}/${results.length} linked` +
        (failed.length ? `, ${failed.length} not linked` : '') + '.',
    );
    summary.push({
      name,
      linked,
      total: results.length,
      failed: failed.map((f) => f.resource),
    });
  }

  const anyFailure = summary.some((s) => s.error || (s.failed && s.failed.length));
  if (multi) {
    console.log('\nSummary:');
    for (const s of summary) {
      if (s.error) {
        console.log(`  ${s.name}: error — ${s.error}`);
      } else if (s.failed && s.failed.length) {
        console.log(`  ${s.name}: ${s.linked}/${s.total} linked (not linked: ${s.failed.join(', ')})`);
      } else {
        console.log(`  ${s.name}: ${s.linked}/${s.total} linked`);
      }
    }
  }
  return anyFailure ? 1 : 0;
}

async function cmdUnlink(rest) {
  const { flags, positional } = parseFlagsStrict(
    rest,
    ['--tools', '--projects', '--config'],
    { allowPositional: true },
  );
  const [name, ...extra] = positional;
  if (!name) {
    throw usageError('Usage: cc unlink <profile> [--projects|--tools|--config]');
  }
  if (extra.length > 0) throw usageError(`Unexpected argument: ${extra[0]}`);
  const opts = {
    tools: flags.has('--tools'),
    projects: flags.has('--projects'),
    config: flags.has('--config'),
  };
  const results = share.shareUnlink(name, opts);
  let anyFailure = false;
  for (const r of results) {
    const label = share.isFileResource(r.resource) ? r.resource : `${r.resource}/`;
    if (r.status === 'failed') {
      anyFailure = true;
      process.stderr.write(color.stderr.red(`  ${label}: failed — ${r.message}`) + '\n');
    } else if (r.status === 'not-linked') {
      console.log(`  ${label}: not linked, skipping`);
    } else {
      console.log(`  ${label}: unlinked, content copied back`);
    }
  }
  return anyFailure ? 1 : 0;
}

async function cmdDoctor(rest) {
  const { flags } = parseFlagsStrict(rest, ['--fix', '--force', '--json']);
  const fix = flags.has('--fix');
  const force = flags.has('--force');
  if (force && !fix) throw usageError('--force requires --fix');
  const json = flags.has('--json');
  const doctor = require('./doctor');
  return doctor.runDoctor({ fix, force, json, prompt });
}

async function cmdCopy(rest) {
  const { flags, positional } = parseFlagsStrict(rest, ['--force'], { allowPositional: true });
  const [src, dest, ...extra] = positional;
  if (!src || !dest) throw usageError('Usage: cc copy <src> <dest> [--force]');
  if (extra.length > 0) throw usageError(`Unexpected extra arguments: ${extra.join(' ')}`);
  const force = flags.has('--force');
  if (force) {
    process.stdout.write(
      'Warning: --force is set. Existing items at the destination will be overwritten.\n',
    );
  }
  copyLib.copy(src, dest, { force });
  return 0;
}

async function cmdMigrate(rest) {
  process.stderr.write(
    color.stderr.yellow(
      "[cchost] 'cc migrate' is deprecated — use 'cc copy' instead. " +
        'This alias will be removed in a future version.',
    ) + '\n',
  );
  return cmdCopy(rest);
}

async function run(argv) {
  const [action, ...rest] = argv;
  if (!action || action === '--help' || action === '-h') {
    printHelp();
    return 0;
  }
  if (action === '--version' || action === '-v') {
    const { version } = require('../package.json');
    process.stdout.write(version + '\n');
    return 0;
  }
  if (action === 'help') {
    printHelp(rest[0]);
    return 0;
  }
  if (action === 'env') {
    process.stderr.write(
      color.stderr.red(
        "'cc env' was removed in v0.3.1. Configure a custom endpoint with " +
          "'cc add <profile> --custom', and view it with 'cc list <profile>'.",
      ) + '\n',
    );
    return 2;
  }
  switch (action) {
    case 'add':
      return await cmdAdd(rest);
    case 'use':
      return await cmdUse(rest);
    case 'list':
      return cmdList(rest);
    case 'copy':
      return await cmdCopy(rest);
    case 'migrate':
      return await cmdMigrate(rest);
    case 'link':
      return await cmdLink(rest);
    case 'unlink':
      return await cmdUnlink(rest);
    case 'remove':
      return await cmdRemove(rest);
    case 'doctor':
      return await cmdDoctor(rest);
    default: {
      process.stderr.write(color.stderr.red(`Unknown command: ${action}`) + '\n\n');
      printHelp();
      return 2;
    }
  }
}

module.exports = { run, printHelp, removeRecursivelyPreservingLinks };
