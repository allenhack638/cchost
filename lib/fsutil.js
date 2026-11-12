'use strict';

const fs = require('fs');
const path = require('path');

const share = require('./share');

// Deletes a tree without following symlinks, so shared resources keep their
// pool content when a profile is removed.
function removeRecursivelyPreservingLinks(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    try {
      fs.unlinkSync(p);
      return;
    } catch (err) {
      if (process.platform === 'win32') {
        fs.rmdirSync(p);
        return;
      }
      throw err;
    }
  }
  if (st.isDirectory()) {
    for (const ent of fs.readdirSync(p)) {
      removeRecursivelyPreservingLinks(path.join(p, ent));
    }
    fs.rmdirSync(p);
    return;
  }
  fs.unlinkSync(p);
}

// True if the profile has a private, non-empty resource that removal would lose.
function hasPrivateContent(dir) {
  for (const r of share.SHARED_RESOURCES) {
    const p = path.join(dir, r);
    if (!fs.existsSync(p)) continue;
    if (share.isSharedResource(dir, r)) continue;
    try {
      if (share.isFileResource(r) ? fs.statSync(p).size > 0 : fs.readdirSync(p).length > 0) return true;
    } catch { /* unreadable: treat as empty */ }
  }
  return false;
}

module.exports = { removeRecursivelyPreservingLinks, hasPrivateContent };
