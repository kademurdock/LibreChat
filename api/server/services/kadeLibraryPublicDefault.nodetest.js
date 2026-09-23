'use strict';
/* node --test api/server/services/kadeLibraryPublicDefault.nodetest.js
 * Kade's uploads become public once; anything she makes private afterwards stays private. */
const test = require('node:test');
const assert = require('node:assert');
const P = require('./kadeLibraryPublicDefault');

const KADE = '6a3cba4d0b0afa92194e42f7';

test('off unless her id and a cutoff are set', () => {
  assert.deepStrictEqual(P.filters({}), []);
  assert.deepStrictEqual(P.filters({ KADE_LIBRARY_PUBLIC_BEFORE: '2026-09-23T19:00:00Z' }), []);
  assert.deepStrictEqual(P.filters({ KADE_LIBRARY_PUBLIC_OWNER: 'kade', KADE_LIBRARY_PUBLIC_BEFORE: '2026-09-23T19:00:00Z' }), []);
  assert.deepStrictEqual(P.filters({ KADE_LIBRARY_PUBLIC_OWNER: KADE, KADE_LIBRARY_PUBLIC_BEFORE: 'soon' }), []);
});

test('only her private, ready, never-shared-by-this items before the cutoff', () => {
  const [q] = P.filters({ KADE_LIBRARY_PUBLIC_OWNER: KADE, KADE_LIBRARY_PUBLIC_BEFORE: '2026-09-23T19:00:00Z' });
  assert.strictEqual(q.owner, KADE);
  assert.strictEqual(q.shared, false);
  assert.strictEqual(q.state, 'ready');
  assert.deepStrictEqual(q['meta.publicByDefault'], { $exists: false }, 'what she makes private later is never re-shared');
  assert.strictEqual(q.createdAt.$lt.toISOString(), '2026-09-23T19:00:00.000Z');
  assert.ok(!('originalPath' in q));
});

test('the second switch reaches only Archive workflow uploads', () => {
  const list = P.filters({ KADE_LIBRARY_PUBLIC_OWNER: KADE, KADE_LIBRARY_PUBLIC_TUBEVAULT_BEFORE: '2026-09-24T02:00:00Z' });
  assert.strictEqual(list.length, 1);
  assert.ok(list[0].originalPath.test('tubevault-intake/abc.mp4'));
  assert.ok(!list[0].originalPath.test('Video/Commercials/x.mp4'));
});

test('shares, marks and counts; does nothing when off', async () => {
  const calls = [];
  const Model = {
    updateMany: async (q, u) => { calls.push([q, u]); return { modifiedCount: u.$set.shared ? 3 : 0 }; },
    find: () => ({ limit: () => ({ lean: async () => [{ title: 'Chaos Reigning' }] }) }),
  };
  const said = [];
  const log = { info: (m) => said.push(m) };
  const r = await P.shareOnce({ env: { KADE_LIBRARY_PUBLIC_OWNER: KADE, KADE_LIBRARY_PUBLIC_BEFORE: '2026-09-23T19:00:00Z' }, Model, log });
  assert.deepStrictEqual(r, { shared: 3 });
  const [q, u] = calls[1];
  assert.strictEqual(u.$set.shared, true);
  assert.ok(u.$set['meta.publicByDefault'] instanceof Date);
  assert.ok(u.$set.sharedAt instanceof Date);
  assert.ok(!('path' in u.$set) && !('grownUpsOnly' in u.$set), 'nothing moved, grown-ups-only untouched');
  assert.strictEqual(q.shared, false);
  assert.match(said[0], /shared 3 of her private uploads; e\.g\. Chaos Reigning/);
  assert.strictEqual(await P.shareOnce({ env: {}, Model, log }), null);
});
