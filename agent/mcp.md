# MCP servers

Claude Code reads MCP servers from each account's `.claude.json`:

- **user scope:** available in every folder
- **local scope:** only in one project folder

cchost manages both. Targets are profile names, the name of the existing
account (or `default` for it, named or not), or `pool`.

**The pool** (`~/.claude/mcp.json`) is the shared list. Every profile that
shares `mcp.json` gets the pool's servers written into its user scope, and so
does the existing account. cchost remembers which copies it made: removing a
server from the pool removes only those copies, never servers the person
added to a profile themselves.

## See

```
cchost mcp list --json             # pool and every profile
cchost mcp list <name> --json
```

Env and header values and secret-looking arguments are hidden (`envKeys`
and `headerKeys` list only the names). Do not try to read the values.

## Copy between profiles

```
cchost mcp copy <from> <to> [<to>...] --dry-run --json
cchost mcp copy <from> <to> --server=dbeaver,playwright --dry-run --json
cchost mcp copy <from> <to> --scope=all --dry-run --json   # include project servers
```

- An identical server is reported as `same`.
- A different server with the same name is refused (`code: conflict`).
  Replace it with `--force` only if the person agrees.
- Copies keep their secrets inside cchost; you never see them.

## Share with every profile

```
cchost mcp copy <from> pool --server=<name> --dry-run --json
```

After the real run, cchost syncs the pool into every sharing profile.
Profiles that keep their own `mcp.json` are listed in `status` with
`sharesMcp: false`; copy into those directly.

## Remove

```
cchost mcp remove <name>|pool <server> --dry-run --json
```

Removing from `pool` also removes the synced copies. Ask first.

## Out of sync

`cchost status --json` shows `pool.mcpDrift`. Fix with:

```
cchost mcp sync --dry-run --json
```

Running sessions pick up MCP changes after a restart.
