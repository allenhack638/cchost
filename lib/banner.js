'use strict';

// ASCII banner shown on `cc`, `cc help`, `cc --help`, and the unknown-command
// fallback. Generated once with figlet's "ANSI Shadow" font and frozen as a
// literal so the runtime has no dependency on figlet. Plain ASCII / no color —
// works in any terminal, including ones with NO_COLOR or no TTY.

const BANNER =
  '\n' +
  ' ██████╗ ██████╗██╗  ██╗ ██████╗ ███████╗████████╗\n' +
  '██╔════╝██╔════╝██║  ██║██╔═══██╗██╔════╝╚══██╔══╝\n' +
  '██║     ██║     ███████║██║   ██║███████╗   ██║   \n' +
  '██║     ██║     ██╔══██║██║   ██║╚════██║   ██║   \n' +
  '╚██████╗╚██████╗██║  ██║╚██████╔╝███████║   ██║   \n' +
  ' ╚═════╝ ╚═════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝   ╚═╝   \n';

function renderBanner() {
  let version = '';
  try {
    version = require('../package.json').version;
  } catch {
    // package.json missing — banner still renders without a version.
  }
  const tagline = 'Multi-profile launcher for Claude Code';
  const versionLine = version ? `v${version} — ${tagline}` : tagline;
  return BANNER + '         ' + versionLine + '\n\n';
}

module.exports = { renderBanner, BANNER };
