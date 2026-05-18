#!/usr/bin/env node
'use strict';
const argv = process.argv.slice(2);
console.log('ARGS:' + JSON.stringify(argv));
console.log('CLAUDE_CONFIG_DIR:' + (process.env.CLAUDE_CONFIG_DIR || ''));
// Dump endpoint-related env vars so cc-env injection can be verified end-to-end.
for (const k of [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
]) {
  console.log('ENV:' + k + '=' + (process.env[k] || ''));
}
process.exit(0);
