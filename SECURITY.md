# Security

cchost stores Claude Code login credentials and, for custom endpoints, third-party API keys. If you find a security problem, please report it privately.

## Reporting a vulnerability

Use GitHub's private reporting: open the **Security** tab and click **Report a vulnerability**. If you'd rather use email, write to tech@cyberjoar.com.

Please don't open a public issue for security problems.

## What cchost stores

Profile directories under `~/.claude-profiles/` hold real credentials:

- `.credentials.json` — Claude Code OAuth tokens
- `.claude.json` — account state
- `.cc-env.json` — custom-endpoint API key, when set

cchost keeps these on your machine. `cc migrate` and `cc link` never copy or link them between profiles, `.cc-env.json` is written with user-only file permissions, and the shipped `.gitignore` excludes every profile directory so they can't be committed by accident.

Treat `~/.claude-profiles/` like your SSH keys: don't commit it, don't share it, don't sync it to public cloud storage.
