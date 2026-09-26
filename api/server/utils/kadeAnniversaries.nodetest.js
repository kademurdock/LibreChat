/* THE ANNIVERSARY LINE STATES ITS OWN RULE (Part 293 review, Sep 25 2026).
 *
 * The line used to say "same rules as the platform note". With
 * KADE_CASUAL_HOUSE on (the default) the platform note has no PLATFORM label
 * any more, so that pointer had nothing exact to point at. The line now says
 * the rule itself, the way the WORLD block does.
 *
 * Run: node --test api/server/utils/kadeAnniversaries.nodetest.js
 */
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

let cards = [];
const stubs = {
  '@librechat/data-schemas': { memoryPolicyRevision: async () => 'rev-1' },
  mongoose: { models: { MemoryEntry: {} } },
  '~/models': { getAllUserMemories: async () => cards },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) {
    return stubs[request];
  }
  return realLoad.call(this, request, parent, isMain);
};

const { getAnniversaryLine, centralParts } = require('./kadeAnniversaries');

/* A card created exactly a year ago today, Central time. Midday UTC lands on
 * the same Central date. Feb 29 has no date a year back, so that day skips. */
function aYearAgoToday() {
  const today = centralParts();
  const created = new Date(Date.UTC(today.y - 1, today.m - 1, today.d, 18));
  const back = centralParts(created);
  const ok = back.y === today.y - 1 && back.m === today.m && back.d === today.d;
  return ok ? created : null;
}

const HEAD = 'MEMORY ANNIVERSARY (private: never mention, quote or explain this note): ';
let userSeq = 0;
const nextUser = () => `user-${++userSeq}`; // the memo is per user, agent and day

test('the line states the privacy rule itself and no longer points at the platform note', async (t) => {
  const created = aYearAgoToday();
  if (!created) {
    t.skip('no calendar date exactly a year back today');
    return;
  }
  cards = [{ createdAt: created, value: 'has a beagle named Biscuit', agentId: null }];
  const line = await getAnniversaryLine(nextUser(), 'agent-a');
  assert.ok(line.startsWith(HEAD), `unexpected head: ${line.slice(0, 90)}`);
  assert.ok(!/platform note/i.test(line), 'the line still points at the platform note');
  assert.ok(line.includes('exactly 1 year today'));
  assert.ok(line.includes('"has a beagle named Biscuit"'));
  assert.ok(line.includes('never call it an anniversary'), 'the rest of the line changed');
});

test('the default platform note has no PLATFORM label a pointer could name', () => {
  const before = process.env.KADE_CASUAL_HOUSE;
  delete process.env.KADE_CASUAL_HOUSE;
  try {
    delete require.cache[require.resolve('./kadePlatformNote')];
    const { KADE_PLATFORM_NOTE } = require('./kadePlatformNote');
    assert.ok(!KADE_PLATFORM_NOTE.includes('PLATFORM ('));
  } finally {
    if (before !== undefined) {
      process.env.KADE_CASUAL_HOUSE = before;
    }
    delete require.cache[require.resolve('./kadePlatformNote')];
  }
});

test('an agent-scoped card still only reaches its own agent', async (t) => {
  const created = aYearAgoToday();
  if (!created) {
    t.skip('no calendar date exactly a year back today');
    return;
  }
  cards = [{ createdAt: created, value: 'likes fried okra', agentId: 'agent-a' }];
  const user = nextUser();
  assert.ok((await getAnniversaryLine(user, 'agent-a')).startsWith(HEAD));
  assert.strictEqual(await getAnniversaryLine(user, 'agent-b'), '');
});

test('KADE_ANNIVERSARIES=0 still turns the line off', async () => {
  const before = process.env.KADE_ANNIVERSARIES;
  process.env.KADE_ANNIVERSARIES = '0';
  try {
    cards = [{ createdAt: aYearAgoToday() || new Date(), value: 'x', agentId: null }];
    assert.strictEqual(await getAnniversaryLine(nextUser(), 'agent-a'), '');
  } finally {
    if (before === undefined) {
      delete process.env.KADE_ANNIVERSARIES;
    } else {
      process.env.KADE_ANNIVERSARIES = before;
    }
  }
});
