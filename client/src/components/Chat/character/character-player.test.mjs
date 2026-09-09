import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = (await import('./character-player.mjs')).default;
function harness(render) {
  let next = 0, now = 0; const pending = new Map(); const frames = [];
  const player = create({ character: { id: 'kiana', rigReady: true }, clock: () => now,
    render: render || (f => frames.push(f)), requestFrame: f => { pending.set(++next, f); return next; }, cancelFrame: id => pending.delete(id) });
  return { player, pending, frames, advance(t) { now = t; const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(f => f()); } };
}
test('one frame loop, stopped in background, restarted visibly, disposed cleanly', () => {
  const h = harness(); h.player.preferences({ enabled: true }); h.player.listen();
  assert.equal(h.pending.size, 1); h.advance(1); assert.equal(h.pending.size, 1);
  h.player.preferences({ visible: false }); assert.equal(h.pending.size, 0);
  h.player.preferences({ visible: true }); assert.equal(h.pending.size, 1);
  h.player.preferences({ reducedMotion: true }); assert.equal(h.pending.size, 0);
  h.player.preferences({ reducedMotion: false }); assert.equal(h.pending.size, 1);
  h.player.dispose(); assert.equal(h.pending.size, 0);
  h.player.listen(); assert.equal(h.pending.size, 0);
});
test('animation renderer failure is contained and leaves no active loop', () => {
  const h = harness(() => { throw new Error('missing rig'); });
  assert.doesNotThrow(() => h.player.listen()); assert.equal(h.pending.size, 0);
});
test('malformed animation metadata returns false instead of throwing into audio scheduling', () => {
  const h = harness(); const token = h.player.speak();
  assert.equal(h.player.schedule(token, { duration: 2 }), false);
  assert.equal(h.player.schedule(token, { start: 0, duration: 2 }), true);
});
test('old completion callback cannot end new listening animation', () => {
  const h = harness(); h.player.preferences({ enabled: true }); const old = h.player.speak();
  h.player.listen(); assert.equal(h.player.finish(old), false);
  assert.equal(h.frames.at(-1).mode, 'listening'); assert.equal(h.pending.size, 1);
});
