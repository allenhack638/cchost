#!/usr/bin/env node
'use strict';
const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  console.log('2.1.59 (Claude Code)');
  process.exit(0);
}
console.log('ARGS:' + JSON.stringify(argv));
process.exit(0);
