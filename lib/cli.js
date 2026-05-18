'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const profiles = require('./profiles');
const share = require('./share');
const migrateLib = require('./migrate');
const { spawnClaude } = require('./spawn');
const { renderTable } = require('./format');
const color = require('./color');

const HELP = `cc - Multi-profile launcher for Claude Code

Usage:
  cc add <profile>                                 Create a profile directory
  cc use <profile> [...args]                       Launch Claude under a named profile
  cc list [--json]                                 Show all profiles: login state, email, shared-dir count (N/4)
  cc migrate <src> <dest> [--force]                Copy artifact dirs (and config files) between profiles
  cc link <p>...                                   Link each profile's artifact dirs to ~/.claude-shared/
  cc unlink <profile>                              Restore a profile's private artifact dirs
  cc remove <profile>                              Delete a profile and all its data (typed confirmation)
  cc doctor [--fix [--force]] [--json]             Diagnose environment, storage, and platform issues
  cc help [command]                                Show usage (optionally for a single command)
  cc --version                                     Print the installed cchost version

Profiles live in ~/.claude-profiles/<profile>/ and become CLAUDE_CONFIG_DIR
for that launch. Args after the profile name are forwarded verbatim to claude.
`;

const HELP_BY_CMD = {
  add: `cc add <profile>

Create a new profile directory without launching Claude.

Examples:
  cc add work
  cc add personal
`,
  use: `cc use <profile> [...args]

Launch Claude under a named profile. The profile must already exist (create
it with 'cc add <profile>'). Its directory under ~/.claude-profiles/<profile>/
becomes CLAUDE_CONFIG_DIR for the spawned claude — credentials, sessions,
projects, plugins, and history are all isolated.

All args after the profile name are forwarded verbatim to claude.

Examples:
  cc use work
  cc use work --resume
  cc use personal -p "summarize this codebase"
`,
  list: `cc list [--json]

Columns:
  Profile   - profile name
  LoggedIn  - true if .credentials.json exists
  Email     - account email from .claude.json; - if not yet logged in
  Shared    - N/4 linked to ~/.claude-shared/ (projects, skills, agents, commands)
              4/4 = fully shared, 0/4 = fully isolated
              (sessions/ is transient per-process state and is never shared)

With --json, emits an array of {name, dir, loggedIn, email, shared}.
`,
  migrate: `cc migrate <src> <dest> [--force]

Copy artifact directories from a source to a destination. This is a COPY — the
source is left untouched. sessions/ is never migrated (transient per-process state).

  <src>:   default | shared
           default = ~/.claude/        (Claude's built-in non-profile data)
           shared  = ~/.claude-shared/ (the cc shared pool)
  <dest>:  shared | <profile-name>

Directories copied in all cases:
  projects/, skills/, agents/, commands/

Extra files copied only when src=default and dest=<profile>:
  mcp.json, settings.json, CLAUDE.md
  (These carry per-profile config and are NOT copied to shared.)

Never copied: .credentials.json, .claude.json, sessions/, plugins/

Collision behavior (default): existing entries at the destination are silently
skipped — the source entry is left alone.

--force  Overwrite existing entries instead of skipping.
         Warning: existing content at the destination will be cleared.

Examples:
  cc migrate default work            # copy ~/.claude/* to ~/.claude-profiles/work/
  cc migrate default shared          # copy dirs to ~/.claude-shared/
  cc migrate shared work             # copy shared dirs to ~/.claude-profiles/work/
  cc migrate default work --force    # same, overwriting any existing items
`,
  link: `cc link <profile> [<profile>...]

Replace each profile's artifact directories with links to ~/.claude-shared/:
  projects/, skills/, agents/, commands/

Existing content in each directory is migrated into shared first; collisions
are renamed with a __<profile> suffix (never overwritten). sessions/ (transient
per-process state) is intentionally never linked — it stays per-profile.

On Windows, link uses directory junctions (no admin/Developer Mode needed).
On macOS/Linux, regular symlinks.

Multiple profiles can be linked at once: 'cc link a b c'. Failures are handled
per directory and per profile: one directory failing does not stop the other
three, and one profile failing does not stop the rest of the batch. A
per-directory summary is printed; exit code is 1 if anything failed.
`,
  unlink: `cc unlink <profile>

Remove each linked artifact directory (projects/, skills/, agents/, commands/)
and copy the shared content back into the profile as private dirs.
`,
  remove: `cc remove <profile>

Delete a profile and everything inside its directory: credentials, sessions,
projects, plugins, and history. To confirm, you must type the exact profile
name — y/n is intentionally not accepted because credential loss is unrecoverable.

If the profile's projects/ is a link to ~/.claude-shared/, only the link is
removed — the shared target is preserved.
`,
  doctor: `cc doctor [--fix [--force]] [--json]

Run diagnostic checks across four groups:

  Environment  Node >=18, claude on PATH, claude >=2.1.140, no conflicting env vars, no cc shadow
  Storage      ~/.claude-profiles/ writable, .claude.json parseable, junctions/symlinks valid
  Platform     Windows: OneDrive home, WindowsApps stub, stale ~/bin/cc; Git Bash: cygpath
  Sanity       Test-spawn claude --version through the same code path cc use uses

Exit codes: 0 = all ok, 1 = warnings, 2 = errors.

--fix           Auto-apply safe fixes: create missing dirs, recreate broken junctions
--fix --force   Also apply confirmation-required fixes (e.g. reset a corrupt .claude.json)
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
    process.stdout.write(HELP_BY_CMD[cmd]);
  } else {
    process.stdout.write(HELP);
  }
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

async function cmdAdd(rest) {
  const [name, ...extra] = rest;
  if (!name) throw usageError('Usage: cc add <profile>');
  if (extra.length > 0) throw usageError(`cc add takes no extra arguments: ${extra[0]}`);
  const { dir } = profiles.addProfile(name);
  console.log(`Created profile "${name}" at ${dir}.`);
  console.log(`Next: cc use ${name}`);
  return 0;
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
  return spawnClaude({ args: passthrough, profileDir: dir });
}

function cmdList(rest) {
  const { flags } = parseFlagsStrict(rest, ['--json']);
  const list = profiles.listProfiles();
  const total = share.SHARED_SUBDIRS.length;

  const enriched = list.map((p) => {
    const sharedCount = share.SHARED_SUBDIRS.filter(sub =>
      isLinkLike(path.join(p.dir, sub))
    ).length;
    return {
      name: p.name,
      dir: p.dir,
      loggedIn: p.loggedIn,
      email: p.email,
      shared: sharedCount,
    };
  });

  if (flags.has('--json')) {
    process.stdout.write(JSON.stringify(enriched, null, 2) + '\n');
    return 0;
  }

  if (enriched.length === 0) {
    console.log(`No profiles yet in ${profiles.baseDir()}.`);
    console.log('Create one with:  cc add <name>');
    return 0;
  }

  const rows = [['Profile', 'LoggedIn', 'Email', 'Shared']];
  for (const p of enriched) {
    rows.push([
      p.name,
      p.loggedIn ? 'true' : 'false',
      p.email ? p.email : '-',
      `${p.shared}/${total}`,
    ]);
  }
  console.log(renderTable(rows));
  return 0;
}

async function cmdRemove(rest) {
  const [name] = rest;
  if (!name) throw usageError('Usage: cc remove <profile>');
  profiles.validateProfileName(name);
  const dir = profiles.profileDir(name);
  if (!fs.existsSync(dir)) {
    const err = new Error(`Profile "${name}" does not exist at ${dir}.`);
    err.exitCode = 1;
    throw err;
  }
  console.log('This will permanently delete:');
  console.log(`  ${dir}`);
  console.log('including credentials, sessions, projects, plugins, and history.');
  for (const sub of share.SHARED_SUBDIRS) {
    const sub_p = path.join(dir, sub);
    if (isLinkLike(sub_p)) {
      console.log(`  (${sub}/ is a link to shared storage — only the link will be removed)`);
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
  if (rest.length === 0) throw usageError('Usage: cc link <profile> [<profile>...]');
  const multi = rest.length > 1;
  const summary = [];
  for (const name of rest) {
    if (multi) console.log(`\n[${name}]`);
    let results;
    try {
      results = share.shareLink(name);
    } catch (err) {
      // Profile-level failure (invalid name, profile missing) — nothing linked.
      process.stderr.write(color.stderr.red(`  error: ${err.message}`) + '\n');
      summary.push({ name, linked: 0, total: share.SHARED_SUBDIRS.length, error: err.message });
      continue;
    }
    for (const r of results) {
      if (r.status === 'failed') {
        process.stderr.write(color.stderr.red(`  ${r.sub}: failed — ${r.message}`) + '\n');
      } else if (r.status === 'already-linked') {
        console.log(`  ${r.sub}: already linked`);
      } else {
        const note = r.moved ? ` (migrated ${r.moved} item(s) into shared)` : '';
        console.log(`  ${r.sub}: linked${note}`);
      }
    }
    const failed = results.filter((r) => r.status === 'failed');
    const linked = results.length - failed.length;
    console.log(`  ${linked}/${results.length} directories linked${failed.length ? `, ${failed.length} failed` : ''}.`);
    summary.push({ name, linked, total: results.length, failed: failed.map((f) => f.sub) });
  }

  const anyFailure = summary.some((s) => s.error || (s.failed && s.failed.length));
  if (multi) {
    console.log('\nSummary:');
    for (const s of summary) {
      if (s.error) {
        console.log(`  ${s.name}: error — ${s.error}`);
      } else if (s.failed && s.failed.length) {
        console.log(`  ${s.name}: ${s.linked}/${s.total} linked (failed: ${s.failed.join(', ')})`);
      } else {
        console.log(`  ${s.name}: ${s.linked}/${s.total} linked`);
      }
    }
  }
  return anyFailure ? 1 : 0;
}

async function cmdUnlink(rest) {
  const [name] = rest;
  if (!name) throw usageError('Usage: cc unlink <profile>');
  const results = share.shareUnlink(name);
  let anyFailure = false;
  for (const r of results) {
    if (r.status === 'failed') {
      anyFailure = true;
      process.stderr.write(color.stderr.red(`  ${r.sub}: failed — ${r.message}`) + '\n');
    } else if (r.status === 'not-linked') {
      console.log(`  ${r.sub}: not linked, skipping`);
    } else {
      console.log(`  ${r.sub}: unlinked, content copied back`);
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

async function cmdMigrate(rest) {
  const { flags, positional } = parseFlagsStrict(rest, ['--force'], { allowPositional: true });
  const [src, dest, ...extra] = positional;
  if (!src || !dest) throw usageError('Usage: cc migrate <src> <dest> [--force]');
  if (extra.length > 0) throw usageError(`Unexpected extra arguments: ${extra.join(' ')}`);
  const force = flags.has('--force');
  if (force) {
    process.stdout.write('Warning: --force is set. Existing items at the destination will be overwritten and their current content will be cleared.\n');
  }
  migrateLib.migrate(src, dest, { force });
  return 0;
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
  switch (action) {
    case 'add':
      return await cmdAdd(rest);
    case 'use':
      return await cmdUse(rest);
    case 'list':
      return cmdList(rest);
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
