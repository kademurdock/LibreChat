/* Nov 11 2026 (home agent card 2): phone pairing (services/kadePhonePairing.js) and its tool.
 * In-memory collections, made-up numbers and keys only. No database, no network, no model.
 *
 * Run: node --test api/server/services/kadePhonePairing.nodetest.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { FakeCollection, stubModules } = require('../../test/kadeFakeMongo.cjs');

class FakeTool {}
const pairingPath = require.resolve('./kadePhonePairing');
stubModules({
  '@librechat/data-schemas': { logger: { warn() {}, info() {}, error() {} } },
  '@librechat/agents/langchain/tools': { Tool: FakeTool },
  '~/server/services/kadePhonePairing': require(pairingPath),
});
const pairing = require('./kadePhonePairing');

const KEY = 'ab'.repeat(32); /* a made-up CREDS_KEY */
const NUMBER = '+15550100123';
const OTHER_NUMBER = '+15550100999';

function world({ env = {}, codes = [] } = {}) {
  let t = Date.UTC(2026, 10, 11, 12, 0, 0);
  const queue = [...codes];
  const deps = {
    env: { CREDS_KEY: KEY, ...env },
    codes: new FakeCollection(),
    phones: new FakeCollection(),
    now: () => t,
    random: () => (queue.length ? queue.shift() : 123456),
  };
  return { deps, advance: (ms) => (t += ms) };
}
/* Requests as services/kadeVoiceLane.js leaves them. */
const typed = (userId) => ({ user: { id: userId, role: 'USER' }, body: { text: 'pair my phone', conversationId: 'c1' } });
const appVoice = (userId) => ({
  user: { id: 'seat', role: 'ADMIN' },
  kadeOnBehalfOf: { id: userId, email: `${userId}@example.invalid` },
  kadeAppVoice: { userId },
  body: { kadeOnBehalfOf: `${userId}@example.invalid`, messages: [{ role: 'user', content: 'pair my phone' }], text: 'pair my phone' },
});
const call = (number, asUser) => ({
  user: { id: 'seat', role: 'ADMIN' },
  ...(asUser ? { kadeOnBehalfOf: { id: asUser, email: `${asUser}@example.invalid` } } : {}),
  ...(number ? { kadeCallerNumber: number } : {}),
  body: { ...(asUser ? { kadeOnBehalfOf: `${asUser}@example.invalid` } : {}), messages: [{ role: 'user', content: 'x' }], text: 'x' },
});

test('pair my phone in the app, then the code said on a call pairs that number; the person hears which numbers are paired', async () => {
  const w = world({ codes: [417209] });
  const made = await pairing.makeCode({ req: typed('grown') }, w.deps);
  assert.equal(made.ok, true, made.error);
  assert.equal(made.code, '417209');
  assert.match(made.tellThem, /4 1 7 2 0 9/);
  assert.match(made.tellThem, /one hour/);
  assert.match(made.tellThem, /No phone numbers are paired/);
  assert.equal(JSON.stringify(w.deps.codes.rows).includes('417209'), false, 'only a keyed hash of the code is stored');

  const done = await pairing.redeem({ req: call(NUMBER), code: 'four one seven two oh nine' }, w.deps);
  assert.equal(done.ok, true, done.error);
  assert.equal(done.ending, '0123');
  assert.equal(JSON.stringify(w.deps.phones.rows).includes('5550100123'), false, 'the number is stored hashed');
  assert.equal(w.deps.phones.rows[0].last4, '0123');
  assert.equal(await pairing.isPairedPhone(NUMBER, w.deps), 'grown');
  assert.equal(await pairing.isPairedPhone('(555) 010-0123', w.deps), 'grown', 'written the usual US way');
  assert.equal(await pairing.isPairedPhone(OTHER_NUMBER, w.deps), null);

  const listed = await pairing.list({ req: typed('grown') }, w.deps);
  assert.deepEqual(listed.paired, ['0123']);
  assert.match(listed.tellThem, /ending in 0 1 2 3/);
  /* The code is one-time. */
  assert.equal((await pairing.redeem({ req: call(OTHER_NUMBER), code: '417209' }, w.deps)).ok, false);
});

test('signed-in app voice may ask for a code; a phone call may not, and a code cannot be redeemed in the app', async () => {
  const w = world({ codes: [222333] });
  assert.equal((await pairing.makeCode({ req: appVoice('grown') }, w.deps)).ok, true);
  const phoneAsk = await pairing.makeCode({ req: call(NUMBER, 'grown') }, w.deps);
  assert.equal(phoneAsk.ok, false, 'caller ID alone never makes a code');
  assert.match(phoneAsk.error, /in the app/);
  assert.equal((await pairing.list({ req: call(NUMBER, 'grown') }, w.deps)).ok, false, 'a caller does not hear the paired numbers');
  assert.equal((await pairing.unpair({ req: call(NUMBER, 'grown') }, w.deps)).ok, false, 'nor unpair them');
  const inApp = await pairing.redeem({ req: typed('grown'), code: '222333' }, w.deps);
  assert.equal(inApp.ok, false);
  assert.match(inApp.error, /phone call/);
  /* A call whose number the bridge could not vouch for (an old bridge, an outbound call). */
  const blind = await pairing.redeem({ req: call(null, 'grown'), code: '222333' }, w.deps);
  assert.equal(blind.ok, false);
  assert.match(blind.error, /cannot be seen/);
  /* A background run never pairs anything. */
  assert.equal((await pairing.makeCode({ req: { ...typed('grown'), kadeHiddenRun: true } }, w.deps)).ok, false);
});

test('five wrong tries lock a code; an hour ends it; a new code ends the old one', async () => {
  const w = world({ codes: [111111, 555555, 777777] });
  await pairing.makeCode({ req: typed('grown') }, w.deps);
  for (let i = 0; i < 5; i++) {
    const r = await pairing.redeem({ req: call(OTHER_NUMBER), code: String(900000 + i) }, w.deps);
    assert.equal(r.ok, false);
  }
  assert.equal(w.deps.codes.rows[0].wrong, 5);
  assert.ok(w.deps.codes.rows[0].lockedAt, 'locked');
  assert.equal((await pairing.redeem({ req: call(NUMBER), code: '111111' }, w.deps)).ok, false, 'even the right code, once locked');

  await pairing.makeCode({ req: typed('grown') }, w.deps);
  w.advance(61 * 60000);
  assert.equal((await pairing.redeem({ req: call(NUMBER), code: '555555' }, w.deps)).ok, false, 'an hour and it is gone');

  const first = await pairing.makeCode({ req: typed('grown') }, w.deps);
  const second = await pairing.makeCode({ req: typed('grown') }, w.deps);
  assert.notEqual(first.code, second.code);
  assert.equal((await pairing.redeem({ req: call(NUMBER), code: first.code }, w.deps)).ok, false, 'the older code stopped working');
  assert.equal((await pairing.redeem({ req: call(NUMBER), code: second.code }, w.deps)).ok, true);
  /* Garbled input is asked again and does not count as a wrong try. */
  const before = w.deps.codes.rows.map((r) => r.wrong);
  assert.match((await pairing.redeem({ req: call(NUMBER), code: 'one two' }, w.deps)).error, /six digits/);
  assert.deepEqual(w.deps.codes.rows.map((r) => r.wrong), before);
});

test('a number paired to one account cannot be taken by another; unpair from the app frees it', async () => {
  const w = world({ codes: [101010, 202020, 303030] });
  await pairing.makeCode({ req: typed('grown') }, w.deps);
  assert.equal((await pairing.redeem({ req: call(NUMBER), code: '101010' }, w.deps)).ok, true);
  await pairing.makeCode({ req: typed('stranger') }, w.deps);
  const taken = await pairing.redeem({ req: call(NUMBER), code: '202020' }, w.deps);
  assert.equal(taken.ok, false);
  assert.match(taken.error, /another account/);
  assert.equal(await pairing.isPairedPhone(NUMBER, w.deps), 'grown');
  /* The stranger's code was not spent by the refusal. */
  assert.equal(w.deps.codes.rows.find((r) => r.userId === 'stranger').usedAt, undefined);

  /* Two phones on one account: unpair asks which, then removes the one named. */
  await pairing.makeCode({ req: typed('grown') }, w.deps);
  assert.equal((await pairing.redeem({ req: call(OTHER_NUMBER), code: '303030' }, w.deps)).ok, true);
  const which = await pairing.unpair({ req: typed('grown') }, w.deps);
  assert.equal(which.ok, false);
  assert.match(which.error, /0 1 2 3.*0 9 9 9/);
  const gone = await pairing.unpair({ req: appVoice('grown'), ending: '0123' }, w.deps);
  assert.equal(gone.ok, true);
  assert.deepEqual(gone.removed, ['0123']);
  assert.match(gone.tellThem, /0 9 9 9/);
  assert.equal(await pairing.isPairedPhone(NUMBER, w.deps), null);
  assert.equal(await pairing.isPairedPhone(OTHER_NUMBER, w.deps), 'grown');
  assert.equal((await pairing.unpair({ req: typed('stranger'), ending: 'all' }, w.deps)).removed.length, 0, 'nobody unpairs another account');
  assert.equal(await pairing.isPairedPhone(OTHER_NUMBER, w.deps), 'grown');
});

test('KADE_PHONE_PAIRING=0 refuses everything and isPairedPhone says null; no real key means no pairing', async () => {
  const w = world({ codes: [424242] });
  await pairing.makeCode({ req: typed('grown') }, w.deps);
  await pairing.redeem({ req: call(NUMBER), code: '424242' }, w.deps);
  assert.equal(await pairing.isPairedPhone(NUMBER, w.deps), 'grown');
  const off = { ...w.deps, env: { ...w.deps.env, KADE_PHONE_PAIRING: '0' } };
  assert.equal((await pairing.makeCode({ req: typed('grown') }, off)).ok, false);
  assert.equal((await pairing.redeem({ req: call(NUMBER), code: '424242' }, off)).ok, false);
  assert.equal((await pairing.list({ req: typed('grown') }, off)).ok, false);
  assert.equal(await pairing.isPairedPhone(NUMBER, off), null);
  for (const env of [{}, { CREDS_KEY: 'f34be427ebb29de8d88c107a71546019685ed8b241d8f2ed00c3df97ad2566f0' }]) {
    const bare = { ...w.deps, env };
    assert.match((await pairing.makeCode({ req: typed('grown') }, bare)).error, /not set up/);
    assert.equal(await pairing.isPairedPhone(NUMBER, bare), null);
  }
  /* isPairedPhone never throws. */
  assert.equal(await pairing.isPairedPhone(NUMBER, { ...w.deps, phones: { findOne: async () => { throw new Error('db down'); } } }), null);
});

test('digits and numbers are read the way people say them', () => {
  assert.equal(pairing.digitsOf('my pairing code is 4 1 7, 2 0 9'), '417209');
  assert.equal(pairing.digitsOf('four one seven two oh nine'), '417209');
  assert.equal(pairing.digitsOf('417-209'), '417209');
  assert.equal(pairing.normalizeNumber('+15550100123'), '+15550100123');
  assert.equal(pairing.normalizeNumber('555-010-0123'), '+15550100123');
  assert.equal(pairing.normalizeNumber('1 555 010 0123'), '+15550100123');
  assert.equal(pairing.normalizeNumber('12345'), null);
});

test('the tool: OK or FAILED first, short plain description, schema identical to definitions.ts', async () => {
  const KadePhonePairing = require('../../app/clients/tools/structured/KadePhonePairing');
  const tool = new KadePhonePairing({ req: call(null, 'grown') });
  assert.equal(tool.name, 'kade_phone_pairing');
  assert.ok(tool.description.length < 400, 'short, for a cheap model');
  const out = await tool._call({ action: 'code' });
  assert.match(out, /^FAILED: /, 'refused on a phone call, said as FAILED');
  assert.match(await tool._call({ action: 'nope' }), /^Unknown action/);

  const defs = fs.readFileSync(path.join(__dirname, '../../../packages/api/src/tools/registry/definitions.ts'), 'utf8');
  const start = defs.indexOf('export const kadePhonePairingSchema: ExtendedJsonSchema = ');
  assert.ok(start > -1);
  const lit = defs.slice(defs.indexOf('{', start), defs.indexOf('\n};', start) + 2);
  const fromDefs = new Function(`return (${lit});`)();
  assert.deepEqual(fromDefs, tool.schema);
  const entry = defs.slice(defs.indexOf("  kade_phone_pairing: {\r\n") > -1 ? defs.indexOf('  kade_phone_pairing: {\r\n') : defs.indexOf('  kade_phone_pairing: {\n'));
  assert.ok(entry.includes(JSON.stringify(tool.description).slice(1, -1).replace(/\\"/g, '"')), 'same description as the class');
});

test('kade_phone_pairing attaches only on pairing words (keyword only)', async () => {
  const R = require('./kadeToolRetrieval.js');
  assert.equal(R.KEYWORD_ONLY.has('kade_phone_pairing'), true);
  const tools = ['kade_phone_pairing', 'kade_weather', 'kade_help', 'web_search', 'kade_joke'].map((name) => ({ name, description: `${name} does things` }));
  const pick = (text, conversationId) => R.selectTools({ tools, text, agentId: 'a', conversationId, embed: async () => null });
  for (const text of ['pair my phone', 'can you unpair my number', 'my pairing code is 4 1 7 2 0 9', 'which phones are paired', 'unpair', 'pair my cell phone with my account']) {
    R._resetForTests();
    assert.equal((await pick(text, 'c-pair')).keep.has('kade_phone_pairing'), true, text);
  }
  for (const text of ['I had the strangest day at work today, honestly', 'what wine would pair with salmon', 'a pair of shoes', 'call my phone']) {
    R._resetForTests();
    assert.equal((await pick(text, 'c-other')).keep.has('kade_phone_pairing'), false, text);
  }
});
