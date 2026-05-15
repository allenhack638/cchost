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
  cc list [--json]                                 Show all profiles: login state, email, storage (shared/isolated)
  cc migrate <src> <dest>                          Copy projects from default|shared to shared|<profile>
  cc link <p>...                                   Replace each profile's projects/ with a link to shared
  cc unlink <profile>                              Restore a profile's private projects/
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
  Storage   - 'shared' if projects/ is linked to ~/.claude-shared, 'isolated' otherwise
              (sessions/ is transient per-process state and is never shared)

With --json, emits an array of {name, dir, loggedIn, email, storage}.
`,
  migrate: `cc migrate <src> <dest>

Copy projects/ from a source to a destination. sessions/ (transient per-process
registry state) is never migrated. This is a COPY — the source is left untouched.

  <src>:   default | shared
           default = ~/.claude/        (Claude's built-in non-profile data)
           shared  = ~/.claude-shared/ (the cc shared pool)
  <dest>:  shared | <profile-name>

On collisions, existing entries at the destination are left alone (the source
entry is skipped). Credential files (.credentials.json, .claude.json) are
never copied — the destination keeps its own auth state.

Examples:
  cc migrate default work     # ~/.claude/projects -> ~/.claude-profiles/work/projects
  cc migrate default shared   # ~/.claude/projects -> ~/.claude-shared/projects
  cc migrate shared work      # ~/.claude-shared/projects -> ~/.claude-profiles/work/projects
`,
  link: `cc link <profile> [<profile>...]

Replace each profile's projects/ with a link to ~/.claude-shared/projects/.
Existing content is migrated into shared first; collisions are renamed with a
__<profile> suffix (never overwritten). sessions/ (transient per-process state)
is intentionally never linked — it stays per-profile.

On Windows, link uses directory junctions (no admin/Developer Mode needed).
On macOS/Linux, regular symlinks.

Multiple profiles can be linked at once: 'cc link a b c'. Per-profile failures
are reported but don't abort the rest of the batch.
`,
  unlink: `cc unlink <profile>

Remove a profile's projects/ link to ~/.claude-shared/ and copy shared content
back into the profile as a private dir.
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

  const enriched = list.map((p) => {
    const storage = isLinkLike(path.join(p.dir, 'projects')) ? 'shared' : 'isolated';
    return {
      name: p.name,
      dir: p.dir,
      loggedIn: p.loggedIn,
      email: p.email,
      storage,
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

  const rows = [['Profile', 'LoggedIn', 'Email', 'Storage']];
  for (const p of enriched) {
    rows.push([
      p.name,
      p.loggedIn ? 'true' : 'false',
      p.email ? p.email : '-',
      p.storage,
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
  const failures = [];
  for (const name of rest) {
    if (rest.length > 1) console.log(`\n[${name}]`);
    try {
      share.shareLink(name);
    } catch (err) {
      process.stderr.write(color.stderr.red(`  error: ${err.message}`) + '\n');
      failures.push({ name, message: err.message });
    }
  }
  if (rest.length > 1) {
    const ok = rest.length - failures.length;
    console.log(`\nSummary: ${ok} succeeded, ${failures.length} failed.`);
    for (const f of failures) console.log(`  ${f.name}: ${f.message}`);
  }
  return failures.length === 0 ? 0 : 1;
}

async function cmdUnlink(rest) {
  const [name] = rest;
  if (!name) throw usageError('Usage: cc unlink <profile>');
  share.shareUnlink(name);
  return 0;
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
  const [src, dest, ...extra] = rest;
  if (!src || !dest) throw usageError('Usage: cc migrate <src> <dest>');
  if (extra.length > 0) throw usageError(`Unexpected extra arguments: ${extra.join(' ')}`);
  migrateLib.migrate(src, dest);
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
