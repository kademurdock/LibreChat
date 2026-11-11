/* Nov 11 2026 (home agent plan, card 3): the phone lane limits. A caller known only by caller
 * ID hears, changes, deletes and spends nothing of a person's; a paired phone (card 2, not built)
 * may hear reminders and lists; signed-in chat keeps everything. Refused in code, before the tool
 * runs. No database, no model, no network.
 *
 * Run: node --test api/server/services/kadeLaneTrust.nodetest.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lane = require('./kadeLaneTrust');
const ledger = require('./kadeLedger');

const text = (t = 'hello', extra = {}) => ({ user: { id: 'u1', role: 'USER' }, body: { conversationId: 'c-1', text: t, ...extra } });
/* The voice proxy's turn: the service seat (an admin) names who is on the line. */
const call = (t = 'hello', bodyExtra = {}, reqExtra = {}) => ({
  user: { id: 'seat', role: 'ADMIN' },
  body: { conversationId: 'call-1', text: t, kadeOnBehalfOf: 'caller@example.com', ...bodyExtra },
  kadeOnBehalfOf: { id: 'u1' },
  ...reqExtra,
});
const FOLD =
  '[EARLIER IN THIS CONVERSATION — context only, already handled, do not re-answer:\nTHEM: hi\nYOU: hello\n' +
  '— end of earlier context. Reply ONLY to what follows.]\n\n';

test('laneTrust: text chat and background runs are signed in; every voice shape is a phone', () => {
  assert.equal(lane.laneTrust(text()), 'signed-in');
  assert.equal(lane.laneTrust({ ...text(), kadeHiddenRun: true }), 'signed-in');
  assert.equal(lane.laneTrust(call()), 'phone');
  assert.equal(lane.laneTrust({ ...text(), kadeOnBehalfOfUnresolved: true }), 'phone');
  assert.equal(lane.laneTrust(text('hi', { kadeOnBehalfOf: 'nobody@example.com' })), 'phone', 'named but not matched');
  assert.equal(lane.laneTrust(text(FOLD + 'what is on my list')), 'phone', 'a folded call turn on the seat itself');
  assert.equal(lane.laneTrust(null), 'phone');
  assert.equal(lane.laneTrust({ body: {} }), 'phone', 'no signed-in user');
});

/* What kadeVoiceLane.markVoiceLane sets from the bridge's signed pass (card 2). */
const appVoice = (t = 'hi') => call(t, {}, { kadeAppVoice: { userId: 'u1' } });
const numbered = (t = 'hi', num = '+15550100123') => call(t, {}, { kadeCallerNumber: num });
const pairedTo = (acct) => ({ isPairedPhone: async () => acct });

test('laneTrust: app voice is signed in only with the verified pass for that person; bare body flags never count', () => {
  assert.equal(lane.laneTrust(appVoice()), 'signed-in');
  assert.equal(lane.laneTrust(call('hi', { kadeCallerSignedIn: true }), { KADE_STUDIO_APP_VOICE: '1' }), 'phone', 'bare flag');
  assert.equal(lane.laneTrust(call('hi', { kadeCallerPaired: true }), { KADE_PHONE_PAIRING: '1' }), 'phone', 'bare flag');
  assert.equal(lane.laneTrust({ ...appVoice(), user: { id: 'x', role: 'USER' } }), 'phone', 'only the service seat may vouch');
  assert.equal(lane.laneTrust({ ...appVoice(), kadeAppVoice: { userId: 'u2' } }), 'phone', 'a pass for someone else');
});

test('laneTrust: a paired phone only after resolvePairing finds the verified number paired to the named account', async () => {
  const r1 = numbered();
  assert.equal(lane.laneTrust(r1), 'phone', 'not looked up yet');
  assert.equal(await lane.resolvePairing(r1, pairedTo('u1')), true);
  assert.equal(lane.laneTrust(r1), 'paired-phone');
  const r2 = numbered();
  assert.equal(await lane.resolvePairing(r2, pairedTo('u2')), false, 'paired to another account');
  assert.equal(lane.laneTrust(r2), 'phone');
  const r3 = numbered();
  assert.equal(await lane.resolvePairing(r3, pairedTo(null)), false);
  let looked = 0;
  const r4 = call('hi');
  assert.equal(await lane.resolvePairing(r4, { isPairedPhone: async () => (looked++, 'u1') }), false, 'no verified number');
  const r5 = { ...numbered(), kadeOnBehalfOfUnresolved: true };
  assert.equal(await lane.resolvePairing(r5, { isPairedPhone: async () => (looked++, 'u1') }), false, 'unmatched caller');
  assert.equal(await lane.resolvePairing(appVoice(), { isPairedPhone: async () => (looked++, 'u1') }), false, 'app voice');
  assert.equal(looked, 0, 'no lookup on any turn without a verified phone number');
  const slow = numbered();
  assert.equal(await lane.resolvePairing(slow, { isPairedPhone: () => new Promise(() => {}), waitMs: 20 }), false, 'a slow lookup is a plain call');
  const broken = numbered();
  assert.equal(await lane.resolvePairing(broken, { isPairedPhone: async () => { throw new Error('db down'); } }), false);
  /* once per turn */
  let n = 0;
  const once = numbered();
  await Promise.all([1, 2, 3].map(() => lane.resolvePairing(once, { isPairedPhone: async () => (n++, 'u1') })));
  assert.equal(n, 1);
});

test('the real pairing store: isPairedPhone is what resolvePairing asks by default', async () => {
  const P = require('./kadePhonePairing');
  const orig = P.isPairedPhone;
  let asked = null;
  P.isPairedPhone = async (num) => ((asked = num), 'u1');
  try {
    const r = numbered('hi', '+15550100999');
    assert.equal(await lane.resolvePairing(r), true);
    assert.equal(asked, '+15550100999');
    assert.equal(lane.laneTrust(r), 'paired-phone');
  } finally {
    P.isPairedPhone = orig;
  }
});

test('unpaired phone: reminders, lists, memory, forget, deletes, writes, messages, spending and standing yes are refused', () => {
  const asks = [
    ['kade_notify', { action: 'list_reminders' }],
    ['kade_notify', { action: 'set_reminder' }],
    ['kade_notify', { action: 'cancel_reminder' }],
    ['kade_notify', { action: 'list_checkins' }],
    ['kade_memory_search', { query: 'x' }],
    ['kade_living_memory', { action: 'read' }],
    ['kade_call_me', { action: 'list_calls' }],
    ['kade_call_me', { action: 'cancel_call' }],
    ['kade_task', { action: 'list' }],
    ['kade_task', { action: 'quote' }],
    ['kade_task', { action: 'start' }],
    ['kade_studio', { action: 'status' }],
    ['kade_research', { action: 'start' }],
    ['kade_phone_call', { action: 'place_call' }],
    ['kade_message', { to: 'x', message: 'y' }],
    ['kade_funding_balance', {}],
    ['kade_transcribe', {}],
    ['kade_approvals', { action: 'approve' }],
    ['kade_adventure', { action: 'delete' }],
    ['fal_studio', { action: 'generate_image' }],
    ['kade_something_new', { action: 'anything' }],
  ];
  for (const [tool, input] of asks) {
    const r = lane.laneRefusal(tool, input, call());
    assert.ok(r, `${tool} ${input.action || ''} must be refused on a phone`);
    assert.match(r.text, /^FAILED: not done/);
    assert.ok(r.text.includes(lane.LINE_PHONE), 'the plain line');
  }
});

test('unpaired phone: general things still work', () => {
  for (const [tool, input] of [
    ['kade_weather', {}],
    ['kade_news', { category: 'local' }],
    ['kade_joke', {}],
    ['kade_wikipedia', { query: 'x' }],
    ['kade_games', { action: 'move' }],
    ['kade_notify', { action: 'platform_status' }],
    ['kade_feedback', { action: 'file' }],
    ['kade_call_me', { action: 'list_ringtones' }],
  ]) {
    assert.equal(lane.laneRefusal(tool, input, call()), null, `${tool} ${input.action || ''}`);
  }
});

test('paired phone: hears reminders and lists and may set one; never memory, mail, messages, deletes or spending', async () => {
  const env = {};
  const req = numbered();
  await lane.resolvePairing(req, pairedTo('u1'));
  for (const [tool, input] of [
    ['kade_notify', { action: 'list_reminders' }],
    ['kade_notify', { action: 'set_reminder' }],
    ['kade_notify', { action: 'list_read' }],
    ['kade_notify', { action: 'list_add' }],
    ['kade_notify', { action: 'medicine_list' }],
    ['kade_notify', { action: 'contact_read' }],
    ['kade_notify', { action: 'check_back' }],
    ['kade_call_me', { action: 'list_calls' }],
    ['kade_task', { action: 'status' }],
  ]) {
    assert.equal(lane.laneRefusal(tool, input, req, env), null, `${tool} ${input.action}`);
  }
  for (const [tool, input] of [
    ['kade_memory_search', {}],
    ['kade_notify', { action: 'cancel_reminder' }],
    ['kade_message', {}],
    ['kade_task', { action: 'start' }],
    ['kade_task', { action: 'quote' }],
    ['kade_funding_balance', {}],
    ['kade_approvals', { action: 'approve' }],
    ['kade_notify', { action: 'list_clear' }],
    ['kade_notify', { action: 'list_remove' }],
    ['kade_notify', { action: 'contact_remove' }],
    ['kade_notify', { action: 'medicine_change' }],
    ['kade_known', { action: 'count' }],
    ['kade_known', { action: 'forget' }],
    ['kade_recall', { query: 'x' }],
    ['kade_phone_pairing', { action: 'unpair' }],
  ]) {
    const r = lane.laneRefusal(tool, input, req, env);
    assert.ok(r, `${tool} ${input.action || ''}`);
    assert.ok(r.text.includes(lane.LINE_PAIRED));
  }
});

test('signed-in chat keeps everything; the Library and family history keep their own rules', () => {
  for (const tool of Object.keys(lane.KINDS)) {
    assert.equal(lane.laneRefusal(tool, { action: 'cancel_reminder' }, text()), null, tool);
  }
  assert.equal(lane.laneRefusal('kade_memory_search', {}, { ...call(), kadeHiddenRun: true }), null);
  for (const tool of lane.EXEMPT) assert.equal(lane.laneRefusal(tool, {}, call()), null, tool);
});

test('refused in code BEFORE the tool runs: the tool body is never called, and the ledger says FAILED', async () => {
  let ran = 0;
  const tool = { _call: async () => (ran++, 'Reminder set (id r1)') };
  const req = call('what are my reminders');
  ledger.wrapKadeTool('kade_notify', tool, req, {});
  const out = await tool._call({ action: 'list_reminders' });
  assert.equal(ran, 0);
  assert.match(out, /^FAILED: not done/);
  assert.ok(out.includes('I can do that in the app, or once this phone is paired.'));
  assert.match(out, /kade_notify list_reminders: FAILED \(refused-phone\)/);
  /* a general thing in the same call goes through */
  const weather = { _call: async () => 'Sunny, 70.' };
  ledger.wrapKadeTool('kade_weather', weather, req, {});
  assert.match(await weather._call({}), /^OK: Sunny, 70\./);
});

test('integration (cards 2, 6-9): new tools on an unpaired phone; a pairing code can still be said on a call', () => {
  for (const [tool, input] of [
    ['kade_known', { action: 'count' }],
    ['kade_known', { action: 'forget_all' }],
    ['kade_recall', { query: 'pharmacy' }],
    ['kade_notify', { action: 'list_read' }],
    ['kade_notify', { action: 'medicine_add' }],
    ['kade_notify', { action: 'timer' }],
    ['kade_notify', { action: 'contact_read' }],
    ['kade_phone_pairing', { action: 'code' }],
    ['kade_phone_pairing', { action: 'list' }],
  ]) {
    assert.ok(lane.laneRefusal(tool, input, call()), `${tool} ${input.action || ''} must be refused on a phone`);
  }
  assert.equal(lane.laneRefusal('kade_notify', { action: 'now' }, call()), null, 'the time is general');
  assert.equal(lane.laneRefusal('kade_phone_pairing', { action: 'redeem' }, call()), null, 'redeem happens on the call');
  assert.equal(lane.laneRefusal('kade_phone_pairing', { action: 'redeem' }, { ...call(), kadeOnBehalfOfUnresolved: true }), null, 'even from a number nobody knows yet');
});

test('the ledger wrapper looks the pairing up before it decides, and a paired phone may then read its list', async () => {
  const P = require('./kadePhonePairing');
  const orig = P.isPairedPhone;
  P.isPairedPhone = async () => 'u1';
  try {
    let ran = 0;
    const tool = { _call: async () => (ran++, 'OK. The shopping list has 1 item: milk.') };
    const req = numbered('read my shopping list');
    ledger.wrapKadeTool('kade_notify', tool, req, {});
    assert.match(await tool._call({ action: 'list_read' }), /^OK\. The shopping list/);
    assert.equal(ran, 1);
    const clear = { _call: async () => (ran++, 'cleared') };
    ledger.wrapKadeTool('kade_notify', clear, req, {});
    const out = await clear._call({ action: 'list_clear' });
    assert.match(out, /^FAILED: not done/);
    assert.ok(out.includes(lane.LINE_PAIRED));
    assert.equal(ran, 1, 'the clear never ran');
  } finally {
    P.isPairedPhone = orig;
  }
});

test('deliveries from the reminder sweep get a ledger row with fixed words only', () => {
  const row = ledger.recordDelivery({
    tool: 'kade_notify',
    event: 'delivery',
    kind: 'medicine',
    outcome: 'not delivered',
    channel: 'none',
    userId: 'a1b2c3d4e5f6a1b2c3d4e5f6',
    agentId: 'agent_abcdefghijkl',
    ref: 'r0123456789',
    message: 'take the blue pill',
  });
  assert.equal(row.ok, false);
  assert.equal(row.user, 'a1b2c3d4');
  assert.equal(row.ref, 'r0123456');
  assert.equal(JSON.stringify(row).includes('pill'), false, 'no reminder words');
  const bad = ledger.recordDelivery({ event: 'delivery', outcome: 'Take <b>x</b>!', userId: 'a b' });
  assert.equal(bad.outcome, null);
  assert.equal(bad.user, null);
  assert.ok(ledger.recentDeliveries(2).length === 2);
  assert.equal(ledger.recordDelivery(null).event, 'event', 'never throws');
});

test('every kade tool the platform builds has a lane kind (a new tool must be classified, or it is refused on phones)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../app/clients/tools/util/handleTools.js'), 'utf8');
  const names = [...new Set(src.match(/\bkade_[a-z_]+(?=: Kade)/g))];
  assert.ok(names.length > 20, 'found the tool table');
  for (const n of names) assert.ok(lane.KINDS[n] || lane.EXEMPT.has(n), `${n} has no lane kind`);
});

test('the wiring: handleTools wraps every built tool, and the keeper cannot delete on a phone turn', () => {
  const tools = fs.readFileSync(path.join(__dirname, '../../app/clients/tools/util/handleTools.js'), 'utf8');
  assert.match(tools, /requestedTools\[tool\] = kadeLedgered\(tool, toolInstance, kadeTurnReq\);/);
  const client = fs.readFileSync(path.join(__dirname, '../controllers/agents/client.js'), 'utf8');
  assert.match(client, /laneTrust\(this\.options\.req\) === 'signed-in'\s*\?\s*db\.deleteMemory/);
  assert.match(client, /countLedgerClaims\(this\.options\?\.req, completion/);
});
