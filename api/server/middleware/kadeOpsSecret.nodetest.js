'use strict';
/* node --test api/server/middleware/kadeOpsSecret.nodetest.js
 * Server-to-server maintenance calls (Sep 25 2026): x-kade-ops-secret must equal KADE_OPS_SECRET,
 * compared in constant time, and nothing passes while the variable is unset or empty; without the
 * header the normal sign-in runs and the admin check decides. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// A stand-in for the JWT sign-in, so the test needs no passport setup.
const jwtPath = path.join(__dirname, 'requireJwtAuth.js');
let signedIn = null;
require.cache[jwtPath] = {
  id: jwtPath,
  filename: jwtPath,
  loaded: true,
  exports: (req, res, next) => {
    if (!signedIn) return res.status(401).json({ error: 'Unauthorized' });
    req.user = signedIn;
    return next();
  },
};
const { hasOpsSecret, opsOrAdmin } = require('./kadeOpsSecret');

const req = (secret) => ({ headers: secret === undefined ? {} : { 'x-kade-ops-secret': secret } });
function run(mw, r) {
  return new Promise((resolve) => {
    const res = { code: 200, status(n) { this.code = n; return this; }, json(body) { resolve({ passed: false, code: this.code, body }); return this; } };
    mw(r, res, (err) => resolve({ passed: !err, err }));
  });
}
function withSecret(value, fn) {
  const before = process.env.KADE_OPS_SECRET;
  if (value === undefined) delete process.env.KADE_OPS_SECRET;
  else process.env.KADE_OPS_SECRET = value;
  const restore = () => {
    if (before === undefined) delete process.env.KADE_OPS_SECRET;
    else process.env.KADE_OPS_SECRET = before;
  };
  return Promise.resolve().then(fn).finally(restore);
}

test('the secret passes only when it is set and matches exactly', async () => {
  await withSecret(undefined, () => assert.equal(hasOpsSecret(req('anything')), false, 'unset: nothing passes'));
  await withSecret('', () => assert.equal(hasOpsSecret(req('')), false, 'empty: nothing passes'));
  await withSecret('correct horse battery staple', () => {
    assert.equal(hasOpsSecret(req('correct horse battery staple')), true);
    assert.equal(hasOpsSecret(req('correct horse battery stapl')), false, 'shorter');
    assert.equal(hasOpsSecret(req('correct horse battery staplf')), false, 'same length, one letter off');
    assert.equal(hasOpsSecret(req(['correct horse battery staple'])), true);
    assert.equal(hasOpsSecret(req()), false, 'no header');
    assert.equal(hasOpsSecret({}), false);
  });
});

test('opsOrAdmin: the secret skips the sign-in without acting as anyone; otherwise an admin sign-in is required', async () => {
  await withSecret('s3cret-value', async () => {
    const mw = opsOrAdmin((r) => !!r.user && r.user.role === 'ADMIN');
    const ops = req('s3cret-value');
    signedIn = null;
    assert.deepEqual(await run(mw, ops), { passed: true, err: undefined });
    assert.equal(ops.kadeOps, true);
    assert.equal(ops.user, undefined, 'no account is borrowed');
    assert.equal((await run(mw, req('wrong-value!'))).code, 401, 'a wrong secret falls back to the sign-in');
    signedIn = { id: 'u1', role: 'USER' };
    assert.equal((await run(mw, req())).code, 403);
    signedIn = { id: 'k', role: 'ADMIN' };
    assert.equal((await run(mw, req())).passed, true);
    signedIn = null;
  });
});
