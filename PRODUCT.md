# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

The CLI is Node.js (>=18) with zero runtime dependencies. The web view (`cchost ui`) must keep that: Node's built-in `http` server and one embedded HTML/CSS/JS page, no framework, no build step, nothing extra installed.

## Users

Developers who run two or more Claude Code accounts on one machine (work, personal, client; Anthropic subscription logins alongside custom API endpoints such as Kimi or OpenRouter). They know the basics of the CLI but cannot keep cchost's sharing model (link, unlink, copy across 7 resources) in their head, and today ask an agent to work out the right command.

## Product Purpose

cchost runs Claude Code under isolated profiles (`~/.claude-profiles/<name>/`, passed as `CLAUDE_CONFIG_DIR`) while sharing selected resources through the pool at `~/.claude/`. The web view is a full control panel: everything the CLI does (add and remove profiles, custom endpoints, sharing changes, copy, doctor and fixes) can be done from the page, and the page always shows the current state and exactly what each change did. Success: a user can understand their setup and change it without reading help text or asking an agent.

## Positioning

The only state that matters lives on disk: symlinks, junctions and files under `~/.claude/` and each profile. The page is a window onto that real state and onto the same core functions the CLI uses, not a separate app with its own model.

## Operating Context

Opened locally from a terminal with `cchost ui` on the user's own machine (macOS, Linux, Windows). Used alongside running Claude Code sessions. Changes touch real session transcripts, configs that execute hooks and MCP servers, and login state, so mistakes are costly.

## Capabilities and Constraints

- 7 shareable resources in 3 groups: projects (`projects/`), tools (`skills/`, `agents/`, `commands/`), config (`mcp.json`, `settings.json`, `CLAUDE.md`). Never shared: `.credentials.json`, `.claude.json`, `.cc-env.json`, `.cc-private.json`.
- Resource states: shared, private, empty, missing, foreign-link. Private-by-choice is recorded in `.cc-private.json`.
- Profiles are subscription (OAuth; macOS keeps tokens in a per-profile Keychain entry) or custom endpoint (host, token in `.cc-env.json`).
- Every change is previewed first (the same result as the CLI's `--dry-run`), applied with one confirmation, and reported per resource. Removing a profile requires typing its name, as in the CLI.
- Security: listen on 127.0.0.1 only, random token in the URL, Host header check, no CORS. Endpoint tokens are never sent to the page; emails are masked by default.
- Launching Claude (`cchost use`) stays in the terminal.

## Brand Commitments

- The web view follows the category standard on purpose (chosen 2026-11-07): a clean admin dashboard, conventions embraced without quirk. Quality bar: Vercel and Linear dashboards.

## Product Principles

- Show the real state of the disk, never a cached or assumed one.
- Nothing changes without a preview of exactly what will change.
- Every action reports what it did, resource by resource.
- One core: the page and the CLI call the same functions and get the same results.
- Never expose secrets; masked by default.

## Accessibility & Inclusion

Must work in light and dark mode and by keyboard. No product-specific standard beyond that was established.
