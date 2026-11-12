'use strict';
/* KADE: the shared tool-result cache.
 * Run: node --test api/app/clients/tools/util/kadeToolCache.nodetest.js */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const C = require('./kadeToolCache');

const ON = {};
beforeEach(() => C.reset());

test('a second identical lookup inside the time is answered from the cache', async () => {
  let calls = 0;
  let clock = 1000;
  const opts = { tool: 'kade_weather', args: { location: ' Ozark,  Missouri ', days: 3 }, ttlMs: 600000, env: ON, now: () => clock };
  const fn = async () => { calls += 1; return 'Weather for Ozark'; };
  assert.equal(await C.cached(opts, fn), 'Weather for Ozark');
  clock += 60000;
  assert.equal(await C.cached({ ...opts, args: { days: 3, location: 'ozark, missouri' } }, fn), 'Weather for Ozark');
  assert.equal(calls, 1);
  assert.equal(C.snapshot().hit, 1);
});

test('after the time is up the lookup runs again', async () => {
  let calls = 0;
  let clock = 0;
  const opts = { tool: 't', args: { q: 'a' }, ttlMs: 1000, env: ON, now: () => clock };
  const fn = async () => { calls += 1; return `answer ${calls}`; };
  await C.cached(opts, fn);
  clock = 1000;
  assert.equal(await C.cached(opts, fn), 'answer 2');
});

test('two overlapping identical lookups share one outside request', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const fn = async () => { calls += 1; await gate; return 'one answer'; };
  const opts = { tool: 't', args: { q: 'same' }, ttlMs: 1000, env: ON };
  const a = C.cached(opts, fn);
  const b = C.cached(opts, fn);
  release();
  assert.deepEqual(await Promise.all([a, b]), ['one answer', 'one answer']);
  assert.equal(calls, 1);
  assert.equal(C.snapshot().shared, 1);
});

test('a failure answer is not kept, and a thrown error passes through', async () => {
  let calls = 0;
  const opts = { tool: 't', args: { q: 'x' }, ttlMs: 1000, env: ON, cacheable: (s) => s.startsWith('Weather for ') };
  const bad = async () => { calls += 1; return 'Weather lookup failed: timeout'; };
  await C.cached(opts, bad);
  await C.cached(opts, bad);
  assert.equal(calls, 2);
  await assert.rejects(C.cached(opts, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(C.snapshot().entries, 0);
  assert.equal(C.snapshot().flights, 0);
});

test('a different scope or an exact address is a different lookup', async () => {
  let calls = 0;
  const fn = async () => { calls += 1; return 'x'; };
  await C.cached({ tool: 't', args: { q: 'a' }, scope: 'u1', ttlMs: 1000, env: ON }, fn);
  await C.cached({ tool: 't', args: { q: 'a' }, scope: 'u2', ttlMs: 1000, env: ON }, fn);
  await C.cached({ tool: 'f', args: { url: 'https://x.test/Feed' }, exact: true, ttlMs: 1000, env: ON }, fn);
  await C.cached({ tool: 'f', args: { url: 'https://x.test/feed' }, exact: true, ttlMs: 1000, env: ON }, fn);
  assert.equal(calls, 4);
});

test('KADE_TOOL_CACHE=0 always calls out; shadow calls out and counts', async () => {
  let calls = 0;
  const fn = async () => { calls += 1; return 'x'; };
  const off = { tool: 't', args: { q: 'a' }, ttlMs: 1000, env: { KADE_TOOL_CACHE: '0' } };
  await C.cached(off, fn);
  await C.cached(off, fn);
  assert.equal(calls, 2);
  const shadow = { tool: 't', args: { q: 'b' }, ttlMs: 1000, env: { KADE_TOOL_CACHE: 'shadow' } };
  await C.cached(shadow, fn);
  await C.cached(shadow, fn);
  assert.equal(calls, 4);
  assert.equal(C.snapshot().shadow, 1);
});

test('the store stays bounded', async () => {
  for (let i = 0; i < C.MAX + 50; i++) {
    await C.cached({ tool: 't', args: { q: `q${i}` }, ttlMs: 60000, env: ON }, async () => 'x');
  }
  assert.equal(C.snapshot().entries, C.MAX);
});

test('noteRepeat sees the same search twice for one person, not across people', () => {
  let clock = 0;
  const base = { tool: 'web_search', args: { query: 'Ozark weather radar' }, ttlMs: 900000, env: ON, now: () => clock };
  assert.equal(C.noteRepeat({ ...base, scope: 'u1' }), false);
  clock = 1000;
  assert.equal(C.noteRepeat({ ...base, scope: 'u2' }), false);
  assert.equal(C.noteRepeat({ ...base, scope: 'u1' }), true);
  clock = 2000000;
  assert.equal(C.noteRepeat({ ...base, scope: 'u1' }), false);
});

/* Nov 12 2026 (phase 4 build): one person's characters share; two people never do. */
const seat = { id: 'svc', role: 'ADMIN' };
const amber = { user: { id: 'amber', role: 'USER' } };
const holly = { user: { id: 'holly', role: 'USER' } };

test('cachedForPerson: two characters of one person share, two people never do', async () => {
  let calls = 0;
  const fn = async () => { calls += 1; return `Weather for Ozark ${calls}`; };
  const opts = { tool: 'kade_weather', args: { location: 'Ozark', days: 3 }, ttlMs: 600000, env: ON };
  assert.equal(await C.cachedForPerson(amber, opts, fn), 'Weather for Ozark 1');
  assert.equal(await C.cachedForPerson({ user: { id: 'amber' } }, opts, fn), 'Weather for Ozark 1');
  assert.equal(await C.cachedForPerson(holly, opts, fn), 'Weather for Ozark 2');
  assert.equal(calls, 2);
});

test('cachedForPerson: a running lookup is never shared between people', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const fn = async () => { calls += 1; await gate; return `answer ${calls}`; };
  const opts = { tool: 't', args: { q: 'same' }, ttlMs: 1000, env: ON };
  const a = C.cachedForPerson(amber, opts, fn);
  const b = C.cachedForPerson(holly, opts, fn);
  release();
  await Promise.all([a, b]);
  assert.equal(calls, 2);
  assert.equal(C.snapshot().shared, 0);
});

test('cachedForPerson: on a phone turn the caller is the scope, never the service seat', async () => {
  let calls = 0;
  const fn = async () => { calls += 1; return 'x'; };
  const opts = { tool: 't', args: { q: 'a' }, ttlMs: 60000, env: ON };
  await C.cachedForPerson({ user: seat, kadeOnBehalfOf: { id: 'amber' } }, opts, fn);
  await C.cachedForPerson({ user: seat, kadeOnBehalfOf: { id: 'holly' } }, opts, fn);
  assert.equal(calls, 2);
  await C.cachedForPerson(amber, opts, fn); // the same person on the website shares with her call
  assert.equal(calls, 2);
});

test('cachedForPerson: nobody known means no cache at all', async () => {
  let calls = 0;
  const fn = async () => { calls += 1; return 'x'; };
  const opts = { tool: 't', args: { q: 'a' }, ttlMs: 60000, env: ON };
  await C.cachedForPerson(undefined, opts, fn);
  await C.cachedForPerson(undefined, opts, fn);
  await C.cachedForPerson({ user: seat, kadeCallerNumber: '+15550100' }, opts, fn);
  await C.cachedForPerson({ user: seat, kadeCallerNumber: '+15550100' }, opts, fn);
  await C.cachedForPerson({ user: seat, kadeOnBehalfOf: { id: 'amber' }, kadeOnBehalfOfUnresolved: true }, opts, fn);
  assert.equal(calls, 5);
  assert.equal(C.snapshot().entries, 0);
  assert.equal(C.snapshot().unscoped, 5);
});

test('personScope names the person, not the seat', () => {
  assert.equal(C.personScope(amber), 'u:amber');
  assert.equal(C.personScope({ user: seat, kadeOnBehalfOf: { id: 'holly' } }), 'u:holly');
  assert.equal(C.personScope({ user: seat, kadeVoicePass: 'phone' }), null);
  assert.equal(C.personScope({ user: { _id: 'abc123' } }), 'u:abc123');
  assert.equal(C.personScope({}), null);
});
