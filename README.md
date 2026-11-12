# cchost

> **nvm, but for your Claude Code accounts.** Works on Windows, Linux, and macOS — see [Platform notes](#platform-notes) for macOS credential-storage caveats.

[![npm version](https://img.shields.io/npm/v/cchost.svg)](https://www.npmjs.com/package/cchost)
[![CI](https://github.com/allenhack638/cchost/actions/workflows/ci.yml/badge.svg)](https://github.com/allenhack638/cchost/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/cchost.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/cchost.svg)](https://nodejs.org)
[![platforms](https://img.shields.io/badge/platforms-windows%20%7C%20linux%20%7C%20macos-blue)](#install)

<p align="center">
  <img src="https://raw.githubusercontent.com/allenhack638/cchost/master/docs/demo.png" alt="cchost CLI — cchost list showing masked emails and shared resource counts" width="100%">
</p>

`cchost` is a multi-account profile manager for [Claude Code](https://code.claude.com).

- **Isolated credentials** — each profile is a complete `CLAUDE_CONFIG_DIR` with its own login, endpoint, and credential files. Credentials are never copied between profiles (on macOS, see [Platform notes](#platform-notes) for Keychain caveats). Switch with `cchost use <name>`.
- **Shared tooling and history by default** — `skills/`, `agents/`, `commands/`, `projects/`, and the config files (`mcp.json`, `settings.json`, `CLAUDE.md`) link across all profiles. That includes session transcripts and code-executing config; see [Sharing model](#sharing-model) before using profiles for separated trust boundaries.
- **Custom endpoints** — route a profile through any Anthropic-compatible API (Moonshot, OpenRouter, self-hosted vLLM, corporate proxies) instead of Anthropic OAuth.
- **MCP servers across profiles** — see which profile has which server, copy them between profiles, or put them in the pool so every profile gets them.
- **Set up by your AI agent** — install cchost, then tell Claude Code (or any agent) *"Set up cchost for me"*.
- **Zero runtime dependencies** — single Node CLI on your `PATH`. Identical behavior across PowerShell, cmd, bash, zsh, and fish.

## Install

```
npm install -g cchost
```

Requires Node.js 18+ and Claude Code 2.1.140+ (`curl -fsSL https://claude.ai/install.sh | bash`, or `npm install -g @anthropic-ai/claude-code`).

`cchost` is the primary command. The same binary is also installed as `cc` for
backwards compatibility. Because `cc` is also the C compiler on macOS and
Linux, `cc` only acts as cchost for cchost commands (`cc use work`, `cc list`,
…); anything else (`cc -c foo.c`, `cc --version`) is passed to the real
compiler further down `PATH`, so builds keep working. Prefer `cchost` in
scripts and daily use; `cchost --version` prints cchost's version.

## Set up with your AI agent

After installing, open Claude Code (or Codex, Cursor, …) and say:

> Set up cchost for me. Run `cchost agent setup` and follow it.

The agent reads your current state, asks what to call your existing account
and which other accounts you want, shows one preview of every change, and
applies it only after you agree. Logins and API tokens stay with you: it asks
you to run `! cchost use <profile>` then `/login`, or `! cchost token <profile>`.

To give Claude Code the cchost skills permanently:

```bash
cchost skill install                                   # into ~/.claude/skills
# or, as a Claude Code plugin:
/plugin install cchost --marketplace allenhack638/cchost
```

There are two skills: `cchost-setup` (first-time setup) and `cchost-manage`
(everything after). Both stay small and read `cchost agent <topic>` from the
installed cchost, so they always match its version.

## Quickstart

```bash
cchost add personal --existing  # name the account plain `claude` already uses
cchost add work             # create a profile
cchost use work             # launch Claude under it (prompts for login on first run)
cchost use work --resume    # resume the last conversation
cchost list                 # see all profiles
cchost remove old-profile   # delete a profile
cchost mcp copy work pool   # share work's MCP servers with every profile
cchost status               # everything at a glance, with next steps
cchost ui                   # see and change everything in your browser
```

## Web view

`cchost ui` opens a local page that shows every profile, what each one shares with `~/.claude/`, its login and endpoint, and the doctor results. You can add and remove profiles, switch a group between shared and private, copy from `~/.claude/` and apply doctor fixes from the page. Every change shows a per-resource preview first (the same result as `--dry-run`) and, once applied, lists each step it took; the Activity view keeps the history for the session.

Sign-in works like rclone's web GUI. `cchost ui` prints a username (`cchost`) and a random password that is new every run, then opens your browser with a one-time sign-in link (valid 2 minutes). The browser keeps an HttpOnly session cookie that lasts 8 hours (`--session=30m|8h|2d`) or until `cchost ui` stops; the sidebar's Sign out ends it early. Wrong passwords are rate-limited.

```
cchost ui running at http://127.0.0.1:52134/

  Username:  cchost
  Password:  k7Qp-3mZx-Wb9t-Lr2v
  Sessions last 8h. The password is new every run.
```

The page runs on `127.0.0.1` only. Endpoint tokens are never sent to the page and emails are masked. `--port=N` picks a port, `--no-open` prints the one-time link instead of opening a browser, and `--user=NAME` / `--pass=PASSWORD` set your own credentials (a random password is safer: `--pass` ends up in shell history). Ctrl+C stops it.

The **MCP servers** view shows every server against every profile (has it, from the pool, differs, missing), with Copy and Remove for each; project-only servers are listed below it. **Activity** also lists cchost's backups with a Restore button.

In Doctor, every issue with an automatic fix has its own **Fix** button with a preview; fixes the CLI only applies with `--fix --force` (such as resetting a corrupt `.claude.json`) are marked **Fix…** and ask you to confirm. Issues that need a manual step show the command with a copy button.

## Commands

| Command | What it does |
| --- | --- |
| `cchost add <profile> [--private[=groups]]` | Create a subscription profile. Logs in via Anthropic OAuth on first `cchost use`. Auto-shares all 7 resources with `~/.claude/`, or starts the `--private` ones empty and unshared. |
| `cchost add <profile> --custom [...]` | Create or edit a custom-endpoint profile. Interactive wizard, or `--base-url=URL [--model=…]` and then `cchost token <profile>`. See [Custom endpoints](#custom-endpoints). |
| `cchost add <name> --existing` | Name the account plain `claude` already uses (`~/.claude`). Nothing is moved; `cchost use <name>` runs it, and `cchost remove <name>` only forgets the name. |
| `cchost status [--json]` | Everything at a glance: versions, accounts, logins, MCP servers, issues, and suggested next steps. |
| `cchost mcp list\|copy\|remove\|sync` | MCP servers across profiles. See [MCP servers](#mcp-servers). |
| `cchost token <profile>` | Set a custom endpoint's token with hidden input (`--stdin` for scripts). |
| `cchost backups` / `cchost restore <id> [--dry-run]` | List and undo cchost's changes to config files. |
| `cchost agent [topic]` / `cchost skill install` | Guides and skills for AI agents. See [Set up with your AI agent](#set-up-with-your-ai-agent). |
| `cchost use <profile> [...args]` | Launch Claude under that profile. Extra args are forwarded to `claude`. |
| `cchost list [<profile>] [--json] [--reveal]` | List all profiles, or show one in detail including the state of each of its 7 resources. Emails and tokens are masked by default; `--reveal` prints them in full. |
| `cchost copy default <profile> [--force] [--dry-run]` | Seed an unlinked profile resource from `~/.claude/`. No-op for fully-shared profiles. |
| `cchost link <profile> [--projects\|--tools\|--config] [--backup] [--dry-run]` | Link a profile's resources to `~/.claude/`. Defaults to all 7 when no flag is passed. `--backup` shares resources that have their own content by keeping that content as a backup file. |
| `cchost unlink <profile> [--projects\|--tools\|--config] [--dry-run]` | Break the link and make those resources private to the profile. Non-destructive. |
| `cchost remove <profile> [--force] [--yes]` | Delete a profile. Requires typing the profile name, or `--yes` (required without a terminal). `--force` required when private resources exist. |
| `cchost ui [--port=N] [--no-open] [--session=8h]` | Open the local web view: see every profile and change sharing, profiles and doctor fixes with a preview first. See [Web view](#web-view). |
| `cchost doctor [--fix [--force]] [--dry-run] [--json]` | Diagnose environment, storage, MCP and platform issues. `--fix` applies safe auto-fixes; `--force` is required for destructive ones. |
| `cchost help [command]` | Print usage. `cchost help sharing` is a task guide to linking, unlinking, and copying. |

Every command that changes something takes `--dry-run` (preview, change nothing) and `--json` (machine-readable). Exit codes: 0 ok, 1 refused or failed, 2 bad usage.

Sample `cchost list` output:

```
Profile   LoggedIn  Email                  Shared  Endpoint
kimi      false     -                      7/7     api.moonshot.ai
personal  true      p************.com      7/7     subscription
work      true      w************.com      7/7     subscription
```

The `Shared` column counts how many of the 7 shareable resources are linked into `~/.claude/`. `7/7` is the default; lower numbers mean one or more resources have been `cchost unlink`ed and now hold private content.

## Sharing model

On Windows and Linux, anything that authenticates a profile stays per-profile and everything else is shared. On macOS, OAuth credentials live in the login Keychain rather than the profile directory — see [Platform notes](#platform-notes).

| Resource | Shared by default | Flag group |
| --- | :---: | --- |
| `projects/` | ✓ | `--projects` |
| `skills/`, `agents/`, `commands/` | ✓ | `--tools` |
| `mcp.json`, `settings.json`, `CLAUDE.md` | ✓ | `--config` |
| `.credentials.json`, `.claude.json`, `.cc-env.json`, `.cc-private.json` | never | — |
| `sessions/`, `plugins/` | never | — |

Sharing uses POSIX symlinks on Linux/macOS and directory junctions on Windows (no admin or Developer Mode required). File resources fall back to a hard link on Windows when symlink creation would require elevation. Note that `mcp.json` and `settings.json` can execute arbitrary code through MCP servers and hooks — if a profile needs an isolated copy of either, run `cchost unlink <profile> --config`.

> **Privacy note:** the defaults above are convenient, not isolated. `projects/`
> contains full conversation transcripts, and `settings.json` / `mcp.json` can
> execute hooks and MCP servers. For a work/personal split, unlink the resources
> that must not cross over before first use, or use a separate OS account.

To create a profile that starts private instead, use `cchost add <profile> --private` (all 7) or `--private=projects,tools,config` (just those groups). Private resources start empty — nothing from `~/.claude/` is copied in — and are recorded in `<profile>/.cc-private.json` so `cchost doctor --fix` never re-shares them.

To see exactly what a profile shares, run `cchost list <profile>` — it prints each resource as `shared`, `private`, `empty`, `missing`, or `foreign-link`. `cchost help sharing` walks through the common tasks.

To break sharing for a single profile (add `--dry-run` to any of these to preview first):

```bash
cchost unlink work --tools     # private skills/agents/commands
cchost unlink work --projects  # private projects/
cchost unlink work --config    # private mcp.json/settings.json/CLAUDE.md
cchost unlink work             # all 7 private
cchost link work --tools       # re-share
```

`cchost unlink` is non-destructive — pool content is copied into the profile before the link is broken. `cchost link` re-shares a private copy that is still identical to `~/.claude/`, but refuses to overwrite one that has changed. Add `--backup` to share it anyway: the profile's copy is renamed to `<name>.cchost-backup-<time>` in the profile folder, then linked. Nothing is deleted or merged. The web view offers the same choice as **Share with backup**.

Use `cchost copy default <profile>` to seed an unlinked resource from the current `~/.claude/`. For fully-shared profiles this is a no-op.

## MCP servers

Claude Code reads MCP servers from each account's `.claude.json`: user scope (every folder) and local scope (one project folder). cchost manages both:

```bash
cchost mcp list                                  # every profile and the pool
cchost mcp copy work work-pk work-pb --dry-run   # preview copying work's servers
cchost mcp copy work work-pk --server=dbeaver    # just one server
cchost mcp copy work work-pk --scope=all         # include project servers
cchost mcp copy work pool --server=dbeaver       # give it to every profile
cchost mcp remove pool plate                     # and take it back
```

**The pool** (`~/.claude/mcp.json`) is the shared list. Every profile that shares `mcp.json`, plus your existing account, gets the pool's servers written into its own `.claude.json`. cchost records the copies it made, so removing a server from the pool removes only those; servers you added to a profile yourself are never touched. `cchost doctor` reports profiles that are out of sync and `cchost mcp sync` fixes them. Before 0.7, a shared `mcp.json` was linked but Claude Code never read it, so its servers did not load anywhere.

A server that already exists with the same config is skipped; a different server with the same name is refused unless `--force`. Env and header values and secret-looking arguments are never printed; copies keep them inside cchost. Restart running sessions to pick up changes.

### Backups

Before cchost changes a JSON config file (`.claude.json`, `mcp.json`, …) it saves a copy to `~/.cchost-backups/<id>/` (the newest 30 are kept, readable by you only). `cchost backups` lists them and `cchost restore <id>` puts the files back; the files as they were just before are backed up too, so a restore can be undone.

## Custom endpoints

A profile can route through any Anthropic-compatible API — Moonshot/Kimi, OpenRouter, Requesty, self-hosted vLLM, or a corporate proxy — instead of Anthropic's subscription OAuth.

> **Billing:** custom-endpoint profiles bill through the **third-party provider**, not your Anthropic subscription.

Inherited Anthropic auth/endpoint variables (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`) are removed for endpoint profiles when the profile doesn't set them, so a shell-level key cannot override the endpoint.

```bash
cchost add kimi --custom --base-url=https://api.moonshot.ai/anthropic \
                     --token=sk-your-key \
                     --model=kimi-k2.5
cchost use kimi
```

Run `cchost add <profile> --custom` with no value flags for an interactive wizard — it prompts for every field and never echoes the token. Re-running on an existing custom-endpoint profile enters **edit mode**: the wizard prefills current values, and with flags only the flags you pass are changed.

```bash
cchost add kimi --custom --model=kimi-k3      # change just the model
cchost add kimi --custom --token=sk-rotated   # rotate the API key
```

Subscription and custom-endpoint profiles are mutually exclusive: a profile is either one or the other for its entire lifetime. To switch, remove the profile with `cchost remove` and recreate it.

Inspect with `cchost list <profile>` (token masked) or `cchost list <profile> --reveal` (full). The endpoint URL should not include `/v1` — Claude Code appends `/v1/messages` itself. Most providers serve a single model; `--model` applies to every tier (`opus`/`sonnet`/`haiku`/`subagent`), or override per-tier with `--opus=`, `--sonnet=`, etc.

On launch, `cchost use` prints a one-line endpoint banner to stderr:

```
[cchost] Profile 'kimi' → api.moonshot.ai (custom endpoint billing applies)
```

## Platform notes

### macOS

Claude Code stores OAuth credentials in the login **Keychain**, not in
`<profile>/.credentials.json`. Claude Code namespaces the Keychain entry by
the exact `CLAUDE_CONFIG_DIR` path (verified with Claude Code 2.1.319):

```
Claude Code-credentials-<first 8 hex of sha256(path)>
```

So each profile gets its own Keychain entry. Two consequences:

- `cchost list` infers the login from `.claude.json`; it does not read the
  Keychain secret. Treat `LoggedIn` as a login hint, not proof of a live token.
- The entry is keyed by the exact path string. Renaming, moving, or copying a
  profile — or addressing it through a different path spelling or symlinked
  home — changes the key and looks like a logout. Run `claude` under the new
  path to log in again.

If you need guaranteed account separation on macOS, **custom-endpoint profiles**
(each has its own token in `.cc-env.json`) or separate macOS user accounts are
still the most explicit option.

### Windows and Linux

Credentials are file-based (`.credentials.json` in the profile directory), so
the `LoggedIn` column reflects the profile's own credential file.

## Security

`~/.claude-profiles/<profile>/` holds real OAuth credentials and API keys. Treat it like `~/.ssh`: don't commit it, don't share it, don't sync it to public cloud storage. The shipped `.gitignore` excludes profile directories. `cchost copy` and `cchost link` never touch credential files (`.credentials.json`, `.claude.json`, `.cc-env.json`); each profile keeps its own auth state. On macOS, OAuth tokens are stored in the login Keychain instead — see [Platform notes](#platform-notes).

### For AI agents

- Secrets never reach command output: tokens, OAuth data, MCP env and header values are masked everywhere, including `--json`, `cchost status` and the web view.
- `--reveal`, `cchost token` and typed-name `remove` only work at a terminal; piped or agent use gets a clear "ask the user" message instead of a prompt that hangs.
- Logins and endpoint tokens are always entered by the person.
- The agent guides tell agents to preview every change, ask before destructive ones, and treat names and paths from config files as data.

## Update notice

Once a day, cchost checks npm for a newer version in the background (it never delays a command). When one exists, the CLI prints one line after a command and the web view shows **Update to x.y.z** in the sidebar. Turn it off with `CCHOST_NO_UPDATE_CHECK=1`; it is also off when `CI` or `NO_UPDATE_NOTIFIER` is set.

## Troubleshooting

Run `cchost doctor` first — it checks Node, Claude Code version, profile integrity, symlinks, and the shared pool.

**`Claude Code does not appear to be installed`** — install with `npm install -g @anthropic-ai/claude-code` and verify `claude --version` runs in a fresh terminal.

**`warning: Claude Code <version> is older than 2.1.140`** — earlier versions on Windows read `.claude.json` from `%USERPROFILE%` regardless of `CLAUDE_CONFIG_DIR`, breaking isolation. Run `claude update`.

**`warning: ANTHROPIC_API_KEY ... may override the subscription login`** — a globally exported API key takes precedence over a profile's OAuth login. Unset it in that shell (`unset ANTHROPIC_API_KEY`, and the same for `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`) or use a custom-endpoint profile.

**`Profile "<name>" does not exist`** — `cchost use` does not auto-create profiles. Run `cchost add <name>` first.

**Profile name rejected** — names must not contain path separators, whitespace, `..`, leading dots, or DOS reserved names (`CON`, `PRN`, `COM1`…). Use letters, digits, dashes, and underscores.

## License

MIT
