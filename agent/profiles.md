# Profiles

A profile is one Claude Code account: `~/.claude-profiles/<name>/`, started
with `cchost use <name>`. The account in `~/.claude` (plain `claude`) can be
named too; it then acts as a profile without moving anything.

## See them

```
cchost status --json          # everything, with suggested next steps
cchost list --json            # profiles only
cchost list <name> --json     # one profile in detail
```

## Add

```
cchost add <name> --dry-run --json                        # shares all 7 resources
cchost add <name> --private=projects,tools,config --dry-run --json
cchost add <name> --custom --base-url=<url> --dry-run --json   # custom endpoint
cchost add <name> --existing --dry-run --json             # name the ~/.claude account
```

Then the same without `--dry-run`. A subscription profile needs a login, a
custom endpoint profile needs a token. Both are the person's job:

- login: `! cchost use <name>`, then `/login`
- token: `! cchost token <name>` (hidden input)

Never pass `--token=` yourself.

## Start a session

`cchost use <name> [claude args...]` (or `cc <name>`). Arguments after the
name go to `claude` unchanged, e.g. `cchost use work --resume`.

## Remove

Ask first. Removing deletes the profile's login, sessions and private
resources; shared content in `~/.claude` stays. For the existing account it
only forgets the name.

```
cchost remove <name> --dry-run --json
cchost remove <name> --yes --json            # only after the person agreed
```

If it refuses because of private content, explain what would be lost; add
`--force` only if they still want it gone.
