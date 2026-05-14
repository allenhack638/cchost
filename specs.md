Build an npm package for Claude Code multi-profile management

## What you are building

A globally-installable npm package that provides a `cc` command for running multiple isolated Claude Code accounts on one machine. It must work identically across PowerShell, cmd, bash, zsh, and fish on Windows, macOS, and Linux. Publish-ready: `package.json`, `bin/` entry point, README, LICENSE (MIT), `.gitignore`.

The command interface:

```
cc use <profile> [...args]   Launch Claude under a named profile, passing extra args through to claude
cc list                      Show all profiles, login state, and account email
cc remove <profile>          Delete a profile and all its data (with confirmation)
cc help                      Usage
```

## Background: why this package exists

Claude Code (Anthropic's CLI) supports a `CLAUDE_CONFIG_DIR` environment variable that relocates its entire config directory (credentials, session history, project state, plugins, settings). By pointing this variable at a different directory per account, you get fully isolated Claude Code installations. The official mechanism is documented at https://code.claude.com/docs/en/authentication.

We previously built this as shell scripts (`.ps1` for PowerShell, `.sh` for bash/zsh). That worked but required users to install and maintain different scripts for each shell, edit multiple rc files, and hit numerous environment-specific bugs. This package replaces all of that with one npm install.

## Core technical design

`cc` is a Node.js CLI. For `use`/`default`, it:
1. Resolves the profile directory path
2. Sets `CLAUDE_CONFIG_DIR` in **its own** process environment (not the parent shell's — that's impossible for a child process, and unnecessary)
3. Spawns `claude` as a child process with that environment and any pass-through args, inheriting stdio fully (Claude is an interactive TUI)
4. Forwards the child's exit code

Because `cc` launches Claude itself, the "can't modify parent shell environment" limitation does not apply. The env var only needs to live for the spawned process.

Default base directory for profiles: `~/.claude-profiles/` (use `os.homedir()`). Each profile is a directory like `~/.claude-profiles/work/` that becomes a complete `CLAUDE_CONFIG_DIR`.

## Behavior of each command

### `cc use <profile> [...args]`
- If `~/.claude-profiles/<profile>/` does not exist, create it and print a notice that Claude will prompt for login on first launch
- Set `CLAUDE_CONFIG_DIR` to that directory
- Spawn `claude` with all pass-through args (`--resume`, `-p "..."`, `--continue`, etc.) — args after the profile name must be forwarded verbatim
- Pass-through arg forwarding is critical: `cc use work --resume` must run `claude --resume`, NOT `claude use work --resume` or `claude work --resume`. (A previous cmd-based implementation had exactly this bug — `%*` in a batch file does not respect `shift`, so the action and profile name leaked into Claude as a prompt. Parse argv carefully: argv[0]=action, argv[1]=profile, argv[2..]=passthrough.)

### `cc list`
- If base dir doesn't exist, print a friendly "no profiles yet" message
- For each subdirectory: show profile name, whether `.credentials.json` exists (LoggedIn true/false), and the account email
- Get the email by reading `<profile>/.claude.json` and parsing `.oauthAccount.emailAddress`. Wrap in try/catch — the file may not exist yet, may be malformed, may be mid-write. Blank email on failure, never crash.
- Render as an aligned table

### `cc remove <profile>`
- Verify the profile exists; error clearly if not
- Print exactly what will be deleted (full path, and note it includes credentials/sessions/projects/plugins/history)
- Require the user to **type the profile name** to confirm (not y/n — too easy to fat-finger when destroying credentials)
- Delete the directory recursively
- Handle the case where the profile dir contains junctions/symlinks (see "shared history" below) — deleting the profile must NOT follow links and delete shared data. Delete only the link, not its target.

## Edge cases that MUST be handled

These are all real failures we hit. The package must handle each:

### 1. Claude Code not installed
Before spawning `claude`, check it exists on PATH. If not, print a clear error: that Claude Code must be installed, with the install pointer (`npm install -g @anthropic-ai/claude-code` or link to https://code.claude.com). Do not spawn and produce a cryptic ENOENT.

### 2. Claude Code version too old
The `CLAUDE_CONFIG_DIR` isolation mechanism only works correctly on Claude Code **2.1.140 or newer**. On Windows specifically, versions roughly 2.1.59–2.1.139 had bugs where:
- `CLAUDE_CONFIG_DIR` was honored for *writing* credentials but the startup *read* path for `.claude.json` was hardcoded to `%USERPROFILE%\.claude.json`, so profiles always conflicted
- `CLAUDE_CODE_OAUTH_TOKEN` was silently ignored

On startup, run `claude --version`, parse the version, and if it's below 2.1.140 print a warning recommending `claude update` (warn, don't hard-block — let the user proceed at their own risk).

### 3. `claude` binary name/location varies
On Windows it may be `claude.cmd`, `claude.exe`, or a shim. Use a cross-platform "which/where" approach (e.g. resolve via `process.env.PATH` scanning, or a library, or `where`/`which`). Don't assume a fixed name.

### 4. Profile name validation
Reject profile names containing path separators, `..`, leading dots, whitespace, or characters illegal in directory names. A bad name must not allow directory traversal outside the base dir. Validate before any filesystem operation.

### 5. Spawning an interactive TUI
Claude is a full-screen interactive terminal app. The child must be spawned with `stdio: 'inherit'` so keyboard, mouse, colors, and the alternate screen buffer all work. Forward the exit code. Handle Ctrl+C cleanly (let it pass to the child; don't leave a zombie).

### 6. Keyboard input leaking into Claude
We observed buffered keystrokes from the launching command leaking into Claude's prompt on Windows consoles. With a properly spawned `stdio: 'inherit'` child process this should not occur (it was an artifact of the old shell-function + console-buffer interaction), but test for it. Do not echo or re-emit any input.

### 7. Pass-through args with spaces and special chars
`cc use work -p "explain this code"` must preserve the quoted argument as a single arg to Claude. Use `spawn` with an args array, never string concatenation into a shell.

### 8. The base directory or profile is read-only / permission denied
Creating `~/.claude-profiles/` or a profile subdir may fail (locked-down home, container mounts, corporate policy). Catch the error and print something actionable, not a raw stack trace.

### 9. Corrupt or partial `.claude.json` / `.credentials.json`
`cc list` reads these. They may be absent, zero-length, malformed JSON, or mid-write. Every read must be defensive. One bad profile must not break `cc list` for the others.

### 10. OneDrive / redirected home directories (Windows)
`os.homedir()` is the source of truth — use it consistently. Do not rely on `%USERPROFILE%` vs Documents-folder assumptions. (The old shell version broke because PowerShell's `$PROFILE` was empty due to OneDrive redirection of the Documents folder; an npm bin on PATH sidesteps this entirely, but still: always use `os.homedir()`.)

### 11. Shared conversation/project history across profiles (important feature)
Some users want each profile to have isolated *credentials* but **shared** project history — e.g. so they can rotate accounts on the same project when one account's usage limit is hit. Support an optional setup where `<profile>/projects/` is a symlink/junction to `~/.claude-shared/projects/`.

**Only `projects/` is shared.** That's where Claude stores resumable conversation transcripts (`projects/<project>/<session>.jsonl`). The sibling `sessions/` folder holds transient per-process registry state (PID, cwd, status, timestamps) and must stay per-profile — sharing it would corrupt Claude's running-process bookkeeping. `cc link`/`cc unlink`/`cc migrate` never touch `sessions/`.

Add commands:
```
cc link <profile> [...]   Replace a profile's projects/ with a link to ~/.claude-shared/projects/ (migrating any existing content into shared first, renaming on name collision rather than overwriting)
cc unlink <profile>       Restore a profile to its own private projects/ (copy shared content back)
```

Implementation notes for `cc link`:
- On Windows, symlink creation often requires admin or Developer Mode. **Use directory junctions** (`fs` symlink with `'junction'` type, or the platform equivalent) which need no elevation. On macOS/Linux use normal symlinks.
- Before linking, if the profile already has a real `projects/` folder with content, move that content into the shared dir. On filename collision (same project dir name, different content — common for the `C--Users-...`-style home-directory project that every profile touches), rename the incoming one with a `__<profile>` suffix instead of overwriting. Never silently lose data.
- If the folder is already a junction/symlink, skip it (idempotent).
- `cc remove` must delete only the link, never recurse into and destroy the shared target.

### 12. Concurrent use warning
If two profiles share history (feature 11) and are run against the same project simultaneously, they'll both write the same session files (last-write-wins). Document this; optionally detect and warn.

### 13. Idempotent install / repeated commands
Running any command twice must be safe. Creating a profile that exists = no-op (just use it). Linking an already-linked profile = no-op.

### 14. Exit codes
`cc` must exit non-zero on its own errors (bad args, claude not found, permission denied) and must propagate Claude's exit code on successful spawn.

## What the previous shell implementation looked like (reference for behavior parity)

The PowerShell version's core logic, for behavior reference — replicate this behavior in Node, including the same command names and output style:

```
cc use <profile>:
  base = <homedir>/.claude-profiles
  dir  = base/<profile>
  if not exists dir: mkdir, notify "will prompt for login"
  set env CLAUDE_CONFIG_DIR = dir
  spawn claude with passthrough args, stdio inherit

cc list:
  for each dir in base:
    loggedIn = exists dir/.credentials.json
    email    = try parse dir/.claude.json -> oauthAccount.emailAddress, else ""
  print aligned table: Profile | LoggedIn | Email

cc remove <profile>:
  validate exists
  print what will be deleted
  read typed confirmation == profile name
  recursive delete (do not follow links)
```

The fields actually present in `.claude.json`'s `oauthAccount` object (for `cc list` and any future masking features) include: `accountUuid`, `emailAddress`, `organizationUuid`, `displayName`, `organizationName`, `organizationRole`, `organizationType`, `billingType`. Only `emailAddress` is needed for `cc list`.

## Package requirements

- `package.json`: name (suggest `claude-multi-profile`), `bin` field mapping `cc` to `bin/cc.js`, `engines.node` (>=16), proper `files` allowlist so only needed files are published, MIT license, description, keywords, repository field
- `bin/cc.js`: shebang `#!/usr/bin/env node`, the full CLI
- Keep dependencies minimal — prefer zero runtime dependencies; Node's built-in `fs`, `path`, `os`, `child_process` cover everything. If you use a dep for arg parsing or "which", justify it.
- Cross-platform: must run on Windows (PowerShell + cmd), macOS (zsh), Linux (bash). No shell-specific assumptions.
- Structure the code into small testable functions (resolveProfileDir, listProfiles, spawnClaude, etc.)
- Include clear `--help` output and a helpful message on unknown commands
- README.md: what it does, `npm install -g claude-multi-profile`, every command with examples, the shared-history feature explained, the 2.1.140 version requirement, troubleshooting section, and a note that profiles store real credentials so the directory should be treated as sensitive
- `.gitignore`: node_modules, the profile/credential directories, OS junk, editor files
- Do not commit or include any credentials or profile data

## Testing checklist to satisfy

- `cc use newprofile` creates dir and launches Claude (login prompt expected)
- `cc use newprofile` second time launches Claude already authenticated
- `cc use work --resume` forwards `--resume` to Claude and does NOT inject `use`/`work` as a prompt
- `cc use work -p "two words"` preserves the quoted arg
- `cc list` shows correct login state and emails, survives a corrupt `.claude.json`
- `cc default` uses non-profiled credentials
- `cc remove` requires typed confirmation, deletes only the profile, never shared targets
- `cc` with no args / bad command prints help, exits non-zero
- Claude-not-installed produces a clear message, not ENOENT
- Old Claude version produces a version warning
- Works the same in PowerShell, cmd, bash, zsh
- `cc share link` migrates existing content, renames on collision, is idempotent, uses junctions on Windows
