'use strict';
/* Nov 10 2026: a report filed from a test seat (the nightly persona check's invented questions) is
 * kept but is not an open row and does not alert Kade.
 * Run: node --test api/app/clients/tools/structured/KadeFeedback.testseat.nodetest.js   (no installs) */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const TEST_SEAT = '6a6125d73939d20b95251078';
const PROBE = 'my screen reader keeps saying "button" with no name on the checkout page. is that my phone';

function load(env = {}) {
  const created = [];
  const alerts = [];
  const filename = path.join(__dirname, 'KadeFeedback.js');
  const loaded = new Module(filename, module);
  const nudges = fs.readFileSync(path.join(__dirname, '../../../../server/services/kadeNudges.js'), 'utf8');
  assert.ok(nudges.includes(`'${TEST_SEAT}'`), 'the test seat is on the real list in kadeNudges.js');
  const stubs = {
    '@librechat/agents/langchain/tools': { Tool: class {} },
    '@librechat/data-schemas': { logger: { info() {}, error() {}, warn() {} } },
    '~/models/kadeFeedback': { KadeFeedback: { create: async (doc) => { created.push(doc); return { _id: `row-${created.length}`, ...doc }; } } },
    '~/server/services/kadeNudges': { isTestUser: (id) => id === TEST_SEAT },
    '~/server/services/kadeOwnerAlerts': { alertOwnerNewFeedback: async (report) => { alerts.push(report._id); } },
  };
  loaded.require = (id) => (id in stubs ? stubs[id] : Module.prototype.require.call(loaded, id));
  const keep = process.env.KADE_TEST_SEAT_FEEDBACK;
  if ('KADE_TEST_SEAT_FEEDBACK' in env) process.env.KADE_TEST_SEAT_FEEDBACK = env.KADE_TEST_SEAT_FEEDBACK;
  else delete process.env.KADE_TEST_SEAT_FEEDBACK;
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  const Tool = loaded.exports.KadeFeedback || loaded.exports;
  const restore = () => { if (keep === undefined) delete process.env.KADE_TEST_SEAT_FEEDBACK; else process.env.KADE_TEST_SEAT_FEEDBACK = keep; };
  return { make: (userId) => new Tool({ userId, agentName: 'Kiana' }), created, alerts, restore };
}

test('the test seat: the report is kept and marked, is not an open row, and nobody is alerted', async () => {
  const h = load();
  try {
    const said = await h.make(TEST_SEAT)._call({ category: 'bug', subject: 'Unlabeled button on checkout', detail: PROBE });
    assert.match(said, /^Report filed\. Category: bug\./, 'the character hears the same answer');
    assert.equal(h.created.length, 1);
    assert.equal(h.created[0].status, 'acknowledged');
    assert.equal(h.created[0].detail, `[test seat] ${PROBE}`);
    assert.deepEqual(h.alerts, []);
  } finally { h.restore(); }
});

test('a family member: an open row and an alert, exactly as before', async () => {
  const h = load();
  try {
    await h.make('6a000000000000000000beef')._call({ category: 'bug', subject: 'Replies fail', detail: 'Replies keep failing.' });
    assert.equal(h.created[0].status, 'open');
    assert.equal(h.created[0].detail, 'Replies keep failing.');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(h.alerts, ['row-1']);
  } finally { h.restore(); }
});

test('KADE_TEST_SEAT_FEEDBACK=open puts the old behaviour back', async () => {
  const h = load({ KADE_TEST_SEAT_FEEDBACK: 'open' });
  try {
    await h.make(TEST_SEAT)._call({ category: 'bug', detail: PROBE });
    assert.equal(h.created[0].status, 'open');
    assert.equal(h.created[0].detail, PROBE);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(h.alerts, ['row-1']);
  } finally { h.restore(); }
});
