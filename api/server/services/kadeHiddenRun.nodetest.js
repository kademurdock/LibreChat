'use strict';
/* Nov 13 2026 (sweep): every hidden run is marked as background, so the model request can tell
 * the gateway nobody is waiting. Only the process's own key makes a run hidden.
 * Run: node --test api/server/services/kadeHiddenRun.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { markHiddenRun, hiddenRunHeaders } = require('./kadeHiddenRun');

const reqWith = (headers) => ({ user: { id: 'u1' }, get: (name) => headers[String(name).toLowerCase()] });

test('a hidden run (a character day, a reach-out, a task) is marked background', () => {
  for (const opts of [{}, { platformPaid: true }, { steps: 20 }]) {
    const req = reqWith(hiddenRunHeaders(opts));
    let went = false;
    markHiddenRun(req, {}, () => (went = true));
    assert.equal(went, true);
    assert.equal(req.kadeHiddenRun, true);
    assert.equal(req.kadeBackground, true);
  }
});

test('an ordinary turn, or a forged header, is not marked', () => {
  for (const headers of [{}, { 'x-kade-hidden-run': 'guess' }, { 'x-kade-hidden-run': '' }, { 'x-kade-background': '1' }]) {
    const req = reqWith(headers);
    markHiddenRun(req, {}, () => {});
    assert.equal(req.kadeHiddenRun, undefined);
    assert.equal(req.kadeBackground, undefined);
  }
});

/* Nov 14 2026: test seats (KADE_CLAUDE_EXCLUDE_USERS) are marked background so the gateway keeps
 * them off Claude; nothing else about their turn changes. */
test('a test seat listed in KADE_CLAUDE_EXCLUDE_USERS is marked background, and only that', () => {
  const saved = process.env.KADE_CLAUDE_EXCLUDE_USERS;
  try {
    process.env.KADE_CLAUDE_EXCLUDE_USERS = ' seatA , u1 ';
    const req = reqWith({});
    let went = false;
    markHiddenRun(req, {}, () => (went = true));
    assert.equal(went, true);
    assert.equal(req.kadeBackground, true);
    assert.equal(req.kadeHiddenRun, undefined);
    assert.equal(req.kadePlatformPaid, undefined);
    const other = { user: { id: 'someone-else' }, get: () => undefined };
    markHiddenRun(other, {}, () => {});
    assert.equal(other.kadeBackground, undefined);
    const noUser = { get: () => undefined };
    markHiddenRun(noUser, {}, () => {});
    assert.equal(noUser.kadeBackground, undefined);
  } finally {
    if (saved === undefined) delete process.env.KADE_CLAUDE_EXCLUDE_USERS;
    else process.env.KADE_CLAUDE_EXCLUDE_USERS = saved;
  }
});

test('with KADE_CLAUDE_EXCLUDE_USERS unset or empty, nobody is marked', () => {
  const saved = process.env.KADE_CLAUDE_EXCLUDE_USERS;
  try {
    for (const value of [undefined, '', ' , ']) {
      if (value === undefined) delete process.env.KADE_CLAUDE_EXCLUDE_USERS;
      else process.env.KADE_CLAUDE_EXCLUDE_USERS = value;
      const req = reqWith({});
      markHiddenRun(req, {}, () => {});
      assert.equal(req.kadeBackground, undefined);
    }
  } finally {
    if (saved === undefined) delete process.env.KADE_CLAUDE_EXCLUDE_USERS;
    else process.env.KADE_CLAUDE_EXCLUDE_USERS = saved;
  }
});
