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
  }
  const tagline = 'Multi-profile launcher for Claude Code';
  return BANNER + '         ' + '\n\n';
}

module.exports = { renderBanner, BANNER };
