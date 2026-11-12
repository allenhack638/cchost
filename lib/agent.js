'use strict';

// `cchost agent [topic]` prints guides for AI agents from ../agent/*.md, and
// `cchost skill install` copies ../skills/* into ~/.claude/skills (the pool).
// The skills stay thin and point back at `cchost agent <topic>`, so what an
// agent reads always matches the installed cchost.

const fs = require('fs');
const path = require('path');

const profiles = require('./profiles');
const share = require('./share');

const GUIDES_DIR = path.join(__dirname, '..', 'agent');
const SKILLS_DIR = path.join(__dirname, '..', 'skills');
const MARKER = '.cchost-skill';

function agentError(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  e.exitCode = status === 404 ? 1 : 2;
  return e;
}

function topics() {
  try {
    return fs.readdirSync(GUIDES_DIR).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
  } catch {
    return [];
  }
}

function guide(topic = 'overview') {
  if (!/^[a-z-]+$/.test(topic) || !topics().includes(topic)) {
    throw agentError(`Unknown topic "${topic}". Topics: ${topics().join(', ')}`, 404);
  }
  return fs.readFileSync(path.join(GUIDES_DIR, `${topic}.md`), 'utf8');
}

function skillNames() {
  try {
    return fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

function version() {
  return require('../package.json').version;
}

function filesOf(dir, base = dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...filesOf(p, base));
    else out.push(path.relative(base, p));
  }
  return out.sort();
}

function sameTree(src, dst) {
  try {
    return filesOf(src).every((rel) => fs.readFileSync(path.join(src, rel)).equals(fs.readFileSync(path.join(dst, rel))));
  } catch {
    return false;
  }
}

function skillsRoot(profile) {
  if (!profile) return path.join(profiles.defaultClaudeDir(), 'skills');
  const p = profiles.resolveProfile(profile);
  if (p.alias || share.isSharedResource(p.dir, 'skills')) return path.join(profiles.defaultClaudeDir(), 'skills');
  return path.join(p.dir, 'skills');
}

function skillStatus(profile) {
  const root = skillsRoot(profile);
  const names = skillNames();
  const each = names.map((name) => {
    const dst = path.join(root, name);
    const installed = fs.existsSync(path.join(dst, 'SKILL.md'));
    return {
      name,
      installed,
      ours: fs.existsSync(path.join(dst, MARKER)),
      current: installed && sameTree(path.join(SKILLS_DIR, name), dst),
    };
  });
  return {
    root,
    skills: each,
    installed: each.length > 0 && each.every((s) => s.installed),
    current: each.length > 0 && each.every((s) => s.current),
  };
}

function short(p) {
  const home = require('os').homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function line(kind, label, text, extra = {}) {
  return { n: null, resource: null, label, kind, text, ...extra };
}

// Profiles that keep their own skills/ and so don't see the pool's copy.
function privateSkillProfiles() {
  return profiles.listProfiles().filter((p) => !p.alias && !share.isSharedResource(p.dir, 'skills')).map((p) => p.name);
}

function install({ profile } = {}, { dryRun = true } = {}) {
  const root = skillsRoot(profile);
  const lines = [];
  const names = skillNames();
  if (!names.length) throw agentError('This cchost install has no bundled skills.', 500);
  for (const name of names) {
    const src = path.join(SKILLS_DIR, name);
    const dst = path.join(root, name);
    const exists = fs.existsSync(dst);
    if (exists && !fs.existsSync(path.join(dst, MARKER))) {
      lines.push(line('warn', name, `${short(dst)} exists and was not installed by cchost — left alone`, { code: 'not-ours' }));
      continue;
    }
    if (exists && sameTree(src, dst)) {
      lines.push(line('same', name, `already current in ${short(root)}`));
      continue;
    }
    lines.push(line('change', name, `${dryRun ? (exists ? 'update in' : 'install to') : (exists ? 'updated in' : 'installed to')} ${short(root)}`));
    if (dryRun) continue;
    if (exists) fs.rmSync(dst, { recursive: true, force: true });
    for (const rel of filesOf(src)) {
      fs.mkdirSync(path.dirname(path.join(dst, rel)), { recursive: true });
      fs.copyFileSync(path.join(src, rel), path.join(dst, rel));
    }
    fs.writeFileSync(path.join(dst, MARKER), `${version()}\n`);
  }
  if (!profile) {
    const left = privateSkillProfiles();
    if (left.length) {
      lines.push(line('info', 'skills', `${left.join(', ')} keep their own skills/ and won't see these; add them with --profile=<name>`));
    }
  }
  return lines;
}

module.exports = { topics, guide, skillNames, skillStatus, install, privateSkillProfiles, GUIDES_DIR, SKILLS_DIR };
