'use strict';

// Starting Claude Code: use, and go (pinned folder or picker).

const fs = require('fs');

const profiles = require('../profiles');
const envLib = require('../env');
const { spawnClaude } = require('../spawn');
const pinsLib = require('../pins');
const color = require('../color');
const errors = require('../errors');
const paths = require('../paths');
const { io, interactive, choose } = require('./term');

async function cmdUse(rest) {
  const [name, ...passthrough] = rest;
  if (!name) throw errors.usage('Usage: cchost use <profile> [...args]');
  return launch(name, passthrough);
}

async function launch(name, passthrough, { cwd } = {}) {
  profiles.validateProfileName(name);
  const dir = profiles.profileDir(name);
  if (!fs.existsSync(dir) && profiles.isAlias(name)) {
    const conflicts = envLib.authEnvConflicts();
    if (conflicts.length > 0) {
      process.stderr.write(`[cchost] warning: ${conflicts.join(', ')} set in the environment; this may override the login of '${name}'.\n`);
    }
    return spawnClaude({ args: passthrough, profileDir: null, cwd });
  }
  if (!fs.existsSync(dir)) {
    throw errors.refused(`Profile "${name}" does not exist. Create it with: cchost add ${name}`);
  }

  let extraEnv = {};
  let unsetEnv = [];
  const envConfig = envLib.readEnvConfig(dir);
  if (envConfig) {
    extraEnv = envLib.buildEnvVars(envConfig);
    unsetEnv = envLib.endpointEnvToStrip(extraEnv);
    if (!envConfig.auth_token) {
      throw errors.refused(`Profile '${name}' has no token yet. Set it (input hidden): cchost token ${name}`);
    }
    const host = envConfig.base_url ? envLib.hostOf(envConfig.base_url) : '(unknown)';
    process.stderr.write(
      `[cchost] Profile '${name}' → ${host} (custom endpoint billing applies)\n`,
    );
    if (unsetEnv.length > 0) {
      process.stderr.write(
        `[cchost] notice: removed inherited ${unsetEnv.join(', ')} for endpoint profile '${name}'.\n`,
      );
    }
  } else {
    const conflicts = envLib.authEnvConflicts();
    if (conflicts.length > 0) {
      process.stderr.write(
        `[cchost] warning: ${conflicts.join(', ')} set in the environment; ` +
          `this may override the subscription login for '${name}'. ` +
          `Unset ${conflicts.length > 1 ? 'them' : 'it'} to use the profile's login.\n`,
      );
    }
  }
  return spawnClaude({ args: passthrough, profileDir: dir, extraEnv, unsetEnv, cwd });
}

// No pin here, at a terminal: pick an account, launch it, and offer to pin.
async function pickAndGo(rest, dir) {
  const list = profiles.listProfiles();
  if (!list.length) {
    throw errors.refused('No profiles yet. Create one: cchost add <name>   or name the account you use now: cchost add <name> --existing');
  }
  const alias = profiles.getAlias();
  const where = paths.shortPath(dir);
  process.stdout.write(`${color.stdout.bold(`No pin for ${where}.`)} Which account should open here?\n`);
  const labels = list.map((p) => `${p.name}${p.alias ? color.stdout.dim('  existing account') : ''}${p.email ? color.stdout.dim(`  ${envLib.maskEmail(p.email)}`) : ''}`);
  const i = await choose('Account', labels, { defaultIndex: alias ? list.findIndex((p) => p.name === alias) : -1 });
  if (i < 0) {
    console.log('Cancelled. Nothing changed.');
    return 1;
  }
  const name = list[i].name;
  if (!pinsLib.isRootLike(dir)) {
    const yes = (await io.prompt(`Pin ${where} to ${name} so cchost go opens it straight away next time? [Y/n] `)).trim().toLowerCase();
    if (yes === '' || yes === 'y' || yes === 'yes') {
      pinsLib.pin(name, dir);
      process.stdout.write(`${color.stdout.green('✓')} pinned ${where} → ${name}${color.stdout.dim('  (undo: cchost unpin)')}\n`);
    }
  }
  return launch(name, rest);
}

async function cmdGo(rest) {
  const hit = pinsLib.resolve();
  const alias = profiles.getAlias();
  const here = paths.realpath(process.cwd());
  if (hit && hit.kind === 'pin') {
    process.stderr.write(`[cchost] ${paths.shortPath(hit.dir)} is pinned to '${hit.profile}'\n`);
    return launch(hit.profile, rest);
  }
  if (hit && !hit.profile) {
    throw errors.refused(`${hit.error} (${hit.file}). Fix the file or pin this folder yourself: cchost pin <profile>`);
  }
  if (hit) {
    if (!fs.existsSync(profiles.profileDir(hit.profile)) && !profiles.isAlias(hit.profile)) {
      throw errors.refused(`${paths.shortPath(hit.file)} suggests profile "${hit.profile}", which does not exist here. Create it (cchost add ${hit.profile}) or pin another: cchost pin <profile>`);
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw errors.usage(`${paths.shortPath(hit.file)} suggests profile "${hit.profile}", which has not been confirmed. Ask the user to run \`cchost go\` or \`cchost pin ${hit.profile}\` in a terminal.`);
    }
    const answer = await io.prompt(`${paths.shortPath(hit.file)} suggests the profile "${hit.profile}". Pin ${paths.shortPath(hit.dir)} to it? [y/N/never] `);
    const a = answer.trim().toLowerCase();
    if (a === 'y' || a === 'yes') {
      pinsLib.pin(hit.profile, hit.dir);
      return launch(hit.profile, rest);
    }
    if (a === 'never' || a === 'n' || a === 'no' || a === '') {
      if (a === 'never') {
        pinsLib.ignoreFile(hit.dir);
        process.stderr.write(`[cchost] ignoring ${paths.shortPath(hit.file)} from now on; pin it yourself with: cchost pin <profile>\n`);
      }
      return pickAndGo(rest, hit.dir);
    }
    console.log('Cancelled. Nothing changed.');
    return 1;
  }
  if (interactive()) return pickAndGo(rest, here);
  if (alias) {
    process.stderr.write(`[cchost] no pin for this folder; using the existing account '${alias}'\n`);
    return launch(alias, rest);
  }
  throw errors.refused('No pin for this folder and no default account. Pin it: cchost pin <profile>   or launch one directly: cchost use <profile>');
}

module.exports = { cmdUse, launch, cmdGo };
