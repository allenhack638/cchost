#!/usr/bin/env node
'use strict';
const argv = process.argv.slice(2);
console.log('ARGS:' + JSON.stringify(argv));
console.log('CLAUDE_CONFIG_DIR:' + (process.env.CLAUDE_CONFIG_DIR || ''));
console.log('CC_ACTIVE_PROFILE:' + (process.env.CC_ACTIVE_PROFILE || ''));
process.exit(0);
