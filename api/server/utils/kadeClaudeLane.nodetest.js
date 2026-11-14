'use strict';
/* Nov 14 2026: which writing calls the website marks for Claude (utils/kadeClaudeLane.js). Her words: "Change the
 * lyric desk etc to it too, whatever benefits from better writing than Mimo". The gateway decides where a call goes;
 * these marks only tell it the lane and whether the person is a verified adult, by the rule that gives a chat turn
 * the website's verified-adult note (Endpoints/agents/build.js isKadeAdult after isChildLike). No network, no database.
 * Run: node --test api/server/utils/kadeClaudeLane.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lane = require('./kadeClaudeLane');

test('the verified-adult rule is build.js\'s: typed adult or the admin; never a child, a teen or an untyped account', () => {
  assert.equal(lane.isVerifiedAdult({ kadeAccountType: 'adult' }), true);
  assert.equal(lane.isVerifiedAdult({ role: 'ADMIN' }), true, 'Kade herself');
  assert.equal(lane.isVerifiedAdult({ role: 'ADMIN', kadeAccountType: 'adult' }), true);
  assert.equal(lane.isVerifiedAdult({ role: 'ADMIN', kadeAccountType: 'child' }), false);
  assert.equal(lane.isVerifiedAdult({ role: 'ADMIN', kadeAccountType: 'teen' }), false);
  assert.equal(lane.isVerifiedAdult({ kadeAccountType: 'teen' }), false);
  assert.equal(lane.isVerifiedAdult({ kadeAccountType: 'child' }), false);
  assert.equal(lane.isVerifiedAdult({ kadeAccountType: 'grown-up' }), false, 'only the types the platform knows');
  assert.equal(lane.isVerifiedAdult({ role: 'USER' }), false, 'untyped');
  assert.equal(lane.isVerifiedAdult({ role: 'admin' }), false, 'build.js reads the role exactly');
  assert.equal(lane.isVerifiedAdult({}), false);
  assert.equal(lane.isVerifiedAdult(null), false);
  // The rule must stay the chat rule: the same two sentences as build.js.
  const build = fs.readFileSync(path.join(__dirname, '../services/Endpoints/agents/build.js'), 'utf8');
  assert.match(build, /const isKadeAdult = \(user\) =>\s*!!user && user\.kadeAccountType !== 'child' && \(user\.kadeAccountType === 'adult' \|\| user\.role === 'ADMIN'\);/);
  assert.match(build, /if \(require\('\.\.\/\.\.\/kadeAccountType'\)\.isChildLike\(audience\)\) \{[\s\S]{0,120}\} else if \(isKadeAdult\(audience\)/);
});

test('claudeAdult reads the person a chat turn would be written for, and the stored type when the request has none', async () => {
  const stored = (kadeAccountType, role) => async () => ({ kadeAccountType, role });
  assert.equal(await lane.claudeAdult({ user: { id: 'u1', kadeAccountType: 'adult' } }), true);
  assert.equal(await lane.claudeAdult({ user: { id: 'u1', role: 'USER' } }, { loadUser: stored('adult') }), true, 'the stored type, read as kadeSongAudience reads it');
  assert.equal(await lane.claudeAdult({ user: { id: 'u1', role: 'USER' } }, { loadUser: stored(undefined) }), false, 'untyped stays untyped');
  assert.equal(await lane.claudeAdult({ user: { id: 'u1' } }, { loadUser: stored('teen') }), false);
  assert.equal(await lane.claudeAdult({ user: { id: 'u1' } }, { loadUser: stored(undefined, 'ADMIN') }), true, 'the stored role counts too');
  assert.equal(await lane.claudeAdult({ user: { id: 'u1' } }, { loadUser: async () => { throw new Error('db down'); } }), false, 'fails closed');
  assert.equal(await lane.claudeAdult({ user: { role: 'USER' } }, { loadUser: stored('adult') }), false, 'no id, no read');
  let read = 0;
  assert.equal(await lane.claudeAdult({ user: { id: 'k', role: 'ADMIN' } }, { loadUser: async () => { read += 1; return null; } }), true);
  assert.equal(read, 0, 'the admin needs no read');
  assert.equal(await lane.claudeAdult({ user: { id: 'svc', role: 'ADMIN' }, kadeOnBehalfOf: { id: 'kid1', kadeAccountType: 'child' } }), false,
    'a voice turn follows the person on the line, not the service seat');
  assert.equal(await lane.claudeAdult({ user: { id: 'svc', role: 'ADMIN' }, kadeOnBehalfOfUnresolved: true }), false, 'an unknown caller is nobody');
  assert.equal(await lane.claudeAdult({ user: { id: 'svc', role: 'ADMIN' }, kadeOnBehalfOf: { id: 'a1', kadeAccountType: 'adult' } }), true);
  assert.equal(await lane.claudeAdult({}), false);
  assert.equal(await lane.claudeAdult(null), false);
  assert.equal(await lane.claudeAdult(undefined), false);
});

test('Nov 14 review: a test seat (KADE_CLAUDE_EXCLUDE_USERS) is never marked adult, signed in or on the line', async () => {
  const env = { KADE_CLAUDE_EXCLUDE_USERS: ' vischeckSeat , evalclean ' };
  const typedAdult = (id) => ({ user: { id, kadeAccountType: 'adult' } });
  assert.equal(await lane.claudeAdult(typedAdult('vischeckSeat'), { env }), false, 'the battery\'s seat is typed adult, and stays off Claude');
  assert.equal(await lane.claudeAdult({ user: { _id: 'evalclean', kadeAccountType: 'adult' } }, { env }), false, 'an _id counts too');
  assert.equal(await lane.claudeAdult(typedAdult('realPerson'), { env }), true, 'everyone else as before');
  assert.equal(await lane.claudeAdult({ user: { id: 'svc', role: 'ADMIN' }, kadeOnBehalfOf: { id: 'evalclean', kadeAccountType: 'adult' } }, { env }), false,
    'a voice turn for a test seat');
  let read = 0;
  assert.equal(await lane.claudeAdult({ user: { id: 'vischeckSeat', role: 'USER' } }, { env, loadUser: async () => { read += 1; return { kadeAccountType: 'adult' }; } }), false);
  assert.equal(read, 0, 'no account read for a listed seat');
  for (const empty of [{}, { KADE_CLAUDE_EXCLUDE_USERS: '' }, { KADE_CLAUDE_EXCLUDE_USERS: ' , ' }]) {
    assert.equal(await lane.claudeAdult(typedAdult('vischeckSeat'), { env: empty }), true, `nobody is listed: ${JSON.stringify(empty)}`);
  }
  // The live list is read from the process by default, as the chat turns read it.
  const saved = process.env.KADE_CLAUDE_EXCLUDE_USERS;
  try {
    process.env.KADE_CLAUDE_EXCLUDE_USERS = 'vischeckSeat';
    assert.equal(await lane.claudeAdult(typedAdult('vischeckSeat')), false);
  } finally {
    if (saved === undefined) delete process.env.KADE_CLAUDE_EXCLUDE_USERS;
    else process.env.KADE_CLAUDE_EXCLUDE_USERS = saved;
  }
});

test('the headers: the lane always, the adult mark only when it is exactly true, nothing with the switch off', () => {
  assert.deepEqual(lane.LANES, ['lyric-desk', 'booth-edit', 'persona-writer', 'spotter-draft']);
  for (const l of lane.LANES) {
    assert.deepEqual(lane.claudeLaneHeaders(l, true, {}), { 'x-kade-claude-lane': l, 'x-kade-adult': '1' });
    assert.deepEqual(lane.claudeLaneHeaders(l, false, {}), { 'x-kade-claude-lane': l });
    assert.deepEqual(lane.claudeLaneHeaders(l, 'yes', {}), { 'x-kade-claude-lane': l }, 'only true is a yes');
    assert.deepEqual(lane.claudeLaneHeaders(l, true, { KADE_SEND_CLAUDE_LANE: '0' }), {}, 'the website\'s own off switch');
    assert.deepEqual(lane.claudeLaneHeaders(l, true, { KADE_SEND_CLAUDE_LANE: '1' }), { 'x-kade-claude-lane': l, 'x-kade-adult': '1' });
  }
  assert.deepEqual(lane.claudeLaneHeaders('speak-first', true, {}), {}, 'speak-first rides a hidden run, not these headers');
  assert.deepEqual(lane.claudeLaneHeaders('anything', true, {}), {});
  assert.deepEqual(lane.claudeLaneHeaders(undefined, true, {}), {});
});
