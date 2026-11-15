# Pinned folders

A pin ties a folder (and everything under it) to one profile. In a pinned
folder, `cchost go` launches Claude under that profile and `cchost find` only
sees that folder's conversations under that account. Pins live in
`~/.claude-profiles/.cchost.json`; nothing is written into the folder.

## See them

```
cchost which --json      # what `go` and `find` would do in the current folder, and why
cchost pins --json       # every pin; flags folders or profiles that are gone
```

## Change them

```
cchost pin <profile> --dry-run --json                 # the current folder
cchost pin <profile> --path=<folder> --dry-run --json
cchost unpin [--path=<folder>] --dry-run --json
```

Then the same without `--dry-run`, after the person agrees. The deepest pin
wins, so a subfolder can be pinned to a different profile. Home and
filesystem roots cannot be pinned.

## The .cchost file

A repo may contain a one-line `.cchost` file naming a profile. It is only a
suggestion: `find` narrows to it straight away, but `go` asks the person once,
at a terminal, before pinning. You cannot confirm it for them: without a
terminal `cchost go` exits 2. Ask the person to run `! cchost go` or pin it
with `cchost pin <profile>` after they agree. Never create or edit a
`.cchost` file to change which account a folder uses; use `cchost pin`.

## Launch

`cchost go [...claude args]` runs Claude in the current folder under the
pinned profile. Without a pin, at a terminal, it lists the accounts, launches
the one the person picks and offers to pin the folder. Without a terminal it
uses the named existing account, or stops and says how to pin.

Pins do not change what is shared. A profile that shares `projects/` still
sees every conversation in the pool through `claude --resume`. To keep a
profile's history apart, unshare it: see `cchost agent sharing`.
