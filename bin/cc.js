#!/usr/bin/env node
'use strict';

const { run } = require('../lib/cli');
const { maybeForward } = require('../lib/ccforward');

(async () => {
  try {
    const args = process.argv.slice(2);
    // Invoked as `cc` for a compile (`cc -c foo.c`)? Run the real compiler.
    const forwarded = maybeForward(args);
    if (forwarded !== null) process.exit(forwarded);
    const code = await run(args);
    process.exit(typeof code === 'number' ? code : 0);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    process.stderr.write(message + '\n');
    const code = err && Number.isInteger(err.exitCode) ? err.exitCode : 1;
    process.exit(code);
  }
})();
