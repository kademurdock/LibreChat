/* Nov 11 2026 (home agent plan, card 4): truth from the ledger. Every kade tool result begins OK
 * or FAILED, each call gets a code-built row for the turn, and the note the character reads after
 * its tool calls says what really happened. A forced failure must show up as FAILED.
 * No database, no model, no network.
 *
 * Run: node --test api/server/services/kadeLedger.nodetest.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ledger = require('./kadeLedger');

const turn = (t = 'remind me to call the pharmacy at 3') => ({ user: { id: 'u1', role: 'USER' }, body: { conversationId: 'c-1', text: t } });
const fake = (impl) => ({ _call: impl });

test('a tool that THROWS: the result begins FAILED and the turn note says it failed', async () => {
  const req = turn();
  const notify = ledger.wrapKadeTool('kade_notify', fake(async () => {
    throw new Error('bridge did not answer');
  }), req);
  const out = await notify._call({ action: 'set_reminder', body: 'Call the pharmacy', fire_time: '15:00' });
  assert.match(out, /^FAILED: kade_notify set_reminder did not work/);
  assert.match(out, /It did not happen/);
  assert.match(out, /Platform record of this turn's tool calls, kept by code: 1\) kade_notify set_reminder: FAILED \(threw\)/);
  assert.match(out, /A FAILED call did not happen; never say it worked/);
  const rows = ledger.rows(req);
  assert.equal(rows.length, 1);
  assert.deepEqual({ tool: rows[0].tool, action: rows[0].action, ok: rows[0].ok, code: rows[0].code }, {
    tool: 'kade_notify', action: 'set_reminder', ok: false, code: 'threw',
  });
});

test('a tool that RETURNS a failure sentence: FAILED; a later success in the same turn: OK, and the note lists both', async () => {
  const req = turn();
  const notify = ledger.wrapKadeTool('kade_notify', fake(async ({ action }) =>
    action === 'set_reminder' ? 'Could not complete set_reminder: the reminder store is away' : 'Reminder set (id r9) for 3:00 PM.'), req);
  const first = await notify._call({ action: 'set_reminder' });
  assert.match(first, /^FAILED: Could not complete set_reminder/);
  const second = await notify._call({ action: 'list_reminders' });
  assert.match(second, /^OK: Reminder set \(id r9\)/);
  assert.match(second, /1\) kade_notify set_reminder: FAILED \(returned-failure\); 2\) kade_notify list_reminders: OK/);
  /* the promise guard's own marker still reads through the prefix */
  assert.ok(second.includes('Reminder set (id'));
});

test('the tool-truth note the reply is built on says FAILED for the failed call (scenario: "done and done")', async () => {
  const req = turn();
  const notify = ledger.wrapKadeTool('kade_notify', fake(async () => 'Not set: the time was in the past'), req);
  await notify._call({ action: 'set_reminder' });
  const note = ledger.truthNote(req);
  assert.match(note, /kade_notify set_reminder: FAILED/);
  assert.doesNotMatch(note, /: OK/);
  /* and a reply that claims it anyway is counted as unbacked, in the log only */
  const lines = [];
  const counted = ledger.countLedgerClaims(req, [{ type: 'text', text: 'Done and done. Your reminder is set for 3.' }], {
    agentId: 'agent_test', logger: { info: (l) => lines.push(l) }, env: {},
  });
  assert.equal(counted.unbacked.reminder, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[kade\/ledger-claims\] agent=agent_test rows=1 ok=0 failed=1 unbacked start=0 reminder=1 failure=0 price=0$/);
  assert.ok(!lines[0].includes('Done and done'), 'no reply text in the log');
});

test('JSON results: ok:false and error are FAILED; a normal JSON answer is OK', async () => {
  const req = turn();
  const t = ledger.wrapKadeTool('kade_task', fake(async ({ action }) =>
    action === 'start' ? JSON.stringify({ ok: false, error: 'x' }) : JSON.stringify({ started: true, taskId: 't1' })), req);
  assert.match(await t._call({ action: 'start' }), /^FAILED: \{/);
  assert.match(await t._call({ action: 'status' }), /^OK: \{"started":true/);
});

test('a result that already says OK or FAILED is not marked twice; refusal shapes in use today read as FAILED', () => {
  assert.equal(ledger.stamp('OK: fine', true, null), 'OK: fine');
  assert.equal(ledger.stamp('FAILED: no', false, null), 'FAILED: no');
  for (const s of [
    'Not started: their last message is not a plain yes',
    'NOT MADE YET, and nothing was charged.',
    'NOT MADE, and nothing was charged. One paid song per reply',
    'Could not complete cancel_checkin: gone',
    'Unknown action "x".',
    'OUT OF CREDITS — do not retry.',
    '',
  ]) {
    assert.equal(ledger.judge(s).ok, false, JSON.stringify(s));
  }
  for (const s of ['Reminder set (id r1)', 'Sunny and 70.', 'Here is what I found', '[Play the song](https://x.invalid/a.mp3)']) {
    assert.equal(ledger.judge(s).ok, true, s);
  }
});

test('rows hold no user text: arguments, outputs and odd action strings never reach a row or the note', async () => {
  const req = turn();
  const t = ledger.wrapKadeTool('kade_notify', fake(async () => 'Reminder set (id r1) — call Dr. Example about the results'), req);
  await t._call({ action: 'set_reminder', body: 'PRIVATE WORDS' });
  await t._call({ action: 'Set Reminder for PRIVATE WORDS' });
  for (const r of ledger.rows(req)) {
    const all = JSON.stringify(r);
    assert.ok(!all.includes('PRIVATE'), all);
    assert.ok(!all.includes('Example'), all);
  }
  assert.equal(ledger.rows(req)[1].action, null);
  assert.ok(!ledger.truthNote(req).includes('PRIVATE'));
});

test('only kade_* tools and fal_studio are wrapped; a wrapped tool is wrapped once; an abort still aborts', async () => {
  const req = turn();
  const other = fake(async () => 'x');
  assert.equal(ledger.wrapKadeTool('web_search', other, req)._call === other._call, true);
  const t = fake(async () => 'Sunny.');
  ledger.wrapKadeTool('kade_weather', t, req);
  const once = t._call;
  ledger.wrapKadeTool('kade_weather', t, req);
  assert.equal(t._call, once);
  const aborting = ledger.wrapKadeTool('kade_research', fake(async () => {
    throw Object.assign(new Error('stopped'), { name: 'AbortError' });
  }), turn());
  await assert.rejects(aborting._call({ action: 'check' }), /stopped/);
});

test('ledgered(): the lazy loader hands back the wrapped instance (as handleTools uses it)', async () => {
  const req = turn();
  const load = async () => fake(async () => 'Sunny.');
  const wrapped = ledger.ledgered('kade_weather', load, req);
  const inst = await wrapped();
  assert.match(await inst._call({}), /^OK: Sunny\./);
  assert.equal(ledger.ledgered('calculator', load, req), load);
});

test('the claim count: off with KADE_CLAIM_COUNT=0; a backed claim is not counted; no log line when all is backed', async () => {
  const req = turn();
  const reply = [{ type: 'text', text: 'Your reminder is set for 3.' }];
  assert.equal(ledger.countLedgerClaims(req, reply, { env: { KADE_CLAIM_COUNT: '0' } }), null);
  const t = ledger.wrapKadeTool('kade_notify', fake(async () => 'Reminder set (id r1)'), req);
  await t._call({ action: 'set_reminder' });
  const lines = [];
  const n = ledger.countLedgerClaims(req, reply, { logger: { info: (l) => lines.push(l) }, env: {} });
  assert.equal(n.unbacked.reminder, 0);
  assert.equal(lines.length, 0);
  /* a failure claim with no FAILED row, and a start claim with nothing behind it */
  const bare = turn();
  const m = ledger.countLedgerClaims(bare, [{ type: 'text', text: 'The search tool is down right now. I started it anyway.' }], { logger: { info() {} }, env: {} });
  assert.equal(m.unbacked.failure, 1);
  assert.equal(m.unbacked.start, 1);
});
