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
| `cc add <profile>` | Create a subscription profile (logs in with Anthropic OAuth on first use). |
| `cc add <profile> --custom [...]` | Create — or, if it already exists, edit — a profile routed through a custom API endpoint. Opens a wizard, or takes `--base-url=URL --token=TOKEN [--model=…]`. See [Custom endpoints](#custom-endpoints-kimi-openrouter-etc). |
| `cc use <profile> [...args]` | Launch Claude under that profile. Profile must already exist. Args after the name are forwarded verbatim to `claude`. |
| `cc list [<profile>] [--json] [--reveal]` | List every profile (login state, email, shared dirs N/4, endpoint), or show one profile in detail. `--reveal` unmasks a custom endpoint's API token. |
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
Profile   LoggedIn  Email                 Shared  Endpoint
kimi      false     -                     0/4     api.moonshot.ai
personal  true      personal@example.com  4/4     subscription
scratch   false     -                     0/4     subscription
work      true      work@example.com      0/4     subscription
```

The **Shared** column is a count: how many of the 4 shareable directories
(`projects`, `skills`, `agents`, `commands`) are linked to `~/.claude-shared/`.

- `0/4` — fully isolated; the profile keeps its own private copies.
- `4/4` — fully shared; all four point at the common pool.
- `1/4`, `2/4`, `3/4` — **partial**, and not a normal state. `cc link` links
  all four at once and `cc unlink` unlinks all four at once, so you should
  normally see only `0/4` or `4/4`.

A partial count has two causes:

1. **A link partially failed** — one directory could not be linked (a
   permission issue, or it was locked) while the others succeeded. `cc link`
   reports per-directory failures so this is never silent.
2. **An upgrade from an older cchost.** Versions before `0.2.1` linked only
   `projects/` — the other three shareable directories did not exist yet. A
   profile linked under an older version therefore shows `1/4` after you
   upgrade.

In both cases the fix is the same — re-run `cc link <profile>`. Already-linked
directories are skipped and the missing ones are linked, bringing the profile
to `4/4`.

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
| `.cc-env.json` | — | — | Per-profile custom-endpoint config; holds an API key. Never migrated, never linked. |

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
Shared:    0/4
Endpoint:  api.moonshot.ai
  Base URL:  https://api.moonshot.ai/anthropic
  Token:     sk-you...key9 (32 chars)
  Model:     kimi-k2.5
  Opus:      kimi-k2.5
  Sonnet:    kimi-k2.5
  Haiku:     kimi-k2.5
  Subagent:  kimi-k2.5
```

`cc list <profile> --reveal` prints the full API key instead — do not paste that output anywhere.

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

`~/.claude-profiles/<profile>/` holds real OAuth credentials. Treat it like SSH keys: don't commit it, don't share it, don't sync it to public cloud storage. The `.gitignore` shipped with this project excludes profile directories from anywhere they might land. `cc migrate` and `cc link` never copy `.credentials.json` or `.claude.json` across profiles.

`.cc-env.json` (custom-endpoint config) contains a third-party **API key** — treat it exactly like `.credentials.json`. It is written with user-only file permissions, and `cc migrate`/`cc link` never copy or link it across profiles. `cc list <profile>` masks the token; only `cc list <profile> --reveal` prints it in full.

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
