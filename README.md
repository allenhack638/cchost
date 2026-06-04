# cchost

> Run multiple isolated Claude Code accounts on one machine — switch between them with a single `cc` command.

[![npm version](https://img.shields.io/npm/v/cchost.svg)](https://www.npmjs.com/package/cchost)
[![CI](https://github.com/allenhack638/cchost/actions/workflows/ci.yml/badge.svg)](https://github.com/allenhack638/cchost/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/cchost.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/cchost.svg)](https://nodejs.org)

<!-- Demo: record a ~15s clip of `cc add` → `cc use` → `cc list`, save it as
     docs/demo.gif, and uncomment the line below. -->
<!-- ![cchost in action](docs/demo.gif) -->

Claude Code keeps one account's login, history, and settings in a single config directory. To use a second account you normally have to log out and back in, which loses your place. cchost gives each account its own directory so you can keep several side by side and pick one when you launch.

Each profile is a complete, isolated `CLAUDE_CONFIG_DIR`: credentials, session history, project state, plugins, and settings. Create one with `cc add <name>`, launch under it with `cc use <name>`. Nothing is shared between profiles unless you ask for it.

`cc` is a plain Node CLI on your PATH, so it works the same from PowerShell, cmd, bash, zsh, or fish. No shell scripts, no rc-file edits. Tested on Windows, Linux, and macOS in CI.

## Install

```
npm install -g cchost
```

Requires Node.js 18+ and Claude Code 2.1.140+ already installed. Get Claude Code from <https://code.claude.com> (`npm install -g @anthropic-ai/claude-code`).

## Commands

| Command | What it does |
| --- | --- |
| `cc add <profile>` | Create a subscription profile (logs in with Anthropic OAuth on first use). Auto-symlinks artifact dirs into `~/.claude/`. |
| `cc add <profile> --custom [...]` | Create — or, if it already exists, edit — a profile routed through a custom API endpoint. Opens a wizard, or takes `--base-url=URL --token=TOKEN [--model=…]`. See [Custom endpoints](#custom-endpoints-kimi-openrouter-etc). |
| `cc use <profile> [...args]` | Launch Claude under that profile. Profile must already exist. Args after the name are forwarded verbatim to `claude`. |
| `cc list [<profile>] [--json] [--reveal]` | List every profile (login state, email, shared count N/7, endpoint), or show one profile in detail. Emails and tokens are masked by default; `--reveal` shows both in full. |
| `cc copy default <profile> [--force]` | Copy `~/.claude/` resources into a profile. Meaningful only when one or more resources have been unlinked via `cc unlink`; otherwise every resource resolves to the same on-disk path and is skipped. Skip-on-collision by default; `--force` overwrites. `cc migrate` is a deprecated alias. |
| `cc link <profile> [<profile>...] [--projects\|--tools\|--config]` | (Re-)link a profile's resources to `~/.claude/`. No flag = all 7. Refuses to overwrite private content. |
| `cc unlink <profile> [--projects\|--tools\|--config]` | Break the links and copy current `~/.claude/` content into the profile as private resources. Non-destructive. |
| `cc remove <profile> [--force]` | Delete a profile. Requires typing the profile name to confirm. `--force` is required when private (unlinked) resources exist. |
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
Profile   LoggedIn  Email                  Shared  Endpoint
kimi      false     -                      7/7     api.moonshot.ai
personal  true      p************.com      7/7     subscription
scratch   false     -                      7/7     subscription
work      true      w************.com      7/7     subscription
```

`7/7` is the steady state since v0.4.1 — every profile auto-shares 4 dirs (`projects`, `skills`, `agents`, `commands`) **and** 3 files (`mcp.json`, `settings.json`, `CLAUDE.md`) with `~/.claude/`. A lower number means one or more resources were unlinked via `cc unlink <profile> --projects|--tools|--config`.

Emails are masked by default so the list is safe to paste in screenshots and issue reports. Pass `--reveal` to show them in full (same flag also reveals the API token on custom-endpoint profiles).

The **Shared** column is a count: how many of the 7 shareable resources symlink into `~/.claude/`.

- `7/7` — the default since v0.4.1. All four artifact dirs *and* the three
  config files point at the shared pool; a tool, server, or hook configured
  under any profile is immediately visible to every other profile.
- `6/7`, `5/7`, … — one or more resources were `cc unlink`ed and now hold
  private content.
- `0/7` — fully isolated; the profile keeps its own copy of everything.
- `4/7` — typical of a profile created on v0.4.0 before the file resources
  were added. Run `cc doctor --fix` to backfill them.

### What's shared, what's per-profile

Since v0.4.1, **`~/.claude/` is the shared pool**, and **all 7 resources** auto-link into it on `cc add`. The trust boundary is simple: anything that authenticates this profile's identity stays per-profile; everything else is global.

| Resource | Location | Shared? | Flag group |
| --- | --- | :---: | --- |
| `projects/` | `~/.claude/projects/` | ✓ (symlink) | `--projects` |
| `skills/` | `~/.claude/skills/` | ✓ (symlink) | `--tools` |
| `agents/` | `~/.claude/agents/` | ✓ (symlink) | `--tools` |
| `commands/` | `~/.claude/commands/` | ✓ (symlink) | `--tools` |
| `mcp.json` | `~/.claude/mcp.json` | ✓ (file symlink / hard link) | `--config` |
| `settings.json` | `~/.claude/settings.json` | ✓ (file symlink / hard link) | `--config` |
| `CLAUDE.md` | `~/.claude/CLAUDE.md` | ✓ (file symlink / hard link) | `--config` |
| `sessions/` | per-profile | — | (never shared) |
| `plugins/` | per-profile | — | (never shared) |
| `.credentials.json` | per-profile | — | Anthropic OAuth token. Never touched. |
| `.claude.json` | per-profile | — | Account identity (re-synced on every launch). |
| `.cc-env.json` | per-profile | — | Custom-endpoint API key. Never copied, never linked. |

`mcp.json` carries MCP server tokens and `settings.json` carries hooks that can run arbitrary commands. Sharing them means every profile sees the same set — if you need per-profile separation for one of them, `cc unlink <profile> --config` breaks the link and makes that profile's copies private.

### Seeding a private profile from `~/.claude/`

If a profile has unlinked resources (`cc unlink <p>`) and you want to seed them from the current `~/.claude/`:

```bash
cc copy default work          # copies anything unlinked from ~/.claude/ → work
cc copy default work --force  # same, overwriting if already present
```

For a fresh `cc add` profile this is a no-op — every resource already resolves to `~/.claude/` via its symlink, so there's nothing to copy. `cc copy` becomes meaningful only after `cc unlink`. (`cc migrate` is a deprecated alias for `cc copy` and still works.)

### Opting out of sharing for a profile

```bash
cc unlink work --tools         # private skills/agents/commands for "work" only
cc unlink work --projects      # private projects/ for "work" only
cc unlink work --config        # private mcp.json/settings.json/CLAUDE.md
cc unlink work                 # private everything (all 7 unlinked)
cc link work --tools           # re-share just the tools
cc link work --config          # re-share just the config files
```

`cc unlink` is non-destructive — current pool content is copied into the profile as a private dir or file before the link is broken, so your view of the resource is preserved. `cc link` refuses to overwrite existing private content; move or remove it manually and re-run.

Credential files (`.credentials.json`, `.claude.json`, `.cc-env.json`) are never touched: each profile keeps its own auth state.

### How sharing works under the hood

Every profile created by `cc add` ships with 7 links pointing at `~/.claude/<resource>`:

- Directories use Windows junctions (no admin / Developer Mode required) or POSIX symlinks.
- Files (`mcp.json`, `settings.json`, `CLAUDE.md`) use file symlinks where possible. On Windows without Developer Mode, file symlinks require elevation — `cc link` falls back to a **hard link** there, which works without admin and behaves identically for edit-in-place flows.

`sessions/` and `plugins/` are **never** linked. `sessions/` holds transient per-process registry state (PID, status, timestamps) and sharing it would corrupt Claude's running-process bookkeeping. `plugins/` carries auth tokens.

If two profiles open the same project at the same time, both will write to the same conversation files in `~/.claude/projects/<cwd>/` (last write wins). Either avoid that or run `cc unlink <profile> --projects` on one of them.

`cc remove` is safe with fully-shared profiles — it deletes only the symlinks, leaving `~/.claude/` untouched. If a profile has *private* (unlinked) resources, `cc remove` requires `--force` because that content is unique to the profile and will be lost.

## Custom endpoints (Kimi, OpenRouter, etc.)

A profile can route through any Anthropic-compatible API endpoint instead of Anthropic's subscription OAuth — Moonshot/Kimi, OpenRouter, Requesty, a self-hosted vLLM, or a corporate proxy. You declare this when you create the profile, with `cc add <profile> --custom`.

> **Billing:** a custom-endpoint profile bills through the **third-party provider**, using the API key you supply — **not** your Anthropic subscription. You are responsible for that provider's usage charges. A subscription profile is unaffected.

A custom-endpoint profile and a subscription profile are mutually exclusive: a profile is born one or the other and stays that way. `cc add --custom` refuses to run on a profile that already has Anthropic OAuth credentials — create custom-endpoint profiles fresh.

### Worked example — Moonshot / Kimi

```bash
cc add kimi --custom --base-url=https://api.moonshot.ai/anthropic \
                     --token=sk-your-moonshot-key \
                     --model=kimi-k2.5
cc use kimi
```

Moonshot's endpoint URL ends in `/anthropic` — Claude Code appends `/v1/messages` itself, so do **not** add `/v1`. Most third-party providers serve a single model name; pass it as `--model` and it is applied to every tier (opus/sonnet/haiku/subagent). To override a tier, pass `--opus=`, `--sonnet=`, `--haiku=`, or `--subagent=`.

Run `cc add <profile> --custom` with no value flags for an interactive wizard instead — it prompts for every field and never echoes the token. `cc add --custom` is atomic: if you cancel the wizard, no profile is left behind.

### Editing a custom-endpoint profile

Re-run `cc add <profile> --custom` on a profile that already has a custom endpoint and it switches to **edit mode**: the wizard prefills current values, and with flags only the flags you pass are changed.

```bash
cc add kimi --custom --model=kimi-k3      # change just the model
cc add kimi --custom --token=sk-rotated   # rotate the API key
```

Inspect a config with `cc list <profile>` — the API token is masked:

```
Profile:   kimi
Directory: /home/you/.claude-profiles/kimi
LoggedIn:  false
Email:     -
Shared:    7/7
Endpoint:  api.moonshot.ai
  Base URL:  https://api.moonshot.ai/anthropic
  Token:     sk-you...key9 (32 chars)
  Model:     kimi-k2.5
  Opus:      kimi-k2.5
  Sonnet:    kimi-k2.5
  Haiku:     kimi-k2.5
  Subagent:  kimi-k2.5
```

`cc list <profile> --reveal` prints the full API key and the full email — do not paste that output anywhere.

There is no way to convert a custom-endpoint profile back to a subscription profile. To stop using an endpoint, `cc remove` the profile and recreate it.

When you launch a custom-endpoint profile, `cc use` prints a one-line reminder to stderr:

```
[cchost] Profile 'kimi' → api.moonshot.ai (custom endpoint billing applies)
```

The config lives at `~/.claude-profiles/<profile>/.cc-env.json` with user-only file permissions. It contains your API key — see [Sensitive data](#sensitive-data).

## How it works

`cc` is a Node CLI with **zero runtime dependencies**. For `cc use` it:

1. Resolves the profile directory under `~/.claude-profiles/<name>/`
2. Sets `CLAUDE_CONFIG_DIR` in its **own** spawn environment
3. Spawns `claude` with `stdio: 'inherit'` so the TUI works correctly
4. Forwards the child's exit code

The env var is set on the child process only — that's all `claude` needs.

## Sensitive data

`~/.claude-profiles/<profile>/` holds real OAuth credentials. Treat it like SSH keys: don't commit it, don't share it, don't sync it to public cloud storage. The `.gitignore` shipped with this project excludes profile directories from anywhere they might land. `cc copy` and `cc link` never touch `.credentials.json` or `.claude.json`.

`.cc-env.json` (custom-endpoint config) contains a third-party **API key** — treat it exactly like `.credentials.json`. It is written with user-only file permissions, and `cc copy`/`cc link` never copy or link it across profiles. `cc list <profile>` masks the token; only `cc list <profile> --reveal` prints it in full.

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
