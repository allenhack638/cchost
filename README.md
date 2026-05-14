# cchost

Host multiple isolated Claude Code accounts on one machine via a single `cc` command. Works identically in PowerShell, cmd, bash, zsh, and fish on Windows, macOS, and Linux.

Each profile is a complete, isolated `CLAUDE_CONFIG_DIR` — credentials, session history, project state, plugins, and settings. Create one with `cc add <name>`; launch under it with `cc use <name>`.

## Install

```
npm install -g cchost
```

Requires Node.js 18+ and Claude Code 2.1.140+ already installed. Get Claude Code from <https://code.claude.com> (`npm install -g @anthropic-ai/claude-code`).

## Commands

| Command | What it does |
| --- | --- |
| `cc add <profile> [--email=] [--org=] [--name=]` | Create a profile directory. Optional alias flags (EXPERIMENTAL, see below). |
| `cc use <profile> [...args]` | Launch Claude under that profile. Profile must already exist. Args after the name are forwarded verbatim to `claude`. |
| `cc list [--original] [--json]` | Show every profile: login state, account email, and storage mode (`shared` / `isolated`). |
| `cc migrate <src> <dest>` | Copy projects from `default`\|`shared` to `shared`\|`<profile>`. Skip-on-collision; credential files never copied. |
| `cc link <profile> [<profile>...]` | Link a profile's `projects/` and `sessions/` to `~/.claude-shared`. Migrates existing content; renames on collision. |
| `cc unlink <profile>` | Restore a profile to its own private `projects/` and `sessions/` (copies shared content back). |
| `cc remove <profile>` | Delete a profile. Requires typing the profile name to confirm. |
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
Profile   LoggedIn  Email                 Storage
personal  true      personal@example.com  isolated
scratch   false     -                     isolated
work      true      work@example.com      shared
```

### Migrating existing projects

If you've been using Claude Code without profiles, your history lives in `~/.claude/projects/`. Pull it into a profile or the shared pool:

```bash
cc migrate default work        # copy ~/.claude/projects → ~/.claude-profiles/work/projects
cc migrate default shared      # copy ~/.claude/projects → ~/.claude-shared/projects
cc migrate shared personal     # copy ~/.claude-shared/projects → ~/.claude-profiles/personal/projects
```

This is a **copy** — the source is left untouched. If an entry already exists at the destination, the source entry is skipped (no overwrite). Credential files (`.credentials.json`, `.claude.json`) are never copied: each profile keeps its own auth state.

### Shared history across profiles

If you want each profile to keep separate credentials but share project history (e.g. rotate accounts on the same project when usage limits hit):

```bash
cc link work
cc link personal
```

`work/projects` and `personal/projects` become links to `~/.claude-shared/projects`. Same for `sessions/`. On Windows this uses directory junctions (no admin/Developer Mode required); on macOS/Linux, regular symlinks.

`cc link a b c` links several profiles at once; per-profile failures are reported but don't abort the rest of the batch.

If two profiles share history and you launch them against the same project at the same time, both will write to the same session files (last write wins). Don't do that.

`cc remove` is safe with shared profiles — it deletes only the link, never recursing into the shared target.

### Aliases (`cc add` flags) — EXPERIMENTAL

`cc add work --email=work@example.com --org=Acme --name="Work Account"` stores those values in `~/.claude-profiles/work/.cc-alias.json`. On every `cc use`, they're written into the profile's `.claude.json` `oauthAccount` so `cc list` and Claude's own UI display them instead of the real underlying account.

**EXPERIMENTAL.** Claude Code may overwrite `oauthAccount` on server re-sync; we re-apply on the next `cc use`, but masking across all of Claude's UI surfaces has not been verified. Use `cc list --original` to see the real values from `.claude.json`.

## How it works

`cc` is a Node CLI with **zero runtime dependencies**. For `cc use` it:

1. Resolves the profile directory under `~/.claude-profiles/<name>/`
2. Applies any stored alias to `.claude.json` `oauthAccount` (best-effort)
3. Sets `CLAUDE_CONFIG_DIR` in its **own** spawn environment
4. Spawns `claude` with `stdio: 'inherit'` so the TUI works correctly
5. Forwards the child's exit code

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
