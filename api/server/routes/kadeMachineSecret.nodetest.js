'use strict';
/* Nov 10 2026: the bridge-secret check of the approvals and soul routes must answer false, never
 * throw, whatever the header holds. Run: node --test api/server/routes/kadeMachineSecret.nodetest.js
 * The real `machine` function is cut out of each route file; no server, no database. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

function machineOf(file, secret) {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const start = source.indexOf('function machine(req) {');
  const end = source.indexOf('\n}\n', start) + 3;
  assert.ok(start > 0 && end > start, `${file} has machine(req)`);
  const context = vm.createContext({ crypto, Buffer, String, process: { env: { BRIDGE_SECRET: secret } } });
  vm.runInContext(`${source.slice(start, end)}\nthis.machine = machine;`, context);
  return (header) => context.machine({ get: (name) => (name === 'x-kade-secret' ? header : undefined) });
}

const SECRET = 'bridge-secret-0123456789';
for (const file of ['kadeApprovals.js', 'kadeSoul.js']) {
  test(`${file}: the right secret passes, everything else is refused without throwing`, () => {
    const machine = machineOf(file, SECRET);
    assert.equal(machine(SECRET), true);
    assert.equal(machine(SECRET.slice(0, -1) + 'x'), false);
    assert.equal(machine(''), false);
    assert.equal(machine(undefined), false);
    assert.equal(machine(SECRET + 'x'), false);
    // As long as the secret in characters, longer in bytes: this threw RangeError before the fix.
    const accented = 'é'.repeat(SECRET.length);
    assert.equal(accented.length, SECRET.length);
    assert.doesNotThrow(() => machine(accented));
    assert.equal(machine(accented), false);
    assert.equal(machine(SECRET.slice(0, -1) + 'é'), false);
  });
  test(`${file}: with no secret set nothing passes, an empty header included`, () => {
    const machine = machineOf(file, '');
    assert.equal(machine(''), false);
    assert.equal(machine(undefined), false);
    assert.equal(machine('anything'), false);
  });
}
