'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const profiles = require('./profiles');

const SUBDIRS = ['projects', 'sessions'];
const EXCLUDED_FILES = new Set(['.credentials.json', '.claude.json']);

function defaultClaudeDir() {
  return path.join(os.homedir(), '.claude');
}

function usageError(msg) {
  const e = new Error(msg);
  e.exitCode = 2;
  return e;
}

function resolveSource(src) {
  if (src === 'default') return { kind: 'default', dir: defaultClaudeDir() };
  if (src === 'shared') return { kind: 'shared', dir: profiles.sharedDir() };
  throw usageError(`Invalid migrate source "${src}". Allowed: default, shared.`);
}

function resolveDest(dest) {
  if (dest === 'shared') return { kind: 'shared', dir: profiles.sharedDir() };
  if (dest === 'default') {
    throw usageError('Cannot migrate into "default". Allowed destinations: shared, <profile>.');
  }
  profiles.validateProfileName(dest);
  return { kind: 'profile', name: dest, dir: profiles.profileDir(dest) };
}

function copyTreeSkipCollisions(srcRoot, dstRoot) {
  if (!fs.existsSync(srcRoot)) return { copied: 0, skipped: 0 };
  fs.mkdirSync(dstRoot, { recursive: true });
  let copied = 0;
  let skipped = 0;
  for (const ent of fs.readdirSync(srcRoot, { withFileTypes: true })) {
    if (EXCLUDED_FILES.has(ent.name)) continue;
    const from = path.join(srcRoot, ent.name);
    const to = path.join(dstRoot, ent.name);
    if (fs.existsSync(to)) {
      skipped += 1;
      continue;
    }
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    copied += 1;
  }
  return { copied, skipped };
}

function migrate(srcArg, destArg) {
  const src = resolveSource(srcArg);
  const dest = resolveDest(destArg);

  if (path.resolve(src.dir) === path.resolve(dest.dir)) {
    throw usageError(`Source and destination resolve to the same directory (${src.dir}).`);
  }

  if (dest.kind === 'profile') {
    profiles.ensureProfileDir(dest.name);
  } else {
    fs.mkdirSync(dest.dir, { recursive: true });
  }

  if (!fs.existsSync(src.dir)) {
    console.log(`Source ${src.dir} does not exist. Nothing to migrate.`);
    return { copied: 0, skipped: 0 };
  }

  let totalCopied = 0;
  let totalSkipped = 0;
  for (const sub of SUBDIRS) {
    const srcSub = path.join(src.dir, sub);
    const dstSub = path.join(dest.dir, sub);
    if (!fs.existsSync(srcSub)) continue;
    const { copied, skipped } = copyTreeSkipCollisions(srcSub, dstSub);
    console.log(`  ${sub}: copied ${copied}, skipped ${skipped}`);
    totalCopied += copied;
    totalSkipped += skipped;
  }
  console.log(`Done. Total copied: ${totalCopied}, total skipped (already present): ${totalSkipped}.`);
  return { copied: totalCopied, skipped: totalSkipped };
}

module.exports = {
  migrate,
  defaultClaudeDir,
  resolveSource,
  resolveDest,
  copyTreeSkipCollisions,
  SUBDIRS,
  EXCLUDED_FILES,
};
