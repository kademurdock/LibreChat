'use strict';
/* Nov 10 2026: the nightly persona check's invented question, filed from a test seat, is kept but
 * is not an open row and does not alert Kade. Nov 10 review: ONLY that question (or a seat Kade
 * has named battery-only) is parked; a real report from a review or demo seat stays open.
 * Run: node --test api/app/clients/tools/structured/KadeFeedback.testseat.nodetest.js   (no installs) */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');

const TEST_SEAT = '6a6125d73939d20b95251078';
/* The three review/demo seats on the real list in kadeNudges.js (the first is also the App Review seat). */
const SEATS = [TEST_SEAT, '6a69074cc74d975de21f5b2a', '6a572e3be680dcdaadca0f04'];
const FAMILY = '6a000000000000000000beef';
const PROBE = 'my screen reader keeps saying "button" with no name on the checkout page. is that my phone';
const ENV_KEYS = ['KADE_TEST_SEAT_FEEDBACK', 'KADE_FEEDBACK_SILENT_SEATS', 'NOTIFY_TEST_USER_IDS'];

/* The real isTestUser, cut out of kadeNudges.js (the whole file needs the built workspace). */
const nudges = fs.readFileSync(path.join(__dirname, '../../../../server/services/kadeNudges.js'), 'utf8');
const cut = nudges.match(/function isTestUser\(userId\) \{[\s\S]*?\n\}/);
assert.ok(cut, 'isTestUser is where this test expects it in kadeNudges.js');
const isTestUser = vm.runInNewContext(`(${cut[0]})`, { process, String });

function load(env = {}) {
  const created = [];
  const alerts = [];
  const filename = path.join(__dirname, 'KadeFeedback.js');
  const loaded = new Module(filename, module);
  const stubs = {
    '@librechat/agents/langchain/tools': { Tool: class {} },
    '@librechat/data-schemas': { logger: { info() {}, error() {}, warn() {} } },
    '~/models/kadeFeedback': { KadeFeedback: { create: async (doc) => { created.push(doc); return { _id: `row-${created.length}`, ...doc }; } } },
    '~/server/services/kadeNudges': { isTestUser },
    '~/server/services/kadeOwnerAlerts': { alertOwnerNewFeedback: async (report) => { alerts.push(report._id); } },
  };
  loaded.require = (id) => (id in stubs ? stubs[id] : Module.prototype.require.call(loaded, id));
  const keep = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    if (key in env) process.env[key] = env[key];
    else delete process.env[key];
  }
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  const Tool = loaded.exports.KadeFeedback || loaded.exports;
  const restore = () => {
    for (const key of ENV_KEYS) {
      if (keep[key] === undefined) delete process.env[key];
      else process.env[key] = keep[key];
    }
  };
  return { make: (userId) => new Tool({ userId, agentName: 'Kiana' }), created, alerts, restore };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the real list in kadeNudges.js still holds the three review/demo seats', () => {
  for (const seat of SEATS) assert.equal(isTestUser(seat), true, seat);
  assert.equal(isTestUser(FAMILY), false);
});

test('the battery question from a test seat: kept and marked, not an open row, nobody alerted, no promise that Kade will see it', async () => {
  for (const seat of SEATS) {
    const h = load();
    try {
      const said = await h.make(seat)._call({ category: 'bug', subject: 'Unlabeled button on checkout', detail: PROBE });
      assert.match(said, /^Report filed\. Category: bug\./);
      assert.doesNotMatch(said, /Kade will see/, 'a parked row is not in the default Open view, so the reply must not say she will see it');
      assert.equal(h.created.length, 1);
      assert.equal(h.created[0].status, 'acknowledged');
      assert.equal(h.created[0].detail, `[test seat] ${PROBE}`);
      await settle();
      assert.deepEqual(h.alerts, []);
    } finally { h.restore(); }
  }
});

test('the battery question in the character\'s own words is still caught (subject or detail)', async () => {
  const h = load();
  try {
    await h.make(TEST_SEAT)._call({ category: 'bug', subject: 'Unnamed button on the check-out page', detail: 'Screen reader announces a control with no label.' });
    await h.make(TEST_SEAT)._call({ category: 'bug', detail: 'Buttons on Checkout are announced with no accessible name.' });
    assert.deepEqual(h.created.map((row) => row.status), ['acknowledged', 'acknowledged']);
    await settle();
    assert.deepEqual(h.alerts, []);
  } finally { h.restore(); }
});

test('REVIEW BUG: a real report from any review or demo seat is an open row with an alert, and the reply is true', async () => {
  for (const seat of SEATS) {
    const h = load();
    try {
      const said = await h.make(seat)._call({ category: 'bug', subject: 'Send does nothing', detail: 'The send button does nothing.' });
      assert.match(said, /Kade will see it in the feedback dashboard/);
      assert.equal(h.created[0].status, 'open', `seat ${seat}`);
      assert.equal(h.created[0].detail, 'The send button does nothing.');
      await settle();
      assert.deepEqual(h.alerts, ['row-1'], `seat ${seat}`);
    } finally { h.restore(); }
  }
});

test('"check out the send button" is not the battery question', async () => {
  const h = load();
  try {
    await h.make(TEST_SEAT)._call({ category: 'bug', detail: 'Please check out the send button, it does nothing when I press it.' });
    assert.equal(h.created[0].status, 'open');
    await settle();
    assert.deepEqual(h.alerts, ['row-1']);
  } finally { h.restore(); }
});

test('a family member: an open row and an alert, exactly as before, even with the battery\'s words', async () => {
  const h = load();
  try {
    await h.make(FAMILY)._call({ category: 'bug', subject: 'Replies fail', detail: 'Replies keep failing.' });
    await h.make(FAMILY)._call({ category: 'bug', detail: PROBE });
    assert.deepEqual(h.created.map((row) => row.status), ['open', 'open']);
    assert.deepEqual(h.created.map((row) => row.detail), ['Replies keep failing.', PROBE]);
    await settle();
    assert.deepEqual(h.alerts, ['row-1', 'row-2']);
  } finally { h.restore(); }
});

test('KADE_FEEDBACK_SILENT_SEATS: a seat Kade names as battery-only is parked whatever it says; other seats are not', async () => {
  const h = load({ KADE_FEEDBACK_SILENT_SEATS: ` ${SEATS[1]} , 6a00000000000000000b0771e ` });
  try {
    const said = await h.make(SEATS[1])._call({ category: 'bug', detail: 'The send button does nothing.' });
    assert.doesNotMatch(said, /Kade will see/);
    await h.make(SEATS[0])._call({ category: 'bug', detail: 'The send button does nothing.' });
    await h.make(FAMILY)._call({ category: 'bug', detail: 'The send button does nothing.' });
    assert.deepEqual(h.created.map((row) => row.status), ['acknowledged', 'open', 'open']);
    assert.equal(h.created[0].detail, '[test seat] The send button does nothing.');
    await settle();
    assert.deepEqual(h.alerts, ['row-2', 'row-3']);
  } finally { h.restore(); }
});

test('KADE_TEST_SEAT_FEEDBACK=open puts the old behaviour back, for the battery question and for a named seat', async () => {
  const h = load({ KADE_TEST_SEAT_FEEDBACK: 'open', KADE_FEEDBACK_SILENT_SEATS: TEST_SEAT });
  try {
    const said = await h.make(TEST_SEAT)._call({ category: 'bug', detail: PROBE });
    assert.match(said, /Kade will see it in the feedback dashboard/);
    assert.equal(h.created[0].status, 'open');
    assert.equal(h.created[0].detail, PROBE);
    await settle();
    assert.deepEqual(h.alerts, ['row-1']);
  } finally { h.restore(); }
});
