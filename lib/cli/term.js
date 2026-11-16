'use strict';

// Terminal plumbing shared by every command: flags, prompts, action output.

const readline = require('readline');

const actions = require('../actions');
const color = require('../color');
const errors = require('../errors');

// --flag and --key=value parsing with a fixed vocabulary.
function parseArgs(args, { flags = [], values = [] } = {}) {
  const set = new Set();
  const vals = {};
  const positional = [];
  for (const a of args) {
    if (!a.startsWith('-')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    if (eq === -1 && flags.includes(name)) {
      set.add(name);
    } else if (values.includes(name)) {
      if (eq === -1 || eq === a.length - 1) throw errors.usage(`${name} needs a value: ${name}=VALUE`);
      vals[name] = a.slice(eq + 1);
    } else {
      throw errors.usage(`Unknown flag: ${name}`);
    }
  }
  return { flags: set, values: vals, positional };
}

const SYMBOL = { change: '+', same: '·', warn: '!', error: '✗', info: 'i' };

function paint(kind, text) {
  if (kind === 'warn') return color.stdout.yellow(text);
  if (kind === 'error') return color.stdout.red(text);
  if (kind === 'change') return color.stdout.green(text);
  return text;
}

function printLines(lines) {
  const width = Math.min(16, Math.max(0, ...lines.map((l) => (l.label || '').length)));
  for (const l of lines) {
    const label = (l.label || '').padEnd(width);
    process.stdout.write(`  ${paint(l.kind, SYMBOL[l.kind] || ' ')} ${label}  ${l.text}\n`);
  }
}

function linesOk(lines) {
  return !lines.some((l) => l.kind === 'error' || (l.kind === 'warn' && l.code));
}

// Runs one registry action and prints it as text or JSON. Exit: 0 ok,
// 1 something was refused or failed, 2 bad input.
async function runAction(name, params, { dryRun = false, json = false } = {}) {
  let lines;
  try {
    lines = await actions.ACTIONS[name](params, { dryRun });
  } catch (err) {
    const code = err.exitCode || (err.status === 400 ? 2 : 1);
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: false, dryRun, error: err.message })}\n`);
      return code;
    }
    throw Object.assign(err, { exitCode: code });
  }
  const ok = linesOk(lines);
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok, dryRun, lines }, null, 2)}\n`);
  } else {
    if (dryRun) process.stdout.write('Dry run — nothing will be changed.\n');
    printLines(lines);
  }
  return ok ? 0 : 1;
}

// --- status ------------------------------------------------------------------

function prompt(question, output = process.stdout) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output,
    });
    let answered = false;
    rl.on('close', () => {
      if (!answered) resolve('');
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
  });
}

// `cchost go`: launch under the profile pinned to this folder. A repo's
// .cchost file is only a suggestion and is confirmed once, at a terminal.
const io = { prompt: (q) => prompt(q) };

function interactive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// Numbered choice at a terminal. Returns the index, or -1 when cancelled.
async function choose(question, items, { defaultIndex = -1 } = {}) {
  items.forEach((label, i) => {
    const mark = i === defaultIndex ? color.stdout.dim('  (Enter)') : '';
    const [first, ...more] = label.split('\n');
    process.stdout.write(`  ${color.stdout.bold(String(i + 1).padStart(2))}  ${first}${mark}${more.map((m) => `\n${m}`).join('')}\n`);
  });
  const hint = defaultIndex >= 0 ? `1-${items.length}, Enter for ${defaultIndex + 1}, q to cancel` : `1-${items.length}, q to cancel`;
  const answer = (await io.prompt(`${question} [${hint}] `)).trim().toLowerCase();
  if (answer === '' && defaultIndex >= 0) return defaultIndex;
  const n = Number(answer);
  if (!Number.isInteger(n) || n < 1 || n > items.length) return -1;
  return n - 1;
}

// Secrets are shown only to a person at a terminal, never into a pipe.
function requireTerminal(what) {
  if (!process.stdout.isTTY) throw errors.usage(`${what} only works in a terminal; its output is not meant for pipes or agents.`);
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

module.exports = { parseArgs, runAction, prompt, io, interactive, choose, requireTerminal, readStdin, printLines, linesOk };
