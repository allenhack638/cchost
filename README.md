# cchost

Host multiple isolated Claude Code accounts on one machine via a single `cc` command. `cc` is a plain Node CLI on your PATH, so it runs the same from PowerShell, cmd, bash, zsh, or fish — there are no shell scripts or rc-file edits involved. Tested on Windows and Linux; macOS is expected to work but is not yet verified.

Each profile is a complete, isolated `CLAUDE_CONFIG_DIR` — credentials, session history, project state, plugins, and settings. Create one with `cc add <name>`; launch under it with `cc use <name>`.

## Install

```
npm install -g cchost
```

Requires Node.js 18+ and Claude Code 2.1.140+ already installed. Get Claude Code from <https://code.claude.com> (`npm install -g @anthropic-ai/claude-code`).

## Commands

| Command | What it does |
| --- | --- |
| `cc add <profile>` | Create a profile directory. |
| `cc use <profile> [...args]` | Launch Claude under that profile. Profile must already exist. Args after the name are forwarded verbatim to `claude`. |
| `cc list [--json]` | Show every profile: login state, account email, and how many artifact dirs are linked to shared (N/4). |
| `cc migrate <src> <dest> [--force]` | Copy artifacts from `default`\|`shared` to `shared`\|`<profile>`. Skip-on-collision by default; `--force` overwrites. |
| `cc link <profile> [<profile>...]` | Link a profile's artifact dirs to `~/.claude-shared/`. Migrates existing content; renames on collision. |
| `cc unlink <profile>` | Restore a profile to its own private artifact dirs (copies shared content back). |
| `cc remove <profile>` | Delete a profile. Requires typing the profile name to confirm. |
| `cc doctor [--fix [--force]] [--json]` | Diagnose environment, storage, and platform issues. |
| `cc help [command]` | Print usage (top-level, or for a single command). |

### Examples

```bash
cc add work                            # create the profile, do not launch
cc use work                            # first launch: Claude prompts for login
cc use work --resume                   # resume last conversation under "work"
cc use personal -p "summarize"         # one-shot prompt under "personal"
cc list
cc remove old-profile
```

`cc list` output:

```
Profile   LoggedIn  Email                 Shared
personal  true      personal@example.com  4/4
scratch   false     -                     0/4
work      true      work@example.com      0/4
```

### What migrate copies and what link shares

| Artifact | `cc migrate` copies it | `cc link` shares it | Notes |
| --- | :---: | :---: | --- |
| `projects/` | ✓ | ✓ | Resumable conversation transcripts |
| `skills/` | ✓ | ✓ | Custom slash-command scripts |
| `agents/` | ✓ | ✓ | Custom agent definitions |
| `commands/` | ✓ | ✓ | Custom command configs |
| `mcp.json` | ✓ (default→profile only) | — | Per-profile MCP server config; may carry auth tokens |
| `settings.json` | ✓ (default→profile only) | — | Per-profile UI/feature settings |
| `CLAUDE.md` | ✓ (default→profile only) | — | Per-profile project instructions |
| `sessions/` | — | — | Transient per-process state; sharing would corrupt bookkeeping |
| `plugins/` | — | — | Carries auth tokens; deferred to a future opt-in flag |
| `.credentials.json` | — | — | Never touched — each profile keeps its own auth |
| `.claude.json` | — | — | Never touched — re-synced from server on every launch |

`mcp.json`, `settings.json`, and `CLAUDE.md` are **not** copied to `shared` and are **not** linked because they typically carry auth tokens or per-profile configuration that should not leak across accounts.

### Migrating existing artifacts

If you've been using Claude Code without profiles, your history lives in `~/.claude/`. Pull it into a profile or the shared pool:

```bash
cc migrate default work        # copy ~/.claude/* → ~/.claude-profiles/work/
cc migrate default shared      # copy ~/.claude/projects,skills,agents,commands → ~/.claude-shared/
cc migrate shared personal     # copy ~/.claude-shared/* → ~/.claude-profiles/personal/
cc migrate default work --force  # same as first, overwriting anything that already exists
```

This is a **copy** — the source is left untouched. By default, if an entry already exists at the destination it is silently skipped. Pass `--force` to overwrite instead — existing destination content will be cleared.

Credential files (`.credentials.json`, `.claude.json`) are never copied: each profile keeps its own auth state.

### Shared artifacts across profiles

If you want each profile to keep separate credentials but share project history and skills (e.g. rotate accounts on the same project when usage limits hit):

```bash
cc link work
cc link personal
```

`work/` and `personal/` each get four linked dirs (`projects`, `skills`, `agents`, `commands`) pointing to `~/.claude-shared/`. On Windows this uses directory junctions (no admin/Developer Mode required); on macOS/Linux, regular symlinks.

`sessions/` is **never** linked. It holds transient per-process registry state — PID, working directory, status, timestamps — and sharing it would corrupt Claude's running-process bookkeeping. It stays per-profile under `~/.claude-profiles/<name>/sessions/`.

`cc link a b c` links several profiles at once; per-profile failures are reported but don't abort the rest of the batch.

If two profiles share history and you launch them against the same project at the same time, both will write to the same session files (last write wins). Don't do that.

`cc remove` is safe with shared profiles — it deletes only the links, never recursing into the shared target.

## How it works

`cc` is a Node CLI with **zero runtime dependencies**. For `cc use` it:

1. Resolves the profile directory under `~/.claude-profiles/<name>/`
2. Sets `CLAUDE_CONFIG_DIR` in its **own** spawn environment
3. Spawns `claude` with `stdio: 'inherit'` so the TUI works correctly
4. Forwards the child's exit code

The env var is set on the child process only — that's all `claude` needs.

## Sensitive data

`~/.claude-profiles/<profile>/` holds real OAuth credentials. Treat it like SSH keys: don't commit it, don't share it, don't sync it to public cloud storage. The `.gitignore` shipped with this project excludes profile directories from anywhere they might land. `cc migrate` and `cc link` never copy `.credentials.json` or `.claude.json` across profiles.

## Troubleshooting

**`Claude Code does not appear to be installed`**
Install it (`npm install -g @anthropic-ai/claude-code`) and make sure `claude --version` runs in a fresh terminal.

**`warning: Claude Code <version> is older than 2.1.140`**
Earlier versions had bugs where Windows read `.claude.json` from `%USERPROFILE%` regardless of `CLAUDE_CONFIG_DIR`, breaking isolation. Run `claude update`.

**`Profile "<name>" does not exist. Create it with: cc add <name>`**
`cc use` does not auto-create profiles — that prevents typos like `cc use wokr` from silently creating a new, blank one. Run `cc add <name>` first.

**Profile name rejected**
Names must be free of path separators, whitespace, `..`, leading dots, and reserved DOS names (CON, PRN, COM1…). Stick to letters, digits, dashes, underscores.

**Old shell-script version was leaking keystrokes / leaking `use work` into the prompt**
That was a known bug in the cmd-based predecessor (`%*` ignored `shift`). This package forwards only the argv after `<profile>` to `claude`; the action and profile name themselves are consumed by `cc`.

## License

MIT
