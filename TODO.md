# TODO

Deferred work for cchost. Ordered by priority. Feature ideas are gated on real
usage — do not build them on spec alone.

## v0.1.x polish — small, not features

- [ ] Add macOS to the CI test matrix in `.github/workflows/ci.yml`. The README
      now says macOS is "expected but not verified" — verifying it lets that
      claim be tightened.
- [ ] Make `tests/spawn-e2e.test.js` cross-platform. It is currently gated to
      `win32` (the `claude` shim needs an exec bit on POSIX), so it is skipped on
      the Ubuntu runner and would be skipped on macOS.

## v0.3 feature candidates — gated on real usage

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

## QA-audit leftovers — nice-to-have

- [ ] `cc list --json` embeds absolute home paths — consider a home-relative form
      or a `--no-paths` toggle so piped output does not leak the OS username.
- [ ] Dedupe `isLink` / `isLinkLike` — identical helper duplicated in
      `lib/cli.js` and `lib/share.js`.
- [ ] Dedupe `usageError` — duplicated in `lib/cli.js`, `lib/migrate.js`,
      and `lib/profiles.js`.
- [ ] Move the version cache out of the data dir — `~/.claude-profiles/.cc-cache.json`
      sits alongside profile data; a `.cache/` subdir (or `XDG_CACHE_HOME`) is cleaner.
- [ ] Cosmetic: file-name collisions on link produce names like
      `dummyagent.md__v2test2` (the `__<profile>` suffix lands after the
      extension). Functionally correct; a nicer form would be
      `dummyagent__v2test2.md`. Found during the v0.2 QA audit.

## Done

- [x] `cc --version` / `cc -v` flag — prints the installed version from package.json.
- [x] `cc doctor` / `cc doctor --fix [--force]` — environment, storage, and
      platform diagnostics with safe and confirmation-gated fixes.
- [x] Removed the `cc add` alias masking feature — Claude Code re-syncs
      `emailAddress` / `organizationName` / `organizationType` from the server on
      every launch, so masking only `displayName` was not worth shipping.

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
