'use strict';
/* Nov 26 2026 (Part 460): one reset email per account every 15 minutes, three a day.
 * The store here keeps rows in memory with the same contract as the Mongo one.
 * Run: node --test api/server/services/kadeResetCap.nodetest.js (no database). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createResetCap, capIsOn } = require('./kadeResetCap');

const MIN = 60 * 1000;

function memoryStore() {
  let next = 0;
  const rows = new Map();
  return {
    rows,
    add: async (userId, at) => {
      const id = String(++next);
      rows.set(id, { userId: String(userId), at });
      return id;
    },
    countSince: async (userId, since) =>
      [...rows.values()].filter((r) => r.userId === String(userId) && r.at > since).length,
    remove: async (id) => {
      rows.delete(id);
    },
  };
}

function capAt(store) {
  let now = Date.UTC(2026, 10, 26, 6, 0, 0);
  const cap = createResetCap({ store, now: () => now });
  return { cap, advance: (ms) => (now += ms) };
}

test('one email per account in any 15 minutes', async () => {
  const store = memoryStore();
  const { cap, advance } = capAt(store);
  assert.equal((await cap.take('kade')).ok, true);
  advance(1 * MIN);
  assert.deepEqual(await cap.take('kade'), { ok: false, reason: 'fifteen-minutes' });
  advance(13 * MIN);
  assert.equal((await cap.take('kade')).ok, false, '14 minutes is still inside the window');
  advance(1 * MIN + 1);
  assert.equal((await cap.take('kade')).ok, true, 'just over 15 minutes later it may send again');
});

test('three emails per account in any day, then nothing until the oldest is a day old', async () => {
  const store = memoryStore();
  const { cap, advance } = capAt(store);
  for (let i = 0; i < 3; i++) {
    assert.equal((await cap.take('kade')).ok, true, `send ${i + 1}`);
    advance(16 * MIN);
  }
  assert.deepEqual(await cap.take('kade'), { ok: false, reason: 'day' });
  advance(20 * 60 * MIN);
  assert.equal((await cap.take('kade')).ok, false, 'still under a day since the first');
  advance(4 * 60 * MIN);
  assert.equal((await cap.take('kade')).ok, true, 'the first send is now over a day old');
});

test('a refused request leaves no row behind, so hammering does not push the window out', async () => {
  const store = memoryStore();
  const { cap, advance } = capAt(store);
  await cap.take('kade');
  for (let i = 0; i < 50; i++) {
    advance(10 * 1000);
    await cap.take('kade');
  }
  assert.equal(store.rows.size, 1);
  advance(16 * MIN);
  assert.equal((await cap.take('kade')).ok, true);
});

test('each account has its own count', async () => {
  const store = memoryStore();
  const { cap } = capAt(store);
  assert.equal((await cap.take('kade')).ok, true);
  assert.equal((await cap.take('holly')).ok, true);
  assert.equal((await cap.take('kade')).ok, false);
});

test('a released send gives its place back', async () => {
  const store = memoryStore();
  const { cap } = capAt(store);
  const first = await cap.take('kade');
  await cap.release(first.id);
  assert.equal((await cap.take('kade')).ok, true);
});

test('KADE_RESET_CAP=0 is the only thing that turns it off', () => {
  assert.equal(capIsOn({}), true);
  assert.equal(capIsOn({ KADE_RESET_CAP: '1' }), true);
  assert.equal(capIsOn({ KADE_RESET_CAP: '0' }), false);
});
