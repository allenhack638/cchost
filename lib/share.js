'use strict';

const fs = require('fs');
const path = require('path');

const profiles = require('./profiles');

// Only projects/ holds the resumable conversation transcripts (projects/<proj>/<session>.jsonl).
// sessions/ is transient per-process registry state (PID, cwd, status, timestamps) and
// must stay per-profile — sharing it would corrupt Claude's running-process bookkeeping.
const SHARED_SUBDIRS = ['projects'];

function symlinkType() {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function removeLink(p) {
  try {
    fs.unlinkSync(p);
    return;
  } catch (err) {
    if (process.platform !== 'win32') throw err;
  }
  fs.rmdirSync(p);
}

function copyRecursive(src, dst) {
  fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
}

function ensureSharedDirs() {
  const base = profiles.sharedDir();
  for (const sub of SHARED_SUBDIRS) {
    try {
      fs.mkdirSync(path.join(base, sub), { recursive: true });
    } catch (err) {
      throw new Error(`Cannot create ${path.join(base, sub)}: ${err.message}`);
    }
  }
  return base;
}

function migrateIntoShared(profileName, src, sharedTarget) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(sharedTarget, { recursive: true });
  let moved = 0;
  for (const ent of fs.readdirSync(src)) {
    const from = path.join(src, ent);
    let to = path.join(sharedTarget, ent);
    if (fs.existsSync(to)) {
      to = path.join(sharedTarget, `${ent}__${profileName}`);
      let i = 2;
      while (fs.existsSync(to)) {
        to = path.join(sharedTarget, `${ent}__${profileName}_${i}`);
        i += 1;
      }
    }
    fs.renameSync(from, to);
    moved += 1;
  }
  fs.rmdirSync(src);
  return moved;
}

function shareLink(profileName) {
  profiles.validateProfileName(profileName);
  const pdir = profiles.profileDir(profileName);
  if (!fs.existsSync(pdir)) {
    const err = new Error(`Profile "${profileName}" does not exist. Create it with \`cc add ${profileName}\` first.`);
    err.exitCode = 1;
    throw err;
  }
  ensureSharedDirs();
  for (const sub of SHARED_SUBDIRS) {
    const target = path.join(profiles.sharedDir(), sub);
    const link = path.join(pdir, sub);
    if (isLink(link)) {
      console.log(`  ${sub}: already linked`);
      continue;
    }
    if (fs.existsSync(link)) {
      const moved = migrateIntoShared(profileName, link, target);
      console.log(`  ${sub}: migrated ${moved} item(s) into shared`);
    }
    try {
      fs.symlinkSync(target, link, symlinkType());
    } catch (err) {
      throw new Error(`Cannot link ${link} -> ${target}: ${err.message}`);
    }
    console.log(`  ${sub}: linked -> ${target}`);
  }
}

function shareUnlink(profileName) {
  profiles.validateProfileName(profileName);
  const pdir = profiles.profileDir(profileName);
  if (!fs.existsSync(pdir)) {
    const err = new Error(`Profile "${profileName}" does not exist.`);
    err.exitCode = 1;
    throw err;
  }
  for (const sub of SHARED_SUBDIRS) {
    const link = path.join(pdir, sub);
    const target = path.join(profiles.sharedDir(), sub);
    if (!isLink(link)) {
      console.log(`  ${sub}: not linked, skipping`);
      continue;
    }
    removeLink(link);
    fs.mkdirSync(link, { recursive: true });
    if (fs.existsSync(target)) {
      for (const ent of fs.readdirSync(target)) {
        copyRecursive(path.join(target, ent), path.join(link, ent));
      }
    }
    console.log(`  ${sub}: unlinked, content copied back`);
  }
}

module.exports = {
  SHARED_SUBDIRS,
  isLink,
  removeLink,
  shareLink,
  shareUnlink,
};
