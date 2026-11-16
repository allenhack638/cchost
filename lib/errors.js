'use strict';

// One error shape for the CLI and the web view: exitCode 2 means bad input,
// 1 means refused or failed; status is the HTTP code `cchost ui` answers with.

function fail(message, status = 409) {
  const e = new Error(message);
  e.status = status;
  e.exitCode = status === 400 ? 2 : 1;
  return e;
}

const usage = (message) => fail(message, 400);
const refused = (message) => fail(message, 409);
const notFound = (message) => fail(message, 404);

module.exports = { fail, usage, refused, notFound };
