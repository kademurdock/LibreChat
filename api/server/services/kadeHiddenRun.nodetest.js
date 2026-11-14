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

/* Nov 14 2026, her words: "Change the lyric desk etc to it too, whatever benefits from better writing than Mimo".
 * A hidden run that is ONE message a character sends (no step budget of its own) is marked for the speak-first
 * writing lane; a background task's many rounds are not; and the mark counts only with the process's own key. */
test('a one-message run is marked for the speak-first lane; a task with a step budget is not', () => {
  const one = reqWith(hiddenRunHeaders({ platformPaid: true, oneMessage: true }));
  markHiddenRun(one, {}, () => {});
  assert.equal(one.kadeClaudeLane, 'speak-first');
  assert.equal(one.kadeBackground, true);
  for (const opts of [{}, { steps: 30 }, { oneMessage: 'yes' }]) {
    const req = reqWith(hiddenRunHeaders(opts));
    markHiddenRun(req, {}, () => {});
    assert.equal(req.kadeHiddenRun, true);
    assert.equal(req.kadeClaudeLane, undefined, JSON.stringify(opts));
  }
  assert.deepEqual(Object.keys(hiddenRunHeaders({})), ['x-kade-hidden-run'], 'nothing new on an unmarked run');
});

test('the speak-first mark is ignored without the key, and any other lane name is ignored', () => {
  for (const headers of [{ 'x-kade-claude-lane': 'speak-first' }, { 'x-kade-hidden-run': 'guess', 'x-kade-claude-lane': 'speak-first' }]) {
    const req = reqWith(headers);
    markHiddenRun(req, {}, () => {});
    assert.equal(req.kadeClaudeLane, undefined);
  }
  const other = reqWith({ ...hiddenRunHeaders({}), 'x-kade-claude-lane': 'lyric-desk' });
  markHiddenRun(other, {}, () => {});
  assert.equal(other.kadeHiddenRun, true);
  assert.equal(other.kadeClaudeLane, undefined);
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

/* Nov 14 review: a test seat's own message (the battery's friend texts) never carries the speak-first mark. */
test('a test seat\'s one-message run is not marked for the speak-first lane; everyone else\'s still is', () => {
  const saved = process.env.KADE_CLAUDE_EXCLUDE_USERS;
  try {
    process.env.KADE_CLAUDE_EXCLUDE_USERS = 'u1';
    const seat = reqWith(hiddenRunHeaders({ platformPaid: true, oneMessage: true }));
    markHiddenRun(seat, {}, () => {});
    assert.equal(seat.kadeHiddenRun, true);
    assert.equal(seat.kadeBackground, true);
    assert.equal(seat.kadeClaudeLane, undefined);
    const person = { user: { id: 'someone-else' }, get: (name) => hiddenRunHeaders({ oneMessage: true })[String(name).toLowerCase()] };
    markHiddenRun(person, {}, () => {});
    assert.equal(person.kadeClaudeLane, 'speak-first');
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
