# Set up cchost

Goal: every account the person uses is a named profile, sharing what they want
shared, with their MCP servers where they need them. Work through the steps in
order; re-read `cchost status --json` whenever you are unsure where you are.

## 0. Is cchost installed?

```
cchost --version
```

- **Not found:** ask "cchost isn't installed. Install it with
  `npm install -g cchost@latest`?" Install only after they agree. If npm is
  missing, tell them to install Node.js 18+ first.
- **Found:** continue. If `status` shows `cchost.updateAvailable`, offer
  `npm install -g cchost@latest` before going on.

Then read the state:

```
cchost status --json
```

- `claude.found` false → they need Claude Code first:
  `curl -fsSL https://claude.ai/install.sh | bash` (ask first).
- `profiles` is empty → **First-time setup** below.
- `profiles` is not empty → **Already set up** below.

## First-time setup

Ask these together, in one message, with sensible defaults:

1. **Existing account** (only if `existing.found` and `existing.loggedIn`):
   "You already use Claude Code as <existing.email>. What should we call this
   account? (e.g. personal)". Naming it moves and copies nothing; plain
   `claude` keeps working.
2. **Other accounts:** "Which other accounts do you want? For each: a short
   name, and whether it is a Claude subscription login or a custom endpoint
   (then its base URL, e.g. https://api.moonshot.ai/anthropic)."
3. **Privacy:** "By default every profile shares history, skills and settings.
   Should any profile keep some of them to itself? Groups: projects
   (history), tools (skills/agents/commands), config (MCP/settings/CLAUDE.md)."
4. **MCP servers** (if `existing.mcp` is not empty): "Your account has these
   MCP servers: <names>. Share them with every profile?"

Then preview everything, show one combined plan, and wait for a yes:

```
cchost add <name> --existing --dry-run --json
cchost add <profile> --dry-run --json
cchost add <profile> --private=projects,config --dry-run --json
cchost add <profile> --custom --base-url=<url> --dry-run --json
cchost mcp copy default pool --dry-run --json
```

`default` means the existing account, named or not. Apply the same commands
without `--dry-run` (keep `--json`), in this order. Check every result's
`ok`; if one fails, stop and explain it.

`mcp copy default pool` shares the servers with every profile that shares
config (`mcp.json`): cchost writes them into each one's `.claude.json`.

### Hand over the human steps

For each profile in `status` with `loggedIn: false` and `kind: subscription`:

> Run `! cchost use <profile>`, type `/login`, finish in the browser, then
> type `/exit` and tell me when done.

For each with `needsToken: true`:

> Run `! cchost token <profile>` and paste the API key (it stays hidden).

Wait for them, then re-check `cchost status --json`.

### Finish

```
cchost doctor --json
cchost skill install --dry-run --json      # offer, then apply
```

Summarise: the profiles, how to start each (`cchost use <profile>`, or plain
`claude` for the existing account), what is shared, and that `cchost ui`
opens a web view of all of this.

## Already set up

Summarise `cchost status --json` in a few lines: profiles, who is logged in,
MCP servers, and anything in `next` and `issues`. Then ask what they want to
change. Use `cchost agent profiles|sharing|mcp|doctor|backups` for the details
of each kind of change. Same rules: preview, ask, apply, re-check.
