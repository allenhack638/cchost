#!/usr/bin/env node
'use strict';

const { run } = require('../lib/cli');
const { maybeForward } = require('../lib/ccforward');
const update = require('../lib/update');
const color = require('../lib/color');

function showUpdateNotice(args) {
  if (update.disabled() || !process.stderr.isTTY) return;
  if (args.includes('--json') || ['-v', '--version', 'ui'].includes(args[0])) return;
  const msg = update.notice();
  if (msg) process.stderr.write('\n' + color.stderr.yellow(msg) + '\n');
}

(async () => {
  try {
    const args = process.argv.slice(2);
    // Invoked as `cc` for a compile (`cc -c foo.c`)? Run the real compiler.
    const forwarded = maybeForward(args);
    if (forwarded !== null) process.exit(forwarded);
    update.checkInBackground();
    const code = await run(args);
    showUpdateNotice(args);
    process.exit(typeof code === 'number' ? code : 0);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    process.stderr.write(message + '\n');
    const code = err && Number.isInteger(err.exitCode) ? err.exitCode : 1;
    process.exit(code);
  }
})();
