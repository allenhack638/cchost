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

## Masking validation — decision pending

- [ ] Finish the `cc add` alias masking test against a real Claude login (see
      the procedure given in chat: add a profile with `--email`, log in with a
      real account, re-run `cc use`, check `/status` and whether a server
      re-sync overwrites the alias). Outcome:
      - Masking holds → drop the `EXPERIMENTAL` marker from `cc add` help + README.
      - Masking fails / gets overwritten → keep `EXPERIMENTAL` or reconsider the feature.

## v0.2 feature candidates — gated on real usage

- [ ] `cc link-skills` — skills are isolated per profile under
      `$CLAUDE_CONFIG_DIR/skills/`, so a skill in `~/.claude/skills/` is invisible
      to `cc`-launched Claude. Mirror `cc link` (projects) to share a skills pool.
- [ ] Update-available banner — startup check that notifies when a newer cchost
      version is on npm. Use the existing `~/.claude-profiles/.cc-cache.json`
      pattern; keep it non-blocking and respect `NO_COLOR`.

## QA-audit leftovers — nice-to-have

From the npm-package-qa-auditor pass:

- [ ] `cc list --json` embeds absolute home paths — consider a home-relative form
      or a `--no-paths` toggle so piped output does not leak the OS username.
- [ ] Dedupe `isLink` / `isLinkLike` — identical helper duplicated in
      `lib/cli.js` and `lib/share.js`.
- [ ] Dedupe `usageError` — duplicated in `lib/cli.js` and `lib/migrate.js`.
- [ ] Move the version cache out of the data dir — `~/.claude-profiles/.cc-cache.json`
      sits alongside profile data; a `.cache/` subdir (or `XDG_CACHE_HOME`) is cleaner.

## Done

- [x] `cc --version` / `cc -v` flag — prints the installed version from package.json.
