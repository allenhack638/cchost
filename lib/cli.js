'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const profiles = require('./profiles');
const share = require('./share');
const copyLib = require('./copy');
const envLib = require('./env');
const { spawnClaude } = require('./spawn');
const { removeRecursivelyPreservingLinks, hasPrivateContent } = require('./fsutil');
const commands = require('./commands');
const { renderTable } = require('./format');
const color = require('./color');
const { renderBanner } = require('./banner');

const HELP = `cchost - Multi-profile launcher for Claude Code

AI agents: run \`cchost agent\` for a guide written for you.

Installed as both 'cchost' (preferred) and 'cc' (legacy alias). 'cc' is also
the C compiler on macOS and Linux: when 'cc' is called with anything other than
a cchost command (e.g. 'cc -c foo.c', 'cc --version'), it runs the real
compiler further down PATH. Use 'cchost' in scripts.

Usage:
  cchost status [--json]                               Everything at a glance, with suggested next steps
  cchost add <profile> [--private] [--custom [...]]    Create a profile (shares all 7 resources, or --private ones)
  cchost add <name> --existing                         Name the account you already use (plain \`claude\`)
  cchost use <profile> [...args]                       Launch Claude under a named profile
  cchost list [<profile>] [--json] [--reveal]          List profiles, or show one in detail
  cchost copy default <profile> [--force] [--dry-run]  Copy ~/.claude/ resources into a profile (only when unlinked)
  cchost link <p>... [--projects|--tools|--config]     (Re-)link a profile's resources to ~/.claude/
  cchost unlink <profile> [--projects|--tools|--config]  Restore a profile's private resources (non-destructive)
  cchost remove <profile> [--force]                    Delete a profile and all its data
  cchost doctor [--fix [--force]] [--json]             Diagnose environment, storage, and platform issues
  cchost mcp list|copy|remove|sync ...                 MCP servers across profiles (cchost help mcp)
  cchost token <profile>                               Set a custom endpoint's token (hidden input)
  cchost backups | restore <id> [--dry-run]            List and undo cchost's changes to config files
  cchost ui [--port=N] [--no-open] [--session=8h]      Open the web view (prints a sign-in password, like rclone)
  cchost agent [topic]                                 Guides for AI agents driving cchost
  cchost skill install [--dry-run]                     Install the cchost skills for Claude Code
  cchost help [command]                                Show usage (optionally for a single command)
  cchost help sharing                                  Task guide: what is shared, and how to change it
  cchost --version                                     Print the installed cchost version

Shared resources (linked into ~/.claude/ by default):
  --projects   projects/                                 (session history)
  --tools      skills/  agents/  commands/               (user tooling)
  --config     mcp.json  settings.json  CLAUDE.md        (MCP, settings, user memory)

Never shared (stay per-profile):
  .credentials.json  .claude.json  .cc-env.json          (identity / auth)

Every command that changes something accepts --dry-run (preview, change
nothing) and --json (machine-readable). Exit codes: 0 ok, 1 refused or
failed, 2 bad usage.

Profiles live in ~/.claude-profiles/<profile>/ and become CLAUDE_CONFIG_DIR
for that launch. Args after the profile name are forwarded verbatim to claude.
`;

const HELP_BY_CMD = {
  add: `cchost add <profile> [--private[=projects,tools,config]] [--custom [--base-url=URL ...]] [--dry-run] [--json]
       cchost add <name> --existing [--dry-run] [--json]

Create a new profile directory without launching Claude. All 7 shared
resources (projects/, skills/, agents/, commands/, mcp.json, settings.json,
CLAUDE.md) are auto-linked into ~/.claude/ so they're visible to every
profile (and to bare \`claude\`) from the moment the profile is created.

  cchost add <profile>
      Create a regular profile. It logs in with your Anthropic
      subscription (OAuth) on the first 'cchost use'.

  cchost add <profile> --private
  cchost add <profile> --private=projects,config
      Start some or all resources private and empty instead of shared:
      nothing from ~/.claude/ is copied in, and nothing this profile writes
      there is seen by other profiles. Groups: projects (session history),
      tools (skills/agents/commands), config (mcp.json/settings.json/CLAUDE.md).
      Combine with --custom for an isolated endpoint profile. Share a group
      later with 'cchost link <profile> --<group>'.

  cchost add <profile> --custom
      Create a profile routed through a custom, Anthropic-compatible API
      endpoint — Moonshot/Kimi, OpenRouter, a self-hosted vLLM, a corporate
      proxy, and so on. Opens an interactive wizard; the API token is never
      echoed to the screen.

  cchost add <profile> --custom --base-url=URL --token=TOKEN
                          [--model=NAME] [--opus=NAME] [--sonnet=NAME]
                          [--haiku=NAME] [--subagent=NAME]
      Same, non-interactive. Without --token the profile is created with
      the token still unset; set it with 'cchost token <profile>' (hidden
      input). Tokens given as --token stay in your shell history.

  cchost add <name> --existing
      Give the account you already use with plain \`claude\` (~/.claude) a
      name, so 'cchost use <name>' runs it. Nothing is moved, copied or
      logged out; plain \`claude\` keeps working. 'cchost remove <name>' only
      forgets the name.

Re-running 'cchost add <profile> --custom' on an existing endpoint profile EDITS
its configuration. View any profile with 'cchost list <profile>'.

Billing: a custom-endpoint profile bills through the third-party provider,
NOT your Anthropic subscription. A profile is born subscription or endpoint
and stays that way.

The endpoint config lives at ~/.claude-profiles/<profile>/.cc-env.json with
user-only permissions. It is never linked and never copied.

Examples:
  cchost add personal --existing
  cchost add work
  cchost add work --dry-run --json
  cchost add client --private=projects,config
  cchost add kimi --custom
  cchost add kimi --custom --base-url=https://api.moonshot.ai/anthropic --token=sk-... --model=kimi-k2.5
`,
  use: `cchost use <profile> [...args]

Launch Claude under a named profile. The profile must already exist (create
it with 'cchost add <profile>'). Its directory under ~/.claude-profiles/<profile>/
becomes CLAUDE_CONFIG_DIR for the spawned claude — credentials and per-
profile config are isolated; the 7 shared resources are visible via symlinks.

All args after the profile name are forwarded verbatim to claude.

Examples:
  cchost use work
  cchost use work --resume
  cchost use personal -p "summarize this codebase"
`,
  list: `cchost list [<profile>] [--json] [--reveal]

Without a profile name: list every profile as a table.

Columns:
  Profile   - profile name
  LoggedIn  - true if credentials are present. On macOS the token lives in the
              login Keychain and the login is inferred from .claude.json.
  Email     - account email from .claude.json (masked by default; pass
              --reveal to show the full value); - if not yet logged in
  Shared    - N/7 resources linked to ~/.claude/. 7/7 = fully shared (the
              v0.4.1 default), 0/7 = fully private
  Endpoint  - custom-endpoint host from .cc-env.json, or "subscription" if
              the profile uses Anthropic's subscription OAuth

With a profile name: print that one profile's detail: the state of each of
the 7 resources (shared, private, empty, missing, or foreign-link) and its
custom endpoint configuration if it has one. The API token is masked by default;
--reveal prints both the token and the full email — do not paste that output
anywhere.

  cchost list                            Table of all profiles (emails masked)
  cchost list --reveal                   Table with full emails shown
  cchost list --json                     Same, as a JSON array (always masked)
  cchost list <profile>                  Detail for a single profile
  cchost list <profile> --reveal         Detail with the full token + email shown
  cchost list <profile> --json           Detail as a JSON object (always masked)
`,
  copy: `cchost copy default <profile> [--force] [--dry-run]

Copy ~/.claude/ resources into a profile. Useful only when the profile has
'unlinked' one or more resources (private content); for fresh v0.4.1
profiles every resource is symlinked, so 'cchost copy' is a no-op.

  <src>:   default  (= ~/.claude/, Claude Code's own config dir)
  <dest>:  <profile-name>

Resources considered (same 7 as everywhere):
  --projects   projects/
  --tools      skills/  agents/  commands/
  --config     mcp.json  settings.json  CLAUDE.md

For each resource:
  - If the destination is shared via symlink/hard-link to the source → skipped
  - Else, copy with skip-on-collision (entries already at the destination win)

--force    Overwrite collisions at the destination instead of skipping.
--dry-run  Print what would be copied, skipped, or overwritten; change nothing.

Examples:
  cchost copy default work --dry-run     # preview first
  cchost copy default work               # only acts on unlinked resources
  cchost copy default work --force       # overwrite collisions

Removed in v0.4: 'shared' as src/dest. The shared pool IS ~/.claude/ in v0.4
and is reached via symlinks. Use 'cchost link' / 'cchost unlink' to manage sharing.
Note: 'cchost migrate' is a deprecated alias for 'cchost copy' — it still works but
will be removed in a future version.
`,
  migrate: `cchost migrate <src> <dest> [--force]

Deprecated alias for 'cchost copy'. It prints a deprecation warning and
forwards its arguments. Use 'cchost copy' instead; this alias will be removed
in a future version.

Examples:
  cchost migrate default work
`,
  link: `cchost link <profile> [<profile>...] [--projects|--tools|--config] [--dry-run]

(Re-)link a profile's resources into the shared pool at ~/.claude/. 'cchost add'
already does this for new profiles; 'cchost link' is for re-applying it after
'cchost unlink' or for older profiles that pre-date v0.4.1.

No flag         link all 7 resources
--projects      projects/
--tools         skills/, agents/, commands/
--config        mcp.json, settings.json, CLAUDE.md
(flags can be combined: --tools --config)
--backup        share resources that have private content: rename the
                profile's copy to <name>.cchost-backup-<time>, then link
--dry-run       print what would be linked or refused; change nothing

Refuses to overwrite private content: if the profile has a non-empty resource
that isn't already a symlink, that resource is reported as 'refused' and left
alone. Re-run with --backup to keep that content as a backup file in the
profile and share the resource anyway. The other resources are still linked.

On Windows, dirs use junctions (no admin/Developer Mode needed). File
symlinks may require Developer Mode; without it, files fall back to hard
links so editing-in-place still propagates between profiles.

Examples:
  cchost link work                     # link all 7
  cchost link work --tools             # only skills/, agents/, commands/
  cchost link work --config            # only mcp.json, settings.json, CLAUDE.md
  cchost link a b c                    # link 3 profiles in one shot
  cchost link work --dry-run           # preview
`,
  unlink: `cchost unlink <profile> [--projects|--tools|--config] [--dry-run]

Break the symlinks and copy current ~/.claude/ content into the profile as
private resources. Non-destructive: same-name items already private in the
profile are kept, so re-running unlink is idempotent.

No flag         unlink all 7 resources
--projects      projects/
--tools         skills/, agents/, commands/
--config        mcp.json, settings.json, CLAUDE.md
--dry-run       print what would be unlinked and copied; change nothing

After unlinking, the profile's resource diverges from ~/.claude/. Other
profiles still see the shared pool.

Examples:
  cchost unlink work                   # full private profile
  cchost unlink work --config          # only mcp.json / settings.json / CLAUDE.md private
  cchost unlink work --tools --config  # skills, agents, commands AND config private
  cchost unlink work --dry-run         # preview
`,
  sharing: `cchost help sharing — what profiles share, and how to change it

Every profile has 7 resources. By default each one is a link into ~/.claude/,
so all profiles (and bare \`claude\`) see the same content:

  --projects   projects/                              session history
  --tools      skills/  agents/  commands/            user tooling
  --config     mcp.json  settings.json  CLAUDE.md     MCP servers, settings, memory

Logins (.credentials.json, .claude.json, .cc-env.json) are never shared.

See where a profile stands:
  cchost list                          Shared column: 7/7 = all shared
  cchost list work                     state of each resource

Start a new profile private (empty, nothing copied in):
  cchost add client --private          all 7 private
  cchost add client --private=projects own session history, shared tools/config

Make something private to an existing profile:
  cchost unlink work --config          own mcp.json / settings.json / CLAUDE.md
  cchost unlink work                   all 7 private
  The current shared content is copied in, so nothing disappears; from then
  on, changes in that profile stay in that profile.

Share it again:
  cchost link work --config            back to the shared ~/.claude/ copy
  link refuses to replace private content. Move or delete the private file or
  folder first; it is not merged into ~/.claude/ automatically.

Copy shared content into a private profile (top-up, no overwrite):
  cchost copy default work             add what ~/.claude/ has and work lacks
  cchost copy default work --force     overwrite work's copies instead

Preview any of these first with --dry-run.
`,
  remove: `cchost remove <profile> [--force] [--yes] [--dry-run] [--json]

Delete a profile and everything inside its directory: credentials, sessions,
and any private resources. To confirm, you must type the exact profile name —
y/n is intentionally not accepted because credential loss is unrecoverable.

If a profile's resources are symlinks to ~/.claude/, only the symlinks are
removed — the shared content in ~/.claude/ is preserved for other profiles.
If any resource is PRIVATE (unlinked), --force is required because its
content is unique to this profile and will be lost forever.

--dry-run       show what would be deleted; change nothing
--yes           skip typing the name (for scripts and agents; ask the person
                first). Without a terminal, remove refuses unless --yes is given.
--json          machine-readable result

For the existing account (cchost add <name> --existing), remove only forgets
the name; ~/.claude and ~/.claude.json are never touched.
`,
  doctor: `cchost doctor [--fix [--force]] [--dry-run] [--json]

Run diagnostic checks across four groups:

  Environment  Node >=18, claude on PATH, claude version, no conflicting env vars
  Storage      ~/.claude-profiles/ writable, .claude.json parseable, every
               profile's 7 resource links present and valid; legacy
               ~/.claude-shared/ folded into ~/.claude/ if still present
  Platform     Windows: OneDrive home, WindowsApps stub, stale ~/bin/cc;
               Git Bash: cygpath
  Sanity       Test-spawn claude --version through the same code path cchost use uses

Exit codes: 0 = all ok, 1 = warnings, 2 = errors.

--fix           Auto-apply safe fixes: create missing dirs, recreate broken
                links, backfill missing resource links
--fix --force   Also apply confirmation-required fixes (e.g. reset corrupt
                .claude.json)
--fix --dry-run Show which safe fixes would run; change nothing
--json          Machine-readable output for CI / scripting

Also checks: pool MCP servers synced into sharing profiles, ~/.claude/mcp.json
permissions, the name of your existing account, and the cchost agent skills.
`,
  status: `cchost status [--json]

One view of everything: cchost and Claude Code versions, your existing account
(~/.claude), every profile (login, endpoint, sharing, MCP servers), the pool's
MCP servers, agent skills, doctor issues, and a list of suggested next steps.
Emails are masked and no token or secret is ever included.
`,
  mcp: `cchost mcp — MCP servers across profiles

Claude Code reads MCP servers from each account's .claude.json: user scope
(every folder) and local scope (one project folder). cchost manages both.

  cchost mcp list [<profile>|pool] [--json]
  cchost mcp copy <from> <to>... [--server=a,b] [--scope=user|local|all]
                  [--project=PATH] [--force] [--dry-run] [--json]
  cchost mcp remove <profile>|pool <server> [--scope=user|local|all]
                  [--project=PATH] [--dry-run] [--json]
  cchost mcp sync [<profile>...] [--dry-run] [--json]

<from>/<to> are profile names, the name of your existing account, or "pool".
The pool (~/.claude/mcp.json) is shared: every profile that shares mcp.json,
plus your existing account, gets its servers in user scope. cchost tracks the
copies it made, so removing a server from the pool removes only those copies;
servers you added to a profile yourself are never touched.

copy skips servers that are already identical and refuses to replace a
different server of the same name unless --force. Env and header values,
and secret-looking arguments, are never printed. Every change saves a backup
first: cchost backups, cchost restore <id>.

Examples:
  cchost mcp list
  cchost mcp copy work work-pk work-pb --dry-run
  cchost mcp copy work work-pk --server=dbeaver
  cchost mcp copy work work-pk --scope=all            # include project servers
  cchost mcp copy work pool --server=dbeaver          # share with every profile
  cchost mcp remove pool plate
`,
  token: `cchost token <profile> [--stdin]

Set or replace a custom endpoint profile's API token. The token is typed
with input hidden and saved to .cc-env.json readable by you only. --stdin reads
it from standard input instead (for scripts). Needs a terminal otherwise:
agents should ask the person to run it.
`,
  backups: `cchost backups [--json]

Every change cchost makes to a JSON config file (.claude.json, mcp.json, ...)
first saves the file to ~/.cchost-backups/<id>/. The newest 30 are kept.
Undo one with: cchost restore <id> [--dry-run]
`,
  restore: `cchost restore <id> [--dry-run] [--json]

Put back the files saved in a backup (ids: cchost backups). Files that did
not exist before are deleted. The current files are backed up first, so a
restore can be undone too.
`,
  agent: `cchost agent [topic]

Guides written for AI agents (Claude Code, Codex, Cursor, ...) that set up or
manage cchost for a person. Run without a topic for the overview and the
topic list. The cchost skills point here, so agents always read the guide for
the installed version.
`,
  skill: `cchost skill install [--profile=<name>] [--dry-run] [--json]
cchost skill status [--json]

Install the two cchost skills (cchost-setup, cchost-manage) into
~/.claude/skills, so every profile that shares skills/ can use them.
--profile installs into a profile that keeps its own skills/. Only skill
folders that cchost installed are ever replaced.
`,
  ui: `cchost ui [--port=N] [--no-open] [--user=NAME] [--pass=PASSWORD] [--session=8h]

Open a local web page that shows every profile, what each one shares with
~/.claude/, logins, endpoints and doctor results, and lets you add and remove
profiles, share or unshare resources, copy from ~/.claude/ and apply doctor
fixes. Every change shows a preview first and lists each step it took.

Sign-in works like rclone's web GUI: the terminal prints a username and a
random password that is new every run, and your browser opens with a
one-time sign-in link (valid 2 minutes). The browser then keeps a session
that ends after --session or when cchost ui stops. The page is served on
127.0.0.1 only; endpoint tokens are never sent to it. Ctrl+C stops it.

--port=N         Listen on port N (default: a free port)
--no-open        Print the one-time link instead of opening a browser
--user=NAME      Sign-in username (default: cchost)
--pass=PASSWORD  Use this password instead of a random one (8+ characters;
                 visible in your shell history — prefer the random one)
--session=8h     How long a sign-in lasts: 30m, 8h, 2d (default: 8h)
`,
  help: `cchost help [command]

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

function prompt(question, output = process.stdout) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output,
    });
    let answered = false;
    rl.on('close', () => {
      if (!answered) resolve('');
    });
    rl.question(question, (answer) => {
      answered = true;
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

// Secrets are shown only to a person at a terminal, never into a pipe.
function requireTerminal(what) {
  if (!process.stdout.isTTY) throw usageError(`${what} only works in a terminal; its output is not meant for pipes or agents.`);
}

function refuseAlias(name) {
  if (typeof name === 'string' && profiles.isAlias(name) && !fs.existsSync(profiles.profileDir(name))) {
    const err = new Error(`"${name}" is your existing account in ~/.claude, which is the shared pool itself — there is nothing to link, unlink or copy.`);
    err.exitCode = 1;
    throw err;
  }
}

function groupsFrom(flags) {
  return ['projects', 'tools', 'config'].filter((g) => flags.has(`--${g}`));
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

// Count how many of the 7 shared resources a profile currently has linked
// (symlink OR — on Windows file fallback — hard link).
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
    throw usageError(`--private= needs at least one of: ${PRIVATE_GROUPS.join(', ')}`);
  }
  const opts = {};
  for (const g of groups) {
    if (!PRIVATE_GROUPS.includes(g)) {
      throw usageError(`Unknown --private group "${g}". Use: ${PRIVATE_GROUPS.join(', ')}`);
    }
    opts[g] = true;
  }
  return opts;
}

async function cmdAdd(rest) {
  const positional = [];
  const provided = {};
  let custom = false;
  let privateOpts = null;
  let existing = false;
  let json = false;
  let dryRun = false;

  for (const a of rest) {
    if (a.startsWith('-')) {
      const eq = a.indexOf('=');
      const flagName = eq === -1 ? a : a.slice(0, eq);
      if (['--existing', '--json', '--dry-run'].includes(flagName)) {
        if (eq !== -1) throw usageError(`${flagName} takes no value`);
        if (flagName === '--existing') existing = true;
        if (flagName === '--json') json = true;
        if (flagName === '--dry-run') dryRun = true;
        continue;
      }
      if (flagName === '--custom') {
        if (eq !== -1) throw usageError('--custom takes no value');
        custom = true;
        continue;
      }
      if (flagName === '--private') {
        privateOpts = parsePrivateFlag(eq === -1 ? null : a.slice(eq + 1));
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
    throw usageError(
      'Usage: cchost add <profile> [--private[=projects,tools,config]] ' +
        '[--custom [--base-url=URL --token=TOKEN ...]]',
    );
  }
  if (extra.length > 0) throw usageError(`cchost add takes no extra arguments: ${extra[0]}`);
  profiles.validateProfileName(name);

  if (Object.keys(provided).length > 0 && !custom) {
    throw usageError(
      'Endpoint flags (--base-url, --token, --model, ...) require --custom: ' +
        `cchost add ${name} --custom ...`,
    );
  }
  if (existing) {
    if (custom || privateOpts) throw usageError('--existing names your current account; it takes no --custom or --private.');
    return commands.runAction('add', { name, existing: true }, { dryRun, json });
  }
  if (provided.auth_token) {
    process.stderr.write(color.stderr.yellow(`[cchost] note: a token passed as --token stays in your shell history. Next time use: cchost token ${name}`) + '\n');
  }
  if (json || dryRun) {
    if (custom && !provided.base_url) throw usageError('--json/--dry-run with --custom needs --base-url=URL (the token can be set later with: cchost token <profile>).');
    return commands.runAction('add', {
      name,
      private: privateOpts ? Object.keys(privateOpts) : [],
      endpoint: custom ? provided : undefined,
    }, { dryRun, json });
  }

  // Fold any legacy ~/.claude-shared/ pool into ~/.claude/ before any link work.
  runLegacyPoolMigration();

  if (!custom) {
    const { dir } = profiles.addProfile(name);
    console.log(`Created profile "${name}" at ${dir}.`);
    setUpResources(name, dir, privateOpts);
    syncNewProfile(name, dir);
    console.log(`Next: cchost use ${name}`);
    return 0;
  }

  // Custom endpoint profile.
  const dir = profiles.profileDir(name);
  const existed = fs.existsSync(dir);
  if (existed && privateOpts) {
    throw usageError(
      `--private only applies when creating a profile; "${name}" already exists. ` +
        `Use: cchost unlink ${name} [--projects|--tools|--config]`,
    );
  }
  if (!existed) {
    profiles.addProfile(name);
    setUpResources(name, dir, privateOpts);
    syncNewProfile(name, dir);
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

  if (!existed) console.log(`Next: cchost use ${name}`);
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

// On profile creation, link every resource that isn't private into
// ~/.claude/, and start each private dir empty. Private config files are left
// absent so Claude Code creates them on first use.
function syncNewProfile(name, dir) {
  if (!share.isSharedResource(dir, 'mcp.json')) return;
  const lines = require('./mcp').sync({ profiles: [name] }, { dryRun: false }).filter((l) => l.kind === 'change');
  if (lines.length) {
    console.log('  Pool MCP servers:');
    commands.printLines(lines);
  }
}

function setUpResources(name, dir, privateOpts) {
  if (!privateOpts) {
    autoLinkArtifacts(name);
    return;
  }
  const privateSet = share.resolveSubset(privateOpts);
  const sharedGroups = {};
  for (const g of PRIVATE_GROUPS) if (!privateOpts[g]) sharedGroups[g] = true;
  if (Object.keys(sharedGroups).length > 0) autoLinkArtifacts(name, sharedGroups);
  for (const r of privateSet) {
    if (!share.isFileResource(r)) fs.mkdirSync(path.join(dir, r), { recursive: true });
  }
  share.markPrivate(dir, privateSet);
  console.log(`  Private (not shared with other profiles): ${privateSet.map(resourceLabel).join(', ')}`);
}

// Symlink resources into ~/.claude/ (all 7, or the groups in `opts`). Failures
// emit a warning but do NOT abort cchost add — the profile is still usable,
// and the user can re-run `cchost link <name>` to retry.
function autoLinkArtifacts(name, opts = {}) {
  let results;
  try {
    results = share.shareLink(name, opts);
  } catch (err) {
    process.stderr.write(
      color.stderr.yellow(
        `  warning: could not link resources for "${name}": ${err.message}`,
      ) + '\n',
    );
    return;
  }
  const failed = results.filter(
    (r) => r.status === 'failed' || r.status === 'refused' || r.status === 'foreign-link',
  );
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
      `  Re-run \`cchost link ${name}\` after resolving the above.`,
    ) + '\n',
  );
}

async function cmdUse(rest) {
  const [name, ...passthrough] = rest;
  if (!name) throw usageError('Usage: cchost use <profile> [...args]');
  profiles.validateProfileName(name);
  const dir = profiles.profileDir(name);
  if (!fs.existsSync(dir) && profiles.isAlias(name)) {
    const conflicts = envLib.authEnvConflicts();
    if (conflicts.length > 0) {
      process.stderr.write(`[cchost] warning: ${conflicts.join(', ')} set in the environment; this may override the login of '${name}'.\n`);
    }
    return spawnClaude({ args: passthrough, profileDir: null });
  }
  if (!fs.existsSync(dir)) {
    const err = new Error(`Profile "${name}" does not exist. Create it with: cchost add ${name}`);
    err.exitCode = 1;
    throw err;
  }

  let extraEnv = {};
  let unsetEnv = [];
  const envConfig = envLib.readEnvConfig(dir);
  if (envConfig) {
    extraEnv = envLib.buildEnvVars(envConfig);
    unsetEnv = envLib.endpointEnvToStrip(extraEnv);
    if (!envConfig.auth_token) {
      const err = new Error(`Profile '${name}' has no token yet. Set it (input hidden): cchost token ${name}`);
      err.exitCode = 1;
      throw err;
    }
    const host = envConfig.base_url ? envLib.hostOf(envConfig.base_url) : '(unknown)';
    process.stderr.write(
      `[cchost] Profile '${name}' → ${host} (custom endpoint billing applies)\n`,
    );
    if (unsetEnv.length > 0) {
      process.stderr.write(
        `[cchost] notice: removed inherited ${unsetEnv.join(', ')} for endpoint profile '${name}'.\n`,
      );
    }
  } else {
    const conflicts = envLib.authEnvConflicts();
    if (conflicts.length > 0) {
      process.stderr.write(
        `[cchost] warning: ${conflicts.join(', ')} set in the environment; ` +
          `this may override the subscription login for '${name}'. ` +
          `Unset ${conflicts.length > 1 ? 'them' : 'it'} to use the profile's login.\n`,
      );
    }
  }
  return spawnClaude({ args: passthrough, profileDir: dir, extraEnv, unsetEnv });
}

// `cchost list <profile>` — detail for a single profile, including its custom
// endpoint configuration if it has one.
function cmdListOne(name, { json, reveal }) {
  if (json && reveal) {
    throw usageError('--reveal cannot be combined with --json.');
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
    const e = new Error(`Profile "${name}" does not exist. Create it with: cchost add ${name}`);
    e.exitCode = 1;
    throw e;
  }

  const total = share.SHARED_RESOURCES.length;
  const resources = {};
  for (const r of share.SHARED_RESOURCES) resources[r] = share.resourceState(dir, r);
  const sharedCount = Object.values(resources).filter((st) => st === 'shared').length;
  const { credentialSource, loggedIn, email } = profiles.readProfile(dir);
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
  if (reveal) requireTerminal('--reveal');

  const list = profiles.listProfiles();
  const total = share.SHARED_RESOURCES.length;

  const enriched = list.map((p) => {
    const sharedCount = p.alias ? share.SHARED_RESOURCES.length : countSharedResources(p.dir);
    return {
      name: p.alias ? `${p.name}*` : p.name,
      existingAccount: Boolean(p.alias),
      dir: p.dir,
      loggedIn: p.loggedIn,
      credentialSource: p.credentialSource,
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


async function cmdRemove(rest) {
  const { flags, positional } = parseFlagsStrict(rest, ['--force', '--yes', '--dry-run', '--json'], { allowPositional: true });
  const [name, ...extra] = positional;
  if (!name) throw usageError('Usage: cchost remove <profile> [--force] [--yes] [--dry-run] [--json]');
  if (extra.length > 0) throw usageError(`Unexpected argument: ${extra[0]}`);
  const force = flags.has('--force');
  const yes = flags.has('--yes');
  const dryRun = flags.has('--dry-run');
  const json = flags.has('--json');
  profiles.validateProfileName(name);
  const dir = profiles.profileDir(name);
  const aliasOnly = profiles.isAlias(name) && !fs.existsSync(dir);
  if (!aliasOnly && fs.existsSync(dir) && hasPrivateContent(dir) && !force && !dryRun) {
    const err = new Error(
      `Profile "${name}" has private (unlinked) resources whose content is not ` +
        `in ~/.claude/. Removing the profile will delete that content permanently.\n` +
        `Re-run with --force to confirm: cchost remove ${name} --force`,
    );
    err.exitCode = 1;
    throw err;
  }
  if (!dryRun && !yes && !process.stdin.isTTY) {
    throw usageError(`Removing "${name}" needs confirmation. Ask the user, then re-run with --yes.`);
  }
  if (dryRun || json || yes || aliasOnly) {
    if (!dryRun && !yes) {
      const answer = await prompt(`Type the profile name "${name}" to confirm: `);
      if (answer.trim() !== name) {
        console.log('Aborted.');
        return 0;
      }
    }
    return commands.runAction('remove', { profile: name, confirm: name }, { dryRun, json });
  }
  if (!fs.existsSync(dir)) {
    const err = new Error(`Profile "${name}" does not exist at ${dir}.`);
    err.exitCode = 1;
    throw err;
  }

  if (hasPrivateContent(dir) && !force) {
    const err = new Error(
      `Profile "${name}" has private (unlinked) resources whose content is not ` +
        `in ~/.claude/. Removing the profile will delete that content permanently.\n` +
        `Re-run with --force to confirm: cchost remove ${name} --force`,
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
    ['--tools', '--projects', '--config', '--dry-run', '--backup', '--json'],
    { allowPositional: true },
  );
  if (flags.has('--json')) {
    if (positional.length !== 1) throw usageError('--json takes one profile at a time.');
    return commands.runAction('link', {
      profile: positional[0], groups: groupsFrom(flags), backup: flags.has('--backup'),
    }, { dryRun: flags.has('--dry-run'), json: true });
  }
  for (const n of positional) refuseAlias(n);
  if (positional.length === 0) {
    throw usageError(
      'Usage: cchost link <profile> [<profile>...] [--projects|--tools|--config] [--backup] [--dry-run]',
    );
  }
  const dryRun = flags.has('--dry-run');
  const opts = {
    tools: flags.has('--tools'),
    projects: flags.has('--projects'),
    config: flags.has('--config'),
    backup: flags.has('--backup'),
    dryRun,
  };
  if (dryRun) console.log('Dry run — nothing will be changed.');
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
        process.stderr.write(color.stderr.yellow(`  ${label}: refused — ${r.message} (or add --backup)`) + '\n');
      } else if (r.status === 'foreign-link') {
        process.stderr.write(color.stderr.yellow(`  ${label}: foreign link — ${r.message}`) + '\n');
      } else if (r.status === 'already-linked') {
        console.log(`  ${label}: already linked`);
      } else if (r.relinkedFromLegacy) {
        console.log(
          `  ${label}: ${dryRun ? 'would relink' : 'relinked'} (was pointing at legacy ~/.claude-shared/)`,
        );
      } else if (r.identical) {
        console.log(`  ${label}: ${dryRun ? 'would link' : 'linked'} → ~/.claude/${r.resource} (this profile's copy matches it)`);
      } else if (r.backup) {
        console.log(dryRun
          ? `  ${label}: would keep this profile's copy as ${r.resource}.cchost-backup-<time>, then link → ~/.claude/${r.resource}`
          : `  ${label}: kept this profile's copy as ${r.backup}, linked → ~/.claude/${r.resource}`);
      } else if (dryRun) {
        console.log(`  ${label}: would link → ~/.claude/${r.resource}`);
      } else {
        const note = r.kind === 'hardlink' ? ' (hard link — enable Windows Developer Mode for a true symlink)' : '';
        console.log(`  ${label}: linked${note}`);
      }
    }
    const failed = results.filter(
      (r) => r.status === 'failed' || r.status === 'refused' || r.status === 'foreign-link',
    );
    const linked = results.length - failed.length;
    console.log(
      `  ${dryRun ? 'would end with ' : ''}${linked}/${results.length} linked` +
        (failed.length ? `, ${failed.length} not linked` : '') + '.',
    );
    summary.push({
      name,
      linked,
      total: results.length,
      failed: failed.map((f) => f.resource),
    });
  }

  if (!dryRun && (opts.config || !(opts.tools || opts.projects))) {
    const mcpLines = require('./mcp').sync({ profiles: positional.filter((n) => !summary.find((s) => s.name === n && s.error)) }, { dryRun: false })
      .filter((l) => l.kind === 'change' || (l.kind === 'warn' && l.code));
    if (mcpLines.length) {
      console.log('\nPool MCP servers:');
      commands.printLines(mcpLines);
    }
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
    ['--tools', '--projects', '--config', '--dry-run', '--json'],
    { allowPositional: true },
  );
  const [name, ...extra] = positional;
  if (!name) {
    throw usageError('Usage: cchost unlink <profile> [--projects|--tools|--config] [--dry-run] [--json]');
  }
  if (extra.length > 0) throw usageError(`Unexpected argument: ${extra[0]}`);
  if (flags.has('--json')) {
    return commands.runAction('unlink', { profile: name, groups: groupsFrom(flags) }, { dryRun: flags.has('--dry-run'), json: true });
  }
  refuseAlias(name);
  const dryRun = flags.has('--dry-run');
  const opts = {
    tools: flags.has('--tools'),
    projects: flags.has('--projects'),
    config: flags.has('--config'),
    dryRun,
  };
  if (dryRun) console.log('Dry run — nothing will be changed.');
  const results = share.shareUnlink(name, opts);
  let anyFailure = false;
  for (const r of results) {
    const label = share.isFileResource(r.resource) ? r.resource : `${r.resource}/`;
    if (r.status === 'failed') {
      anyFailure = true;
      process.stderr.write(color.stderr.red(`  ${label}: failed — ${r.message}`) + '\n');
    } else if (r.status === 'not-linked') {
      console.log(`  ${label}: not linked, skipping`);
    } else if (dryRun) {
      const what = r.items === undefined ? 'its content' : `${r.items} item(s)`;
      console.log(`  ${label}: would unlink and copy ${what} from ~/.claude/ into the profile`);
    } else {
      console.log(`  ${label}: unlinked, content copied back`);
    }
  }
  return anyFailure ? 1 : 0;
}

// `cchost ui` runs until Ctrl+C, so it never resolves.
// '30m', '8h', '2d' -> milliseconds.
function parseDuration(text) {
  const m = /^(\d+)(m|h|d)$/.exec(text);
  if (!m || Number(m[1]) === 0) return null;
  return Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]];
}

async function cmdUi(rest) {
  let port = 0;
  let open = true;
  let user = 'cchost';
  let pass = null;
  let sessionTtlMs;
  for (const a of rest) {
    if (a === '--no-open') { open = false; continue; }
    const eq = a.indexOf('=');
    const flag = eq === -1 ? a : a.slice(0, eq);
    const value = eq === -1 ? null : a.slice(eq + 1);
    if (['--port', '--user', '--pass', '--session'].includes(flag) && !value) {
      throw usageError(`Flag ${flag} requires a value: ${flag}=VALUE`);
    }
    if (flag === '--port') {
      port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw usageError(`Invalid port: ${a}`);
      continue;
    }
    if (flag === '--user') { user = value; continue; }
    if (flag === '--pass') {
      if (value.length < 8) throw usageError('--pass must be at least 8 characters.');
      pass = value;
      continue;
    }
    if (flag === '--session') {
      sessionTtlMs = parseDuration(value);
      if (!sessionTtlMs) throw usageError(`Invalid --session "${value}". Use e.g. 30m, 8h or 2d.`);
      continue;
    }
    throw usageError(a.startsWith('-') ? `Unknown flag: ${flag}` : `Unexpected argument: ${a}`);
  }
  const { startUi } = require('./ui/server');
  await startUi({ port, open, user, pass, sessionTtlMs });
  return new Promise(() => {});
}

async function cmdDoctor(rest) {
  const { flags } = parseFlagsStrict(rest, ['--fix', '--force', '--json', '--dry-run']);
  const fix = flags.has('--fix');
  const force = flags.has('--force');
  if (force && !fix) throw usageError('--force requires --fix');
  const json = flags.has('--json');
  if (flags.has('--dry-run')) {
    if (!fix) throw usageError('--dry-run goes with --fix: cchost doctor --fix --dry-run');
    return commands.runAction('doctor-fix', {}, { dryRun: true, json });
  }
  const doctor = require('./doctor');
  return doctor.runDoctor({ fix, force, json, prompt });
}

async function cmdCopy(rest) {
  const { flags, positional } = parseFlagsStrict(
    rest,
    ['--force', '--dry-run', '--json'],
    { allowPositional: true },
  );
  const [src, dest, ...extra] = positional;
  if (!src || !dest) throw usageError('Usage: cchost copy <src> <dest> [--force] [--dry-run] [--json]');
  if (extra.length > 0) throw usageError(`Unexpected extra arguments: ${extra.join(' ')}`);
  if (flags.has('--json')) {
    if (src !== 'default') throw usageError('--json supports: cchost copy default <profile>');
    return commands.runAction('copy', { profile: dest, force: flags.has('--force') }, { dryRun: flags.has('--dry-run'), json: true });
  }
  refuseAlias(dest);
  const force = flags.has('--force');
  const dryRun = flags.has('--dry-run');
  if (dryRun) process.stdout.write('Dry run — nothing will be changed.\n');
  if (force) {
    process.stdout.write(
      `Warning: --force is set. Existing items at the destination ${dryRun ? 'would' : 'will'} be overwritten.\n`,
    );
  }
  copyLib.copy(src, dest, { force, dryRun });
  return 0;
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
        "'cchost env' was removed in v0.3.1. Configure a custom endpoint with " +
          "'cchost add <profile> --custom', and view it with 'cchost list <profile>'.",
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
    case 'ui':
      return await cmdUi(rest);
    case 'status':
      return await commands.cmdStatus(rest);
    case 'mcp':
      return await commands.cmdMcp(rest);
    case 'backups':
      return await commands.cmdBackups(rest);
    case 'restore':
      return await commands.cmdRestore(rest);
    case 'agent':
      return await commands.cmdAgent(rest);
    case 'skill':
    case 'skills':
      return await commands.cmdSkill(rest);
    case 'token':
      return await commands.cmdToken(rest);
    default: {
      process.stderr.write(color.stderr.red(`Unknown command: ${action}`) + '\n\n');
      printHelp();
      return 2;
    }
  }
}

module.exports = { run, printHelp, removeRecursivelyPreservingLinks };
