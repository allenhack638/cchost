'use strict';

// Help text: the full reference and per-command detail.

const { renderBanner } = require('../banner');

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
  cchost go [...args]                                  Launch Claude under the profile pinned to this folder
  cchost pin <profile> | unpin | pins | which          Pin folders to profiles (cchost help pin)
  cchost find <words...> [--global]                    Search your conversations, every account (cchost help find)
  cchost open <id> [--fork]                            Resume a conversation found with find, in its folder
  cchost list [<profile>] [--json] [--reveal]          List profiles, or show one in detail
  cchost copy default <profile> [--force] [--dry-run]  Copy ~/.claude/ resources into a profile (only when unlinked)
  cchost link <p>... [--projects|--tools|--config]     (Re-)link a profile's resources to ~/.claude/
  cchost unlink <profile> [--projects|--tools|--config]  Restore a profile's private resources (non-destructive)
  cchost remove <profile> [--force]                    Delete a profile and all its data
  cchost doctor [--fix [--force]] [--json]             Diagnose environment, storage, and platform issues
  cchost mcp list|copy|remove|sync ...                 MCP servers across profiles (cchost help mcp)
  cchost token <profile>                               Set a custom endpoint's token (hidden input)
  cchost backups | restore <id> [--dry-run]            List and undo cchost's changes to config files
  cchost update claude [--dry-run]                     Update Claude Code safely (one update at a time)
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

  Environment  Node >=18, claude on PATH, claude version, an npm update of
               Claude Code that stopped halfway, no conflicting env vars
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
  update: `cchost update claude [--dry-run] [--json]

Updates Claude Code once for every profile. It runs \`npm install -g
@anthropic-ai/claude-code@latest\` (or \`claude update\` for the standalone
install) while holding a lock, so two updates never overlap, then removes
what an earlier interrupted update left behind.

Claude Code started by cchost does not update itself: each profile's session
would update the same install at the same time and can leave it half-done.
cchost tells you when a new Claude Code is out. To let Claude Code update
itself anyway, set CCHOST_CLAUDE_AUTOUPDATE=1.

To update cchost itself: npm install -g cchost@latest
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

<from>/<to> are profile names, the name of your existing account (or
"default" for it, named or not), or "pool".
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
  pin: `cchost pin <profile> [--path=DIR] [--dry-run] [--json]
cchost unpin [--path=DIR] [--dry-run] [--json]
cchost pins [--json]
cchost which [--json]
cchost go [...claude args]

Pin a folder (and everything under it) to a profile, so 'cchost go' in that
folder always launches Claude under that account, and 'cchost find' there only
sees that folder's conversations under that account. Pins are stored in
~/.claude-profiles/.cchost.json, never in the folder. The deepest pin wins.

  cchost pin work                 pin the current folder to 'work'
  cchost pin p1 --path=~/side     pin another folder
  cchost unpin                    remove the pin on the current folder
  cchost pins                     list every pin; flags missing folders or profiles
  cchost which                    what 'go' and 'find' would do here, and why
  cchost go --resume              launch here; extra args go to claude

No pin yet? At a terminal, 'cchost go' lists your accounts, launches the one
you pick and offers to pin the folder to it.

Without a pin, 'cchost go' uses the existing account if you named one
('cchost add <name> --existing'), otherwise it tells you to pin or use.

A repo may ship a one-line .cchost file naming a profile. It is a suggestion:
'cchost find' narrows to it at once, but 'cchost go' asks once before pinning
(answer 'never' to ignore that file). It can only name a profile you already
have; it cannot set an endpoint, token or arguments.
`,
  find: `cchost find <words...> [--since=30d] [-n=20] [--json]
cchost find <words...> --global [--profile=NAME[,NAME...]] [--project=PATH]
cchost open [<session-id-prefix>] [--fork] [--global] [--profile=NAME] [--cwd=PATH]
cchost index [--global] [--json]

Search what you typed and what Claude answered, across every conversation
and every account on this machine, and resume the one you want. Words must
all appear in the same message; "quote a phrase" to match it exactly.

  cchost find redis webhook           conversations mentioning both words
  cchost find "rate limit" --since=2w only the last two weeks
  cchost find deploy --profile=work,p1 only these accounts
  cchost open 4f57                    resume it, in its folder, as that account
  cchost open                         pick from this folder's recent conversations
  cchost open 4f57 --fork             branch off instead of continuing

Scope. find and open only see the folder you run them in: inside a pinned
folder, that folder (and subfolders) under the pinned account; in any other
project folder, that folder under every account. Nothing runs from your home
folder or a filesystem root. --global lifts the folder and account limits and
works only at a terminal, never from an agent or a script. --profile and
--project can narrow a scope, never widen it.

Index. The first find reads your session files once (about 1% of their size
is text) into ~/.claude-profiles/<profile>/.cchost-index, owner-only, one
file per session per account; later runs only read sessions that changed.
Tool calls, tool output, attachments and hook output are never indexed.
'cchost index --global' refreshes and prunes everything. Deleting the index
folders is always safe.
`,
  help: `cchost help [command]

Without an argument: print the summary of all commands.
With a command name: print detail for just that command.
`,
};

function printHelp(cmd) {
  const key = { unpin: 'pin', pins: 'pin', which: 'pin', go: 'pin', open: 'find', index: 'find' }[cmd] || cmd;
  if (key && HELP_BY_CMD[key]) {
    process.stdout.write(HELP_BY_CMD[key]);
    return;
  }
  // Top-level help: banner + summary.
  process.stdout.write(renderBanner());
  process.stdout.write(HELP);
}

module.exports = { printHelp };
