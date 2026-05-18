# Changelog

All notable changes to `cchost` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-05-19

### Added

- **Per-profile custom API endpoints (`cc env`).** A profile can now route
  through any Anthropic-compatible third-party provider (Moonshot/Kimi,
  OpenRouter, Requesty, self-hosted vLLM, corporate proxies) instead of
  Anthropic's subscription OAuth.
  - `cc env <profile>` — interactive wizard; the token is never echoed.
  - `cc env <profile> --base-url=URL --token=TOKEN [--model/--opus/--sonnet/--haiku/--subagent=NAME]`
    — non-interactive create, or partial update on an existing endpoint profile.
  - `cc env <profile> show [--reveal]` — print the config; the token is masked
    by default, `--reveal` prints it in full.
- `cc use` injects the corresponding `ANTHROPIC_*` / `CLAUDE_CODE_*` env vars
  from `.cc-env.json` and prints a one-line endpoint + billing banner to stderr.
- `cc list` gained an `Endpoint` column (the endpoint host, or `subscription`).
- README section "Custom endpoints (Kimi, OpenRouter, etc.)" with a billing
  note and a worked Moonshot example.

### Security

- `.cc-env.json` holds a third-party API key. It is treated like
  `.credentials.json`: written with user-only file permissions, and never
  copied or linked by `cc migrate` / `cc link`.
- A profile is born OAuth or endpoint and stays that way — `cc env` refuses to
  run on a profile that already has Anthropic OAuth credentials.

### Notes

- Endpoint profiles bill through the third-party provider, not your Anthropic
  subscription.

## [0.2.1] - 2026-05-18

### Added

- `cc link` / `cc unlink` now operate on `projects/`, `skills/`, `agents/`,
  and `commands/` (previously `projects/` only), with per-directory
  partial-failure handling.
- `cc migrate` extended: `default → <profile>` also copies `mcp.json`,
  `settings.json`, and `CLAUDE.md`; `--force` overwrites instead of
  skip-on-collision.
- `cc list` reports shared state as `N/4`.
- README: migrate-vs-link artifact table.

## [0.2.0] - 2026-05-16

### Added

- `cc --version` / `cc -v` — prints the installed version.
- `cc doctor [--fix [--force]] [--json]` — environment, storage, and platform
  diagnostics with safe and confirmation-gated fixes.

### Removed

- The `cc add` alias-masking feature — Claude Code re-syncs account fields from
  the server on every launch, so masking was not worth shipping.

## [0.1.2] - 2026-05-15

### Changed

- `sessions/` dropped from `share`, `migrate`, and `cc list` — it is transient
  per-process state and must stay per-profile.
- Cross-platform claim narrowed to the verified scope (Windows and Linux).

[0.3.0]: https://github.com/allenhack638/cchost/releases/tag/v0.3.0
[0.2.1]: https://github.com/allenhack638/cchost/releases/tag/v0.2.1
[0.2.0]: https://github.com/allenhack638/cchost/releases/tag/v0.2.0
[0.1.2]: https://github.com/allenhack638/cchost/releases/tag/v0.1.2
