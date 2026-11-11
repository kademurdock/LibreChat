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

test('laneTrust: app voice counts as signed in only when the bridge says so AND the switch is on', () => {
  const env = { KADE_STUDIO_APP_VOICE: '1' };
  assert.equal(lane.laneTrust(call('hi', { kadeCallerSignedIn: true }), {}), 'phone', 'switch off (the default)');
  assert.equal(lane.laneTrust(call('hi', { kadeCallerSignedIn: true }), env), 'signed-in');
  assert.equal(lane.laneTrust(call('hi', { kadeCallerSignedIn: 'true' }), env), 'phone', 'only a real true');
  const notSeat = { ...call('hi', { kadeCallerSignedIn: true }), user: { id: 'x', role: 'USER' } };
  assert.equal(lane.laneTrust(notSeat, env), 'phone', 'only the service seat may vouch');
});

test('laneTrust: a paired phone only with the bridge flag AND KADE_PHONE_PAIRING=1', () => {
  assert.equal(lane.laneTrust(call('hi', { kadeCallerPaired: true }), {}), 'phone');
  assert.equal(lane.laneTrust(call('hi', { kadeCallerPaired: true }), { KADE_PHONE_PAIRING: '1' }), 'paired-phone');
  assert.equal(lane.laneTrust({ ...call('hi', { kadeCallerPaired: true }), kadeOnBehalfOfUnresolved: true }, { KADE_PHONE_PAIRING: '1' }), 'phone');
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

test('paired phone: hears reminders and lists and may set one; never memory, mail, messages, deletes or spending', () => {
  const env = { KADE_PHONE_PAIRING: '1' };
  const req = call('hi', { kadeCallerPaired: true });
  for (const [tool, input] of [
    ['kade_notify', { action: 'list_reminders' }],
    ['kade_notify', { action: 'set_reminder' }],
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
