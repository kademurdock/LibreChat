/* The voice lane's caller lookup marks a failed lookup, so tools and the
 * waiting-notes pickup can fail closed instead of acting as Kade (Sep 24 2026).
 * Run: node --test api/server/services/kadeOnBehalfOf.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load(findOne) {
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
