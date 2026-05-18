'use strict';

const fs = require('fs');
const path = require('path');

const profiles = require('./profiles');

// Artifact directories that are safe to share across profiles via junctions/symlinks.
// sessions/ is transient per-process registry state (PID, cwd, status, timestamps) and
// must stay per-profile — sharing it would corrupt Claude's running-process bookkeeping.
// plugins/ carries auth tokens and is intentionally excluded (future opt-in).
const SHARED_SUBDIRS = ['projects', 'skills', 'agents', 'commands'];

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

// Links each of the four artifact dirs independently. A failure on one
// directory is recorded and the remaining directories are still attempted —
// callers get a per-directory result and decide how to report it.
// Returns [{ sub, status, moved?, message? }]; status is one of:
//   'linked' | 'already-linked' | 'failed'
function shareLink(profileName) {
  profiles.validateProfileName(profileName);
  const pdir = profiles.profileDir(profileName);
  if (!fs.existsSync(pdir)) {
    const err = new Error(`Profile "${profileName}" does not exist. Create it with \`cc add ${profileName}\` first.`);
    err.exitCode = 1;
    throw err;
  }
  ensureSharedDirs();
  const results = [];
  for (const sub of SHARED_SUBDIRS) {
    const target = path.join(profiles.sharedDir(), sub);
    const link = path.join(pdir, sub);
    try {
      if (isLink(link)) {
        results.push({ sub, status: 'already-linked' });
        continue;
      }
      let moved = 0;
      if (fs.existsSync(link)) {
        moved = migrateIntoShared(profileName, link, target);
      }
      fs.symlinkSync(target, link, symlinkType());
      results.push({ sub, status: 'linked', moved });
    } catch (err) {
      results.push({ sub, status: 'failed', message: err.message });
    }
  }
  return results;
}

// Mirror of shareLink: each directory is restored independently.
// Returns [{ sub, status, message? }]; status is one of:
//   'unlinked' | 'not-linked' | 'failed'
function shareUnlink(profileName) {
  profiles.validateProfileName(profileName);
  const pdir = profiles.profileDir(profileName);
  if (!fs.existsSync(pdir)) {
    const err = new Error(`Profile "${profileName}" does not exist.`);
    err.exitCode = 1;
    throw err;
  }
  const results = [];
  for (const sub of SHARED_SUBDIRS) {
    const link = path.join(pdir, sub);
    const target = path.join(profiles.sharedDir(), sub);
    try {
      if (!isLink(link)) {
        results.push({ sub, status: 'not-linked' });
        continue;
      }
      removeLink(link);
      fs.mkdirSync(link, { recursive: true });
      if (fs.existsSync(target)) {
        for (const ent of fs.readdirSync(target)) {
          copyRecursive(path.join(target, ent), path.join(link, ent));
        }
      }
      results.push({ sub, status: 'unlinked' });
    } catch (err) {
      results.push({ sub, status: 'failed', message: err.message });
    }
  }
  return results;
}

module.exports = {
  SHARED_SUBDIRS,
  isLink,
  removeLink,
  shareLink,
  shareUnlink,
};
