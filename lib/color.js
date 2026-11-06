'use strict';

function colorEnabled(stream) {
  // NO_COLOR is specified by presence, even when set to an empty string.
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  const s = stream || process.stdout;
  return Boolean(s && s.isTTY);
}

function wrap(stream, open, close) {
  return (text) => (colorEnabled(stream) ? `\x1b[${open}m${text}\x1b[${close}m` : String(text));
}

const stderr = {
  yellow: wrap(process.stderr, 33, 39),
  red: wrap(process.stderr, 31, 39),
  dim: wrap(process.stderr, 2, 22),
};

const stdout = {
  green: wrap(process.stdout, 32, 39),
  bold: wrap(process.stdout, 1, 22),
  dim: wrap(process.stdout, 2, 22),
};

module.exports = { colorEnabled, stderr, stdout };
