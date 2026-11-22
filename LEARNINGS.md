# Learnings

Rules learned from real bugs and reviews. Each point says what to check and
where it came from. Read this before opening a PR; add to it after every
review that finds something.

## Pre-PR checklist

- [ ] Two cchost processes doing this at once: what breaks?
- [ ] Does this act on the thing the user actually runs, not a copy of it?
- [ ] With `--json`, is stdout one JSON document and nothing else, including
      output from child processes?
- [ ] New command? Added to the dispatcher, `CCHOST_FIRST_ARGS`, help, the
      README table and the agent guide's known commands.
- [ ] Does any hot path (every command, notices, home screen) now spawn a
      process or touch the network?
- [ ] Can it run inside the web view? Then nothing may block the server.
- [ ] Is every cache invalidated when what it describes changes?
- [ ] Do the tests use only a temp HOME and a temp PATH?
- [ ] Tried it for real once (sandbox prefix or HOME), not only with fakes?

## Concurrency and locks

- A lock needs an owner. Write a random token into it, and only remove a
  lock whose token is yours. (PR #3: release removed whichever lock existed.)
- Never expire a lock by age while its owner is alive. Expire on a dead pid,
  or after a hard cap that every operation under the lock is guaranteed to
  finish within: give the work under the lock timeouts that add up to less
  than the cap. (PR #3: a 15 min expiry with no install timeout.)
- Reclaiming an expired lock is its own race: two processes see it expired,
  one removes it and takes a new one, the other removes the new one. Do the
  check-then-remove under a short second lock (a guard held for ms). Moving the
  lock aside and putting it back still has a window. (PR #3, round 3.)
- A file created with `wx` can be read empty while its writer is mid-write.
  Treat empty or unparsable as held until it is clearly old.
- Releasing must not depend on something a crashed process can leave behind
  (the guard). Ask: if this cleanup fails, how long is everyone blocked?
  (PR #3, round 4.)
- Stress-test locks with real processes (8 x thousands of acquisitions,
  planting expired locks) and assert no two holders. Unit tests cannot show
  races.

## Acting on the right target

- When several installs can exist (npm global, standalone, another prefix),
  decide from the executable that actually runs (`findClaude()` + realpath),
  never from "an npm copy exists". (PR #3: updated an unused npm copy.)
- A repair offered for a specific broken thing must target that thing, and
  verify that thing afterwards, not whatever comes first on PATH. (PR #3:
  doctor reported the npm copy, then fixed and checked the standalone one.)
- Check symlinks with `existsSync` (follows the link) when you need the
  target; `lstat` only proves the link file exists. (PR #3: a dangling link
  looked like a complete install.)

## Output channels

- In `--json` mode, child processes must not inherit stdout. Pass
  `stdio: ['ignore', 2, 2]` (or capture). Applies to every path that can run
  under `--json`, including doctor fixes, not only the command you wrote.
  (PR #3: `doctor --fix --json` mixed npm output into the JSON.)
- Progress text goes through the `write` sink the caller passes, so JSON mode
  can route it to stderr.

## CLI surface consistency

- `cc` forwards anything not in `CCHOST_FIRST_ARGS` to the C compiler. Every
  new command must be added there; `tests/ccforward.test.js` now checks every
  `case` in the dispatcher. (PR #3: `cc update claude` ran the compiler.)
- Commands named in `agent/*.md` must exist with those flags; the agent guide
  contract test enforces it. Add new commands to its `known` map.
- Keep hints in sync: when a better command exists, grep for the old advice
  (`claude update`, `npm install -g ...`) across lib, help, README and agent.

## Hot paths and responsiveness

- Notices and the home screen run after every command. They may read caches
  only: no `spawnSync`, no network. (PR #3: the notice ran `claude --version`,
  up to 5 s.)
- The web view runs doctor fixes and actions in its server process. Anything
  long (npm, downloads) must be async (`spawn` + promise), or it freezes every
  request. (PR #3.)
- Long child processes need a timeout.

## Caches and staleness

- A cache must say what it describes (path + mtime) and be ignored when that
  changes. After changing the thing (an update), refresh the cache. (PR #3:
  the notice kept offering the update just installed.)
- Compute cache and state file paths from `os.homedir()` at call time, not at
  module load, or tests that stub the home folder write to the real one.
  (PR #3: `spawn.js` wrote test data into the real `.cc-cache.json`.)

## Test hygiene

- Every test that can reach a real executable sets `PATH` to a temp dir in
  `beforeEach`. (PR #3: a test ran a real `claude update` on the dev machine.)
- Stub `os.homedir()` and point overrides (`CCHOST_NPM_ROOT`) at temp dirs.
  Check afterwards that nothing in the real `~/.claude-profiles` changed.
- `fs.writeFileSync(path, data, { mode })` only sets the mode when it creates
  the file; `chmod` explicitly when overwriting.
- `touch` on a symlink changes its target; use `touch -h` to age the link.

## npm and Claude Code quirks

- npm 12 blocks package install scripts unless allowed. Claude Code's
  `postinstall` unpacks the real binary, so a blocked script leaves a
  placeholder that prints `claude native binary not installed`. Install with
  `--allow-scripts=@anthropic-ai/claude-code`, and run its `install.cjs` if
  the placeholder remains.
- An interrupted `npm install -g` leaves `bin/.claude-XXXXXXXX` and
  `@anthropic-ai/.claude-code-XXXXXXXX`. Only remove them once older than a
  few minutes: another update may still be running.
- npm masks anything that looks like a secret in its output, paths included
  (`***`). Don't trust parsed npm output blindly; fall back to Node's prefix.
- After publishing, `npm view` can show the version minutes before the
  tarball downloads (404). Retry the install.
- Every Claude Code session self-updates. With many profiles that means
  parallel installs into one folder; cchost launches set
  `DISABLE_AUTOUPDATER=1`.

## Review process

- Greptile finds real bugs: treat every finding as valid until proven
  otherwise, fix it, and push. Each fix can create a new edge case, so expect
  several rounds and re-read the new code with the same questions.
- Old review threads move to the newest commit when their line is unchanged;
  check the summary's "Last reviewed commit" and score, not the thread list.
