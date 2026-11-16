'use strict';

// Entry point: reads the command and hands it to its module.

const profiles = require('../profiles');
const pinsLib = require('../pins');
const color = require('../color');
const { renderBanner } = require('../banner');
const paths = require('../paths');
const { printHelp } = require('./help');
const { io } = require('./term');
const { cmdUse, cmdGo } = require('./launch');
const { cmdMcp } = require('./mcp');
const { cmdAdd, cmdList, cmdRemove, cmdLink, cmdUnlink, cmdCopy, cmdMigrate, cmdToken } = require('./profiles');
const { cmdPin, cmdUnpin, cmdPins, cmdWhich, cmdFind, cmdIndex, cmdOpen } = require('./search');
const { cmdStatus, cmdDoctor, cmdUi, cmdBackups, cmdRestore, cmdAgent, cmdSkill } = require('./status');

// Bare `cchost`: who you are and the few commands used every day. The full
// reference is `cchost --help`.
function printHome() {
  const w = (t = '') => process.stdout.write(`${t}\n`);
  const label = (t) => color.stdout.dim(t.padEnd(10));
  process.stdout.write(renderBanner().replace(/\n\n$/, '\n'));
  w();
  let names = [];
  try {
    names = profiles.listProfiles().map((p) => p.name);
  } catch { /* unreadable profiles dir: still show the commands */ }
  w(`  ${label('Profiles')}${names.length ? names.join('  ') : `none yet — ${color.stdout.bold('cchost add <name>')}`}`);
  try {
    const hit = pinsLib.resolve();
    if (hit && hit.kind === 'pin') w(`  ${label('Here')}${paths.shortPath(hit.dir)} → ${color.stdout.bold(hit.profile)}`);
    else if (names.length && !pinsLib.isRootLike(process.cwd())) w(`  ${label('Here')}${color.stdout.dim(`not pinned · cchost go asks which account and can pin it`)}`);
  } catch { /* no pin info */ }
  w();
  const rows = [
    ['Start', 'cchost use <profile>', 'cchost go'],
    ['Find', 'cchost find <words>', 'cchost open <id>'],
    ['Manage', 'cchost ui', 'cchost status'],
    ['Help', 'cchost --help', 'cchost help <command>'],
  ];
  for (const [k, a, b] of rows) w(`  ${label(k)}${a.padEnd(24)}${b}`);
  w();
  w(`  ${color.stdout.dim('Docs: github.com/allenhack638/cchost')}`);
  return 0;
}

async function run(argv) {
  const [action, ...rest] = argv;
  if (!action) return printHome();
  if (action === '--help' || action === '-h') {
    printHelp();
    return 0;
  }
  if (action === '--version' || action === '-v') {
    const { version } = require('../../package.json');
    process.stdout.write(version + '\n');
    return 0;
  }
  if (action === 'help') {
    printHelp(rest[0]);
    return 0;
  }
  if (action === 'env') {
    process.stderr.write(
      color.stderr.red(
        "'cchost env' was removed in v0.3.1. Configure a custom endpoint with " +
          "'cchost add <profile> --custom', and view it with 'cchost list <profile>'.",
      ) + '\n',
    );
    return 2;
  }
  switch (action) {
    case 'add':
      return await cmdAdd(rest);
    case 'use':
      return await cmdUse(rest);
    case 'list':
      return cmdList(rest);
    case 'copy':
      return await cmdCopy(rest);
    case 'migrate':
      return await cmdMigrate(rest);
    case 'link':
      return await cmdLink(rest);
    case 'unlink':
      return await cmdUnlink(rest);
    case 'remove':
      return await cmdRemove(rest);
    case 'doctor':
      return await cmdDoctor(rest);
    case 'ui':
      return await cmdUi(rest);
    case 'status':
      return await cmdStatus(rest);
    case 'mcp':
      return await cmdMcp(rest);
    case 'backups':
      return await cmdBackups(rest);
    case 'restore':
      return await cmdRestore(rest);
    case 'agent':
      return await cmdAgent(rest);
    case 'skill':
    case 'skills':
      return await cmdSkill(rest);
    case 'token':
      return await cmdToken(rest);
    case 'pin':
      return await cmdPin(rest);
    case 'unpin':
      return await cmdUnpin(rest);
    case 'pins':
      return await cmdPins(rest);
    case 'which':
      return await cmdWhich(rest);
    case 'go':
      return await cmdGo(rest);
    case 'find':
      return await cmdFind(rest);
    case 'open':
      return await cmdOpen(rest);
    case 'index':
      return await cmdIndex(rest);
    default: {
      process.stderr.write(color.stderr.red(`Unknown command: ${action}`) + '\n\n');
      printHelp();
      return 2;
    }
  }
}

module.exports = { run, io };
