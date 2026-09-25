/* The voice lane's caller lookup marks a failed lookup, so tools and the
 * waiting-notes pickup can fail closed instead of acting as Kade (Sep 24 2026).
 * Run: node --test api/server/services/kadeOnBehalfOf.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load(findOne, env = {}) {
  const module = { exports: {} };
  const stubs = {
    mongoose: { models: { User: { findOne: (query) => ({ lean: async () => findOne(query) }) } } },
    'librechat-data-provider': { SystemRoles: { ADMIN: 'ADMIN' } },
    '@librechat/data-schemas': { logger: { info() {}, warn() {} } },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('./kadeOnBehalfOf'), 'utf8'), {
    module,
    require: (name) => stubs[name],
    String,
    process: { env },
  });
  return module.exports.resolveKadeOnBehalfOf;
}

const run = async (resolve, req) => {
  let nexted = false;
  await resolve(req, {}, () => {
    nexted = true;
  });
  assert.equal(nexted, true, 'a voice turn always continues');
  return req;
};

test('a name the lookup cannot find is marked unresolved; a found one is not', async () => {
  const resolve = load((query) =>
    query.email.$in.includes('amber@example.com') ? { _id: 'amber', name: 'Amber', email: 'amber@example.com' } : null,
  );
  const admin = { id: 'kade', role: 'ADMIN' };
  const found = await run(resolve, { user: admin, body: { kadeOnBehalfOf: 'Amber@example.com' } });
  assert.equal(found.kadeOnBehalfOf.id, 'amber');
  assert.equal(found.kadeOnBehalfOfUnresolved, undefined);
  const missing = await run(resolve, { user: admin, body: { kadeOnBehalfOf: 'nobody@example.com' } });
  assert.equal(missing.kadeOnBehalfOf, undefined);
  assert.equal(missing.kadeOnBehalfOfUnresolved, true);
  const plain = await run(resolve, { user: admin, body: {} });
  assert.equal(plain.kadeOnBehalfOfUnresolved, undefined, 'an ordinary chat turn is untouched');
  // A non-admin sending the field is ignored and acts as itself, as before.
  const member = await run(resolve, { user: { id: 'holly', role: 'USER' }, body: { kadeOnBehalfOf: 'nobody@example.com' } });
  assert.equal(member.kadeOnBehalfOfUnresolved, undefined);
});

test('a lookup error is marked unresolved too', async () => {
  const resolve = load(() => {
    throw new Error('database away');
  });
  const req = await run(resolve, { user: { id: 'kade', role: 'ADMIN' }, body: { kadeOnBehalfOf: 'amber@example.com' } });
  assert.equal(req.kadeOnBehalfOfUnresolved, true);
});

/* Part 291: KADE_VOICE_BILL_REAL=1 bills a voice turn to the real caller (req.kadeBillTo). */
const PEOPLE = {
  'amber@example.com': { _id: 'amber', name: 'Amber', email: 'amber@example.com', role: 'USER' },
  'kade@example.com': { _id: 'kade', name: 'Kade', email: 'kade@example.com', role: 'ADMIN' },
  'old@example.com': { _id: 'old', name: 'Old Row', email: 'old@example.com' },
};
const lookup = (query) => query.email.$in.map((e) => PEOPLE[e]).find(Boolean) || null;
const ADMIN_SEAT = { id: 'kade', role: 'ADMIN' };

test('switch off (the default): nobody gets kadeBillTo, the caller is still resolved for tools', async () => {
  for (const env of [{}, { KADE_VOICE_BILL_REAL: '0' }, { KADE_VOICE_BILL_REAL: 'true' }]) {
    const resolve = load(lookup, env);
    const req = await run(resolve, { user: ADMIN_SEAT, body: { kadeOnBehalfOf: 'amber@example.com' } });
    assert.equal(req.kadeOnBehalfOf.id, 'amber');
    assert.equal(req.kadeBillTo, undefined);
  }
});

/** A caller-started call turn, as the proxy's call lane sends it (review F11). */
const callTurn = (email) => ({ kadeOnBehalfOf: email, kadeBillCaller: true });

test('switch on: a family caller is billed; Kade, unknown emails, unlinked callers and member seats are not', async () => {
  const resolve = load(lookup, { KADE_VOICE_BILL_REAL: '1' });
  const family = await run(resolve, { user: ADMIN_SEAT, body: callTurn('Amber@Example.com') });
  assert.equal(family.kadeBillTo, 'amber');
  assert.equal(family.kadeOnBehalfOf.role, 'USER');
  // A row with no role field is an ordinary user.
  const noRole = await run(resolve, { user: ADMIN_SEAT, body: callTurn('old@example.com') });
  assert.equal(noRole.kadeBillTo, 'old');
  // Kade calling herself stays on her own exempt seat.
  const kade = await run(resolve, { user: ADMIN_SEAT, body: callTurn('kade@example.com') });
  assert.equal(kade.kadeOnBehalfOf.id, 'kade');
  assert.equal(kade.kadeBillTo, undefined);
  // An email nobody owns stays on Kade's seat.
  const unknown = await run(resolve, { user: ADMIN_SEAT, body: callTurn('nobody@example.com') });
  assert.equal(unknown.kadeBillTo, undefined);
  assert.equal(unknown.kadeOnBehalfOfUnresolved, true);
  // An unlinked phone caller sends no email at all.
  const unlinked = await run(resolve, { user: ADMIN_SEAT, body: { kadeBillCaller: true } });
  assert.equal(unlinked.kadeBillTo, undefined);
  // A non-admin seat cannot move its bill onto someone else.
  const member = await run(resolve, { user: { id: 'holly', role: 'USER' }, body: callTurn('amber@example.com') });
  assert.equal(member.kadeBillTo, undefined);
  assert.equal(member.kadeOnBehalfOf, undefined);
});

test('switch on: an ask that names a person but is not a caller-started call turn is never billed (F11)', async () => {
  const resolve = load(lookup, { KADE_VOICE_BILL_REAL: '1' });
  // Kiana's friend text, a dry-run preview, a brief, an outbound call: kadeOnBehalfOf, no flag.
  for (const body of [
    { kadeOnBehalfOf: 'amber@example.com' },
    { kadeOnBehalfOf: 'amber@example.com', kadeBillCaller: false },
    // Only the boolean true counts, never a truthy look-alike.
    { kadeOnBehalfOf: 'amber@example.com', kadeBillCaller: 'true' },
    { kadeOnBehalfOf: 'amber@example.com', kadeBillCaller: 1 },
    { kadeOnBehalfOf: 'amber@example.com', billCaller: true },
  ]) {
    const req = await run(resolve, { user: ADMIN_SEAT, body });
    assert.equal(req.kadeOnBehalfOf.id, 'amber', 'tools still act as the person');
    assert.equal(req.kadeBillTo, undefined, JSON.stringify(body));
  }
  // Switch off: even a flagged call turn is not billed.
  const off = await run(load(lookup, {}), { user: ADMIN_SEAT, body: callTurn('amber@example.com') });
  assert.equal(off.kadeBillTo, undefined);
});

test("switch on: a lookup error leaves the turn on Kade's seat", async () => {
  const resolve = load(() => {
    throw new Error('database away');
  }, { KADE_VOICE_BILL_REAL: '1' });
  const req = await run(resolve, { user: ADMIN_SEAT, body: callTurn('amber@example.com') });
  assert.equal(req.kadeBillTo, undefined);
});
