# Backups and undo

Before cchost changes a JSON config file (`.claude.json`, `mcp.json`, MCP
sync records), it saves the file to `~/.cchost-backups/<id>/`. The newest 30
are kept. Every changing command's result has a `backup` line with the id.

```
cchost backups --json                    # newest first: id, op, files
cchost restore <id> --dry-run --json     # what would be put back
cchost restore <id> --json               # ask first
```

A restore backs up the current files first, so it can be undone with the id
it reports.

Backups contain the same secrets as the original files and are readable by
the person only. Do not open them.

Not covered: `link`/`unlink`/`copy` of folders and `remove` (they move files
instead of editing JSON; `unlink` and `link --backup` keep copies themselves).
