'use strict';

const BANNER =
  '\n' +
  '   ██████╗ ██████╗██╗  ██╗ ██████╗ ███████╗████████╗\n' +
  '  ██╔════╝██╔════╝██║  ██║██╔═══██╗██╔════╝╚══██╔══╝\n' +
  '  ██║     ██║     ███████║██║   ██║███████╗   ██║   \n' +
  '  ██║     ██║     ██╔══██║██║   ██║╚════██║   ██║   \n' +
  '  ╚██████╗╚██████╗██║  ██║╚██████╔╝███████║   ██║   \n' +
  '   ╚═════╝ ╚═════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝   ╚═╝   \n';

function renderBanner() {
  let version = '';
  try {
    version = require('../package.json').version;
  } catch {
    // Not fatal — help still works if package.json is unreadable.
  }
  const tagline = 'Multi-profile launcher for Claude Code';
  const label = version ? `cchost ${version} — ${tagline}` : `cchost — ${tagline}`;
  return BANNER + '  ' + label + '\n\n';
}

module.exports = { renderBanner, BANNER };
