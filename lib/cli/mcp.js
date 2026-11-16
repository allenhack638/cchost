'use strict';

// MCP servers across profiles: list, copy, remove, sync.

const os = require('os');

const profiles = require('../profiles');
const color = require('../color');
const errors = require('../errors');
const mcpLib = require('../mcp');
const { parseArgs, runAction } = require('./term');

const MCP_USAGE = `Usage:
  cchost mcp list [<profile>|pool] [--json]
  cchost mcp copy <from> <to>... [--server=a,b] [--scope=user|local|all] [--project=PATH] [--force] [--dry-run] [--json]
  cchost mcp remove <profile>|pool <server> [--scope=user|local|all] [--project=PATH] [--dry-run] [--json]
  cchost mcp sync [<profile>...] [--dry-run] [--json]`;

function describeServer(s) {
  const what = s.url || [s.command, ...(s.args || [])].filter(Boolean).join(' ');
  const secrets = [...s.envKeys.map((k) => `env ${k}`), ...s.headerKeys.map((k) => `header ${k}`)];
  return `${what}${secrets.length ? `  (${secrets.join(', ')}: hidden)` : ''}`;
}

function printMcp(views) {
  for (const v of views) {
    const tag = v.kind === 'pool' ? ' — shared: profiles that share mcp.json get these' : v.subscribed ? ' — gets the pool\'s servers' : '';
    process.stdout.write(`${color.stdout.bold(v.target)}${v.alias ? ' (existing account)' : ''}${tag}\n`);
    if (!v.servers.length) process.stdout.write('  (no MCP servers)\n');
    const user = v.servers.filter((s) => s.scope !== 'local');
    const local = v.servers.filter((s) => s.scope === 'local');
    for (const s of user) process.stdout.write(`  ${s.name}${s.fromPool ? ' [pool]' : ''}  ${describeServer(s)}\n`);
    const byProject = new Map();
    for (const s of local) byProject.set(s.project, [...(byProject.get(s.project) || []), s]);
    for (const [proj, list] of byProject) {
      const home = os.homedir();
      process.stdout.write(`  in ${proj.startsWith(home) ? `~${proj.slice(home.length)}` : proj}:\n`);
      for (const s of list) process.stdout.write(`    ${s.name}  ${describeServer(s)}\n`);
    }
  }
}

function splitList(v) {
  return v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
}

async function cmdMcp(rest) {
  const [sub, ...args] = rest;
  if (!sub || sub === 'help' || sub === '--help') {
    process.stdout.write(`${MCP_USAGE}\n`);
    return sub ? 0 : 2;
  }
  if (sub === 'list') {
    const { flags, positional } = parseArgs(args, { flags: ['--json'] });
    if (positional.length > 1) throw errors.usage(MCP_USAGE);
    let views;
    try {
      views = positional.length ? [mcpLib.describe(mcpLib.resolveTarget(positional[0]))] : mcpLib.listAll();
    } catch (err) {
      throw Object.assign(err, { exitCode: err.exitCode || 1 });
    }
    if (flags.has('--json')) process.stdout.write(`${JSON.stringify(positional.length ? views[0] : views, null, 2)}\n`);
    else printMcp(views);
    return 0;
  }
  const common = { flags: ['--dry-run', '--json', '--force'], values: ['--server', '--scope', '--project'] };
  const { flags, values, positional } = parseArgs(args, common);
  const opts = { dryRun: flags.has('--dry-run'), json: flags.has('--json') };
  if (sub === 'copy') {
    const [from, ...to] = positional;
    if (!from || !to.length) throw errors.usage(MCP_USAGE);
    return runAction('mcp-copy', {
      from, to, servers: splitList(values['--server']), scope: values['--scope'] || 'user', project: values['--project'], force: flags.has('--force'),
    }, opts);
  }
  if (sub === 'remove') {
    const [target, server, ...extra] = positional;
    if (!target || !server || extra.length) throw errors.usage(MCP_USAGE);
    if (flags.has('--force')) throw errors.usage('--force does not apply to mcp remove');
    return runAction('mcp-remove', { target, server, scope: values['--scope'] || 'user', project: values['--project'] }, opts);
  }
  if (sub === 'sync') {
    if (flags.has('--force') || values['--server'] || values['--scope'] || values['--project']) throw errors.usage('Usage: cchost mcp sync [<profile>...] [--dry-run] [--json]');
    return runAction('mcp-sync', { profiles: positional }, opts);
  }
  throw errors.usage(`Unknown mcp command "${sub}".\n${MCP_USAGE}`);
}

module.exports = { cmdMcp };
