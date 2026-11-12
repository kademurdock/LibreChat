/* Nov 11 2026 (home agent plan, card 5): account types adult, teen, child. A teen gets the child
 * rules everywhere the code used to check for 'child'; an untyped account keeps exactly what it
 * has today; isExplicitAdult is true only on a stored 'adult'.
 *
 * Run: node --test api/server/services/kadeAccountType.nodetest.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const A = require('./kadeAccountType');

test('the helpers', () => {
  assert.deepEqual([...A.ACCOUNT_TYPES], ['adult', 'teen', 'child']);
  assert.equal(A.isChildLike({ kadeAccountType: 'child' }), true);
  assert.equal(A.isChildLike({ kadeAccountType: 'teen' }), true);
  assert.equal(A.isChildLike({ kadeAccountType: 'adult' }), false);
  assert.equal(A.isChildLike({}), false, 'untyped is not child-like (no change for untyped accounts)');
  assert.equal(A.isChildLike(null), false);
  assert.equal(A.isChildLike({ kadeAccountType: 'Child' }), false, 'only the stored values');
  assert.equal(A.isExplicitAdult({ kadeAccountType: 'adult' }), true);
  for (const u of [{}, null, undefined, { role: 'ADMIN' }, { kadeAccountType: 'teen' }, { kadeAccountType: 'child' }, { kadeAccountType: 'ADULT' }, { kadeAccountType: '' }]) {
    assert.equal(A.isExplicitAdult(u), false, JSON.stringify(u));
  }
  assert.equal(A.isTeen({ kadeAccountType: 'teen' }), true);
  assert.equal(A.isChild({ kadeAccountType: 'teen' }), false);
  assert.equal(A.accountTypeOf({ kadeAccountType: 'nonsense' }), null);
});

/* Every child gate in the server now asks isChildLike (the Library joined on Nov 12 2026, audit
 * SEC-5). These files are left on purpose: signup tagging (AuthController.js:
 * a signup code only makes adult or child), the song audience (kadeSongAudience.js: a teen is
 * already not an adult there, so it gets clean songs) and a comment in the MOO. */
const LEFT = new Set([
  'server/controllers/AuthController.js',
  'server/utils/kadeSongAudience.js',
  'app/clients/tools/kademoo/life/index.js',
]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'test' || e.name === '__tests__') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(c|m)?js$/.test(e.name) && !/(test|spec)\./.test(e.name)) out.push(p);
  }
  return out;
}

test('no server child gate is left that a teen would slip past', () => {
  const api = path.join(__dirname, '../..');
  const hits = [];
  for (const file of [...walk(path.join(api, 'server')), ...walk(path.join(api, 'app'))]) {
    const rel = path.relative(api, file).split(path.sep).join('/');
    if (LEFT.has(rel)) continue;
    const src = fs.readFileSync(file, 'utf8');
    if (/kadeAccountType\s*===\s*'child'/.test(src)) hits.push(rel);
  }
  assert.deepEqual(hits, []);
});

test('the admin route takes teen, still behind the admin check', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/kade.js'), 'utf8');
  const at = src.indexOf("router.post('/account-type'");
  assert.ok(at > 0);
  const route = src.slice(at, at + 900);
  assert.match(route, /requireJwtAuth, requireAdminAccess/);
  assert.match(route, /ACCOUNT_TYPES\.includes\(type\)/);
  const schema = fs.readFileSync(path.join(__dirname, '../../../packages/data-schemas/src/schema/user.ts'), 'utf8');
  assert.match(schema, /enum: \['adult', 'teen', 'child'\]/);
});

test('review fix: the audience is the person on the line, not the service seat; nobody known gets no adult rules', () => {
  const { audienceOf, isChildLike } = require('./kadeAccountType');
  const seat = { id: 'seat', role: 'ADMIN' };
  const teen = { id: 't1', role: 'USER', kadeAccountType: 'teen' };
  assert.equal(audienceOf({ user: seat, kadeOnBehalfOf: teen, body: { kadeOnBehalfOf: 't@example.invalid' } }).user, teen);
  assert.equal(isChildLike(audienceOf({ user: seat, kadeOnBehalfOf: teen }).user), true);
  assert.equal(audienceOf({ user: seat, kadeOnBehalfOfUnresolved: true, body: { kadeOnBehalfOf: 'x@example.invalid' } }).user, null);
  assert.equal(audienceOf({ user: seat, kadeVoicePass: 'phone', body: {} }).user, null, 'a call naming nobody');
  assert.equal(audienceOf({ user: seat, body: { text: 'hi' } }).user, seat, 'the owner typing');
  const grown = { id: 'g', role: 'USER', kadeAccountType: 'teen' };
  assert.equal(audienceOf({ user: grown, body: {} }).user, grown, 'a person typing is themselves');
  const build = fs.readFileSync(path.join(__dirname, 'Endpoints/agents/build.js'), 'utf8');
  assert.match(build, /const audience = require\('\.\.\/\.\.\/kadeAccountType'\)\.audienceOf\(req\)\.user;/);
  assert.match(build, /isKadeAdult\(audience\)/);
  const schema = fs.readFileSync(path.join(__dirname, '../../../packages/data-schemas/src/schema/user.ts'), 'utf8');
  const field = schema.slice(schema.indexOf('kadeAccountType: {'), schema.indexOf('kadeAccountType: {') + 200);
  assert.doesNotMatch(field, /default:/, 'no stored default: untyped is never an adult');
});
