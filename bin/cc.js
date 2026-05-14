#!/usr/bin/env node
'use strict';

const { run } = require('../lib/cli');

(async () => {
  try {
    const code = await run(process.argv.slice(2));
    process.exit(typeof code === 'number' ? code : 0);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    process.stderr.write(message + '\n');
    const code = err && Number.isInteger(err.exitCode) ? err.exitCode : 1;
    process.exit(code);
  }
})();
