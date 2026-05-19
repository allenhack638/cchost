# TODO

Deferred work for cchost. Ordered by priority. Feature ideas are gated on real
usage — do not build them on spec alone.

## v0.1.x polish — small, not features

- [ ] Add macOS to the CI test matrix in `.github/workflows/ci.yml`. The README
      now says macOS is "expected but not verified" — verifying it lets that
      claim be tightened. (`tests/spawn-e2e.test.js` is already cross-platform,
      so it will run as-is once macOS is in the matrix.)

## v0.4 feature candidates — gated on real usage

- [ ] Plugin sharing via `cc link --include-plugins` — `plugins/` was
      deliberately excluded from v0.2 sharing because it carries auth tokens.
      A future opt-in flag could share it for users who accept that trade-off.
- [ ] `cc mcp copy <src> <dest>` — per-entry MCP server copy, so individual
      servers can be moved between profiles without copying the whole `mcp.json`.
- [ ] Selective `settings.json` merging — merge specific keys between profiles
      instead of the all-or-nothing file copy `cc migrate` does today.
- [ ] Update-available banner — startup check that notifies when a newer cchost
      version is on npm. Use the existing `~/.claude-profiles/.cc-cache.json`
      pattern; keep it non-blocking and respect `NO_COLOR`.

## Done

- [x] `cc --version` / `cc -v` flag — prints the installed version from package.json.
- [x] `cc doctor` / `cc doctor --fix [--force]` — environment, storage, and
      platform diagnostics with safe and confirmation-gated fixes.
- [x] Removed the `cc add` alias masking feature — Claude Code re-syncs
      `emailAddress` / `organizationName` / `organizationType` from the server on
      every launch, so masking only `displayName` was not worth shipping.
- [x] `tests/spawn-e2e.test.js` runs on Linux/macOS, not just Windows. The
      POSIX `claude` shim is committed with the exec bit (mode 100755) and the
      suite re-applies it in `beforeAll` so a Windows clone can't drop it.

## v0.3.1 — shipped 2026-05-19

Custom-endpoint configuration unified into `cc add`. The standalone `cc env`
command from v0.3.0 is removed.

- [x] `cc add <profile> --custom` — create a custom-endpoint profile (wizard
      or `--base-url/--token/--model/...` flags). Re-running it on an existing
      endpoint profile edits in place.
- [x] `cc add --custom` is atomic — a cancelled wizard, or a config that fails
      validation, removes the freshly-created profile directory.
- [x] `cc list <profile>` — per-profile detail view; replaces `cc env show`.
      `--reveal` unmasks the token, `--json` emits an object.
- [x] Removed `cc env` / `cc env show`.

### v0.3.1 design rationale

- Endpoint profiles are rare to create and rarer to edit; editing is almost
  always a one-field change (key rotation, model bump). So the surface was
  optimised for *few commands*, not fast edits — re-running `cc add --custom`
  covers the rare edit without a dedicated `cc env`/`cc set` verb.
- `cc env` did not create profiles, so a custom endpoint took two commands
  (`cc add` + `cc env`). Folding `--custom` into `cc add` makes it one, and
  leaves each command with a single job.

## v0.3 — shipped 2026-05-19

Per-profile custom API endpoints: a profile can route through any
Anthropic-compatible third-party provider (Moonshot/Kimi, OpenRouter, vLLM,
corporate proxy) instead of Anthropic's subscription OAuth.

- [x] `cc env <profile>` — interactive wizard (token entry is not echoed;
      edit mode prefills current values).
- [x] `cc env <profile> --base-url=… --token=… [--model/--opus/--sonnet/
      --haiku/--subagent=…]` — non-interactive create / partial update.
- [x] `cc env <profile> show [--reveal]` — masked by default; `--reveal`
      prints the full key with a warning.
- [x] `cc use` injects `ANTHROPIC_*` / `CLAUDE_CODE_*` env vars from
      `.cc-env.json` and prints a one-line endpoint/billing banner to stderr.
- [x] `cc list` gained an `Endpoint` column (host, or `subscription`).
- [x] `.cc-env.json` is never migrated and never linked — same security
      category as `.credentials.json`; written with user-only permissions.
- [x] Rule: a profile is born OAuth or endpoint and stays that way —
      `cc env` refuses to run on a profile with prior OAuth state.

### v0.3 scope decisions

- No `cc env clear` and no `--force` override — removing endpoint config
  means `cc remove` + recreate. The OAuth-state block is absolute.
- Windows file lock-down uses `icacls /grant DOMAIN\user` (qualified). A bare
  username can collide with the computer name and resolve to a broken
  principal that locks out the file's own owner — verified during testing.
- Endpoint URLs are not pinged for validation; the user discovers a bad
  endpoint at first message.

## v0.2 — shipped 2026-05-18

Artifact sharing extended from `projects/` to four directories, plus an
extended `cc migrate`. All items verified by a 10-phase QA audit on 2026-05-18.

- [x] `cc link` / `cc unlink` operate on `projects/`, `skills/`, `agents/`,
      `commands/` — same junction/symlink mechanics, rename-on-collision,
      idempotent.
- [x] Per-directory partial-failure handling in `cc link` — one directory
      failing no longer aborts the other three; a per-directory summary is
      printed and the exit code reflects any failure. (Fixed during the QA
      audit: the first implementation threw on the first directory failure.)
- [x] `cc migrate default <profile>` also copies `mcp.json`, `settings.json`,
      and `CLAUDE.md` (skip-on-collision; `--force` to overwrite). End-of-run
      summary lists every item as copied / skipped / not present at source.
- [x] `cc migrate default shared` copies only the four artifact dirs — the
      per-profile config files are intentionally excluded from shared.
- [x] `cc migrate shared <profile>` copies the four artifact dirs back.
- [x] `--force` flag on `cc migrate` — overwrites instead of skip-on-collision,
      with a warning that existing destination content will be cleared.
- [x] `cc list` reports shared state as `N/4` (count of linked artifact dirs).
- [x] README: migrate-vs-link artifact table.

### v0.2 scope decisions

- `plugins/` is **not** shared or migrated — it carries auth tokens. Deferred
  to v0.3 behind an explicit opt-in flag.
- `mcp.json` / `settings.json` / `CLAUDE.md` are **migrate-only** (default →
  profile). They are not linked and not copied to shared, because they carry
  per-profile config and auth tokens that should not leak across accounts.
- `.credentials.json` and `.claude.json` are never touched by any command.
