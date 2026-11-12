# Health and fixes

```
cchost doctor --json                 # all checks; status ok | warn | error
cchost doctor --fix --dry-run --json # which safe fixes would run
cchost doctor --fix --json           # apply the safe fixes
```

Doctor exits 0 (ok), 1 (warnings) or 2 (errors). Explain warnings in plain
words; each comes with a `fix` and often a `cmd`.

Some fixes need confirmation (`--force`, e.g. resetting a corrupt
`.claude.json`). Do not use `--force` without asking.

## Common situations

| Symptom | What to do |
|---|---|
| Profile not logged in | Person runs `! cchost use <p>`, then `/login` |
| Custom endpoint "has no token" | Person runs `! cchost token <p>` |
| MCP server missing in a profile | `cchost mcp list`, then `cchost agent mcp` |
| A resource is "missing" or "broken" | `cchost doctor --fix` relinks it |
| `claude` not found | Install Claude Code: `curl -fsSL https://claude.ai/install.sh \| bash` |
| Update available | `npm install -g cchost@latest` (ask first) |
| Skills outdated | `cchost skill install` |

The web view (`cchost ui`) shows the same checks with Fix buttons.
