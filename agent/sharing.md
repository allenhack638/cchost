# Sharing

Each profile has 7 resources, each either **shared** (a link into
`~/.claude`, the pool, seen by every sharing profile and by plain `claude`) or
**private** (the profile's own copy).

| Group | Resources |
|---|---|
| projects | `projects/` (session history, per-project memory) |
| tools | `skills/`, `agents/`, `commands/` |
| config | `mcp.json`, `settings.json`, `CLAUDE.md` |

Logins (`.credentials.json`, `.claude.json`, `.cc-env.json`) are never shared.

## Check

`cchost list <name> --json` shows each resource's state: `shared`, `private`,
`empty`, `missing` or `foreign-link`.

## Make private

```
cchost unlink <name> --config --dry-run --json
```

The current shared content is copied in first, so nothing disappears. From
then on, changes stay in that profile.

## Share again

```
cchost link <name> --config --dry-run --json
```

`link` refuses a resource that has private content (warning with
`code: private-content`). Options to offer the person:

- `--backup`: keep their copy as `<resource>.cchost-backup-<time>` in the
  profile, then share. Ask first.
- leave it private.

A private copy identical to the pool is re-shared without a backup.

## Top up a private profile

```
cchost copy default <name> --dry-run --json      # adds what it lacks, no overwrite
```

`--force` overwrites; ask first.

Sharing `config` (mcp.json) also means the profile gets the pool's MCP
servers; see `cchost agent mcp`.
