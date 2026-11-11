/* Nov 11 2026 (home agent card 2): which lane a voice turn came in on (services/kadeVoiceLane.js).
 * Made-up secrets, numbers and addresses only. No database, no network, no model.
 *
 * Run: node --test api/server/services/kadeVoiceLane.nodetest.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { stubModules } = require('../../test/kadeFakeMongo.cjs');

stubModules({ '@librechat/data-schemas': { logger: { warn() {}, info() {}, error() {} } } });
const lane = require('./kadeVoiceLane');

const ENV = { KADE_CALL_INGEST_SECRET: 'offline-test-secret' };
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
/* The same strings the bridge's lane-pass.test.js mints from the same secret and time. */
const VECTOR_APP =
  'eyJ2IjoxLCJsYW5lIjoiYXBwLXZvaWNlIiwiaWF0IjoxNzk0Mzk4NDAwMDAwLCJleHAiOjE3OTQzOTg1MjAwMDAsImVtYWlsIjoic29tZW9uZUBleGFtcGxlLmludmFsaWQiLCJhZ2VudElkIjoiYWdlbnRfeCJ9.7HuKj-RW4K3HhuFWGYYQf6OkRGwGT6jkqQM8SU6ljG4';
const VECTOR_PHONE =
  'eyJ2IjoxLCJsYW5lIjoicGhvbmUiLCJpYXQiOjE3OTQzOTg0MDAwMDAsImV4cCI6MTc5NDM5ODUyMDAwMCwibnVtIjoiKzE1NTUwMTAwMTIzIiwiYWdlbnRJZCI6ImFnZW50X3gifQ.hRHaTLELdr5csUf8toz5oKoyfcWIcSgviP9rCxnjWQM';

function mint(payload, secret = ENV.KADE_CALL_INGEST_SECRET, prefix = lane.PREFIX) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', secret).update(prefix + body).digest('base64url')}`;
}

/** A voice turn as the proxy sends it: the service seat, the caller by email, the pass first in messages. */
function voiceReq(token, { email = 'someone@example.invalid', id = 'grown', resolved = true, seat = 'ADMIN', agentId = 'agent_x' } = {}) {
  return {
    user: { id: 'seat', role: seat },
    ...(resolved ? { kadeOnBehalfOf: { id, email, role: 'USER' } } : { kadeOnBehalfOfUnresolved: true }),
    body: {
      agentId,
      text: 'hello',
      kadeOnBehalfOf: email,
      messages: [...(token ? [{ role: 'kade-lane', kadeLanePass: token }] : []), { role: 'user', content: 'hello' }],
    },
  };
}

test('the bridge vectors verify here: app voice names the email, a phone pass names the number', () => {
  const a = lane.verifyLanePass(VECTOR_APP, ENV, NOW);
  assert.equal(a.lane, 'app-voice');
  assert.equal(a.email, 'someone@example.invalid');
  const p = lane.verifyLanePass(VECTOR_PHONE, ENV, NOW);
  assert.equal(p.lane, 'phone');
  assert.equal(p.num, '+15550100123');
  assert.equal(lane.verifyLanePass(VECTOR_APP, ENV, NOW + 120001), null, 'two minutes and it is gone');
  assert.equal(lane.verifyLanePass(VECTOR_APP, { KADE_USAGE_EVENT_SECRET: 'offline-test-secret' }, NOW).lane, 'app-voice', 'the older secret name');
  assert.equal(lane.verifyLanePass(VECTOR_APP, { KADE_CALL_INGEST_SECRET: 'another' }, NOW), null);
  assert.equal(lane.verifyLanePass(VECTOR_APP, {}, NOW), null, 'no secret, nothing verifies');
});

test('forged, stretched or misshapen passes are refused', () => {
  const ok = { v: 1, lane: 'app-voice', email: 'a@example.invalid', iat: NOW, exp: NOW + 60000 };
  assert.ok(lane.verifyLanePass(mint(ok), ENV, NOW));
  assert.equal(lane.verifyLanePass(mint(ok, ENV.KADE_CALL_INGEST_SECRET, ''), ENV, NOW), null, 'a web voice ticket signature (no prefix) is not a pass');
  assert.equal(lane.verifyLanePass(mint({ ...ok, exp: NOW + 3600000 }), ENV, NOW), null, 'a pass may not live an hour');
  assert.equal(lane.verifyLanePass(mint({ ...ok, iat: NOW + 3600000, exp: NOW + 3700000 }), ENV, NOW), null, 'from the future');
  assert.equal(lane.verifyLanePass(mint({ ...ok, lane: 'admin' }), ENV, NOW), null);
  assert.equal(lane.verifyLanePass(mint({ ...ok, email: '' }), ENV, NOW), null);
  assert.equal(lane.verifyLanePass(mint({ ...ok, v: 2 }), ENV, NOW), null);
  const [body, sig] = mint(ok).split('.');
  const flipped = Buffer.from(JSON.stringify({ ...ok, email: 'b@example.invalid' })).toString('base64url');
  assert.equal(lane.verifyLanePass(`${flipped}.${sig}`, ENV, NOW), null, 'a changed body');
  assert.equal(lane.verifyLanePass(`${body}.x${sig.slice(1)}`, ENV, NOW), null);
  assert.equal(lane.verifyLanePass('nonsense', ENV, NOW), null);
  assert.equal(lane.verifyLanePass(null, ENV, NOW), null);
});

test('a verified app voice turn counts as signed in for the person the seat named, and the pass leaves the body', () => {
  const req = voiceReq(VECTOR_APP);
  const r = lane.readLane(req, ENV, NOW);
  assert.deepEqual(r, { lane: 'app-voice', why: 'verified' });
  assert.deepEqual(req.kadeAppVoice, { userId: 'grown' });
  assert.equal(lane.isSignedInAppVoice(req), true);
  assert.equal(lane.laneOf(req), 'app-voice');
  assert.equal(lane.callerNumberOf(req), null);
  assert.deepEqual(req.body.messages, [{ role: 'user', content: 'hello' }], 'nothing later sees the pass');
});

test('app voice is refused for another person, another character, an unresolved caller, a non-service seat, or with the switch off', () => {
  const cases = [
    [voiceReq(VECTOR_APP, { email: 'other@example.invalid' }), 'other-person'],
    [voiceReq(VECTOR_APP, { agentId: 'agent_y' }), 'other-agent'],
    [voiceReq(VECTOR_APP, { resolved: false }), 'nobody'],
    [voiceReq(VECTOR_APP, { seat: 'USER' }), 'not-service-seat'],
    [voiceReq(VECTOR_APP), 'app-voice-off', { ...ENV, KADE_APP_VOICE_SIGNED_IN: '0' }],
    [voiceReq(null), 'no-pass'],
  ];
  for (const [req, why, env] of cases) {
    assert.equal(lane.readLane(req, env || ENV, NOW).why, why);
    assert.equal(lane.isSignedInAppVoice(req), false, why);
    assert.equal(lane.laneOf(req), 'phone', `${why}: still a phone call, as before`);
    assert.equal(req.body.messages.some((m) => m.role === 'kade-lane'), false, `${why}: the pass is taken out anyway`);
  }
  /* A bare flag or a hand-set field from a client is not the pass. */
  const flag = voiceReq(null);
  flag.body.kadeCallerSignedIn = true;
  lane.readLane(flag, ENV, NOW);
  assert.equal(lane.laneOf(flag), 'phone');
  const stale = voiceReq(VECTOR_APP);
  stale.kadeAppVoice = { userId: 'someone-else' };
  assert.equal(lane.isSignedInAppVoice(stale), false);
});

test('a phone pass gives the caller number, never a sign-in, and plain caller-ID calls stay phone', () => {
  const req = voiceReq(VECTOR_PHONE);
  assert.deepEqual(lane.readLane(req, ENV, NOW), { lane: 'phone', why: 'phone-number' });
  assert.equal(lane.callerNumberOf(req), '+15550100123');
  assert.equal(lane.isSignedInAppVoice(req), false);
  assert.equal(lane.laneOf(req), 'phone');
  /* The app-voice switch does not stop the number (pairing has its own switch). */
  const off = voiceReq(VECTOR_PHONE);
  lane.readLane(off, { ...ENV, KADE_APP_VOICE_SIGNED_IN: '0' }, NOW);
  assert.equal(lane.callerNumberOf(off), '+15550100123');
  /* An unregistered caller: no email, the seat's messages array. */
  const anon = { user: { id: 'seat', role: 'ADMIN' }, body: { agentId: 'agent_x', text: 'hi', messages: [{ role: 'kade-lane', kadeLanePass: VECTOR_PHONE }, { role: 'user', content: 'hi' }] } };
  lane.readLane(anon, ENV, NOW);
  assert.equal(lane.laneOf(anon), 'phone');
  assert.equal(lane.callerNumberOf(anon), '+15550100123');
});

test('typing in the app is text; the middleware never throws and always calls next', () => {
  const typed = { user: { id: 'grown', role: 'USER' }, body: { text: 'pair my phone', conversationId: 'c1' } };
  assert.equal(lane.laneOf(typed), 'text');
  const boss = { user: { id: 'boss', role: 'ADMIN' }, body: { text: 'pair my phone' } };
  assert.equal(lane.laneOf(boss), 'text', 'the administrator typing in the app');
  /* A text-chat user cannot smuggle a pass in: only the service seat's passes count. */
  const sneaky = { user: { id: 'grown', role: 'USER' }, body: { text: 'hi', kadeLanePass: VECTOR_APP } };
  assert.equal(lane.readLane(sneaky, ENV, NOW).why, 'not-service-seat');
  assert.equal(Object.hasOwn(sneaky.body, 'kadeLanePass'), false);
  let called = 0;
  lane.markVoiceLane({ body: null }, null, () => called++);
  lane.markVoiceLane(null, null, () => called++);
  lane.markVoiceLane(voiceReq(VECTOR_APP), null, () => called++);
  assert.equal(called, 3);
});

test('integration: a phone pass starts the pairing lookup without waiting, and the safety lane then says paired-phone', async () => {
  const P = require('./kadePhonePairing');
  const trust = require('./kadeLaneTrust');
  const orig = P.isPairedPhone;
  const before = process.env.KADE_CALL_INGEST_SECRET;
  let release;
  let asked = 0;
  P.isPairedPhone = (num) => {
    asked++;
    assert.equal(num, '+15550100123');
    return new Promise((r) => (release = () => r('grown')));
  };
  process.env.KADE_CALL_INGEST_SECRET = ENV.KADE_CALL_INGEST_SECRET;
  try {
    const t = Date.now();
    const req = voiceReq(mint({ v: 1, lane: 'phone', num: '+15550100123', agentId: 'agent_x', iat: t, exp: t + 60000 }));
    let nextRan = false;
    lane.markVoiceLane(req, null, () => (nextRan = true));
    assert.equal(nextRan, true, 'the turn goes on at once');
    await new Promise((r) => setImmediate(r));
    assert.equal(asked, 1, 'the lookup was started');
    assert.equal(trust.laneTrust(req), 'phone', 'not settled yet: a plain call');
    release();
    assert.equal(await trust.resolvePairing(req), true, 'the same lookup, not a second one');
    assert.equal(asked, 1);
    assert.equal(trust.laneTrust(req), 'paired-phone');
    const app = voiceReq(VECTOR_APP);
    lane.markVoiceLane(app, null, () => {});
    assert.equal(asked, 1, 'no lookup without a caller number');
  } finally {
    P.isPairedPhone = orig;
    if (before === undefined) delete process.env.KADE_CALL_INGEST_SECRET;
    else process.env.KADE_CALL_INGEST_SECRET = before;
  }
});
