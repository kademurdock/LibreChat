import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create, envelope } = (await import('./character-motion.mjs')).default;
const ready = (id = 'kiana') => {
  const c = create({ id, rigReady: true });
  c.preferences({ enabled: true });
  return c;
};
const loud = { levels: new Float32Array(100).fill(0.2), step: 0.02 };

test('optional animation starts off and requires a prepared rig', () => {
  const c = create({ id: 'portrait-only' });
  c.listen(0);
  assert.equal(c.sample(3).active, false);
  c.preferences({ enabled: true });
  assert.equal(c.sample(3).active, false);
});

test('Kiana and Lilly use the same engine with separate gesture settings', () => {
  for (const [id, tilt] of [['kiana', 3], ['lilly', 1]]) {
    const c = create({ id, rigReady: true, tiltDegrees: tilt });
    c.preferences({ enabled: true }); c.listen(0);
    assert.equal(c.sample(3).characterId, id);
    assert.ok(Math.abs(c.sample(3).tilt) <= tilt);
    assert.ok(c.sample(6.9).nod > 0);
  }
});

test('mouth follows scheduled audio, including silence, rather than server speaking status', () => {
  const c = ready(); const token = c.speak(0);
  c.schedule(token, { start: 5, duration: 1, envelope: loud });
  assert.equal(c.sample(4.9).mouth, 0);
  assert.ok(c.sample(5.1).mouth > 0);
  assert.equal(c.sample(6).mouth, 0);
});

test('silence and non-speech cues cannot animate a talking mouth', () => {
  const c = ready(); const token = c.speak(0);
  c.schedule(token, { start: 0, duration: 1, envelope: loud, speech: false });
  c.schedule(token, { start: 1, duration: 1 });
  assert.equal(c.sample(0.5).mouth, 0);
  assert.equal(c.sample(1.5).mouth, 0);
});

test('directions activate at audio time and persist through queued segments', () => {
  const c = ready(); const token = c.speak(0);
  c.schedule(token, { start: 4, duration: 2, cues: [{ at: 0, tag: 'warm' }, { at: 1, tag: 'gasp' }] });
  c.schedule(token, { start: 6, duration: 1 });
  assert.equal(c.sample(3).expression, 'neutral');
  assert.equal(c.sample(4.1).expression, 'warm');
  assert.equal(c.sample(5.1).expression, 'surprised');
  assert.equal(c.sample(5.8).expression, 'warm');
  assert.equal(c.sample(6.4).expression, 'warm');
});

test('resume after a hidden tab catches up directions without replaying old reactions', () => {
  const c = ready(); const token = c.speak(0);
  c.schedule(token, { start: 0, duration: 2, cues: [{ at: 0, tag: 'warm' }, { at: 1, tag: 'gasp' }] });
  c.schedule(token, { start: 2, duration: 2, cues: [{ at: 0, tag: 'serious' }] });
  c.preferences({ visible: false });
  assert.equal(c.sample(1.2).needsFrame, false);
  c.preferences({ visible: true });
  assert.equal(c.sample(3).expression, 'serious');
});

test('interrupt invalidates pending audio callbacks and closes mouth immediately', () => {
  const c = ready(); const old = c.speak(0);
  c.schedule(old, { start: 0, duration: 2, envelope: loud });
  assert.ok(c.sample(0.3).mouth > 0);
  c.interrupt(old);
  assert.equal(c.sample(0.4).mouth, 0);
  assert.equal(c.sample(0.4).needsFrame, false);
  const fresh = c.listen(0.4);
  assert.notEqual(fresh, old);
  assert.equal(c.finish(old), false);
  assert.equal(c.schedule(old, { start: 1, duration: 1 }), false);
  assert.equal(c.sample(1).mode, 'listening');
});

test('selecting another character rejects previous-speaker events', () => {
  const c = ready(); const old = c.speak(0);
  c.select({ id: 'lilly', rigReady: true });
  const fresh = c.speak(0);
  assert.equal(c.schedule(old, { start: 0, duration: 1 }), false);
  assert.equal(c.interrupt(old), false);
  assert.equal(c.schedule(fresh, { start: 0, duration: 1 }), true);
  assert.equal(c.sample(0.5).characterId, 'lilly');
});

test('off, reduced motion, and hidden freeze all decorative motion without ending audio state', () => {
  for (const change of [{ enabled: false }, { reducedMotion: true }, { visible: false }]) {
    const c = ready(); const token = c.speak(0);
    c.schedule(token, { start: 0, duration: 2, envelope: loud });
    c.preferences(change);
    const f = c.sample(0.5);
    assert.equal(f.mode, 'speaking'); assert.equal(f.mouth, 0);
    assert.equal(f.blink, 0); assert.equal(f.tilt, 0); assert.equal(f.needsFrame, false);
  }
});

test('overlapping audio, unordered cues, missing times, and unbounded queues are rejected', () => {
  const c = ready(); const token = c.speak(0);
  assert.throws(() => c.schedule(token, { duration: 1 }), /schedule/);
  assert.throws(() => c.schedule(token, { start: 0, duration: 1, cues: [{ offset: 0, tag: 'warm' }] }), /audio-relative/);
  assert.throws(() => c.schedule(token, { start: 0, duration: 1, cues: [{ at: 0.8, tag: 'warm' }, { at: 0.2, tag: 'sad' }] }), /audio-relative/);
  c.schedule(token, { start: 0, duration: 1 });
  assert.throws(() => c.schedule(token, { start: 0.5, duration: 1 }), /Overlapping/);
  for (let i = 1; i < 64; i++) c.schedule(token, { start: i, duration: 1 });
  assert.throws(() => c.schedule(token, { start: 64, duration: 1 }), /queue full/);
});

test('caller mutation cannot alter queued cues or envelope', () => {
  const c = ready(); const token = c.speak(0);
  const cues = [{ at: 0, tag: 'warm' }]; const amp = { levels: new Float32Array([0.2]), step: 1 };
  c.schedule(token, { start: 0, duration: 1, cues, envelope: amp });
  cues[0].tag = 'serious'; amp.levels[0] = 0;
  assert.equal(c.sample(0.2).expression, 'warm'); assert.ok(c.sample(0.2).mouth > 0);
});

test('audio envelope keeps stereo energy and closes over silent windows', () => {
  const a = new Float32Array(320); a.fill(0.25, 0, 160);
  const b = Float32Array.from(a, x => -x);
  const result = envelope({ duration: 0.04, length: 320, sampleRate: 8000, numberOfChannels: 2, getChannelData: i => i ? b : a });
  assert.equal(result.levels[0], 0.25); assert.equal(result.levels[1], 0);
  assert.equal(a[0], 0.25); assert.equal(b[0], -0.25);
  assert.throws(() => envelope({ duration: Infinity }), /Unsupported/);
});

test('stale sample timestamps do not replay old directions', () => {
  const c = ready(); const token = c.speak(0);
  c.schedule(token, { start: 0, duration: 3, cues: [{ at: 0, tag: 'warm' }, { at: 2, tag: 'serious' }] });
  assert.equal(c.sample(2.5).expression, 'serious');
  assert.equal(c.sample(0.5).expression, 'serious');
});

test('dispose drops queued work and prevents stale events', () => {
  const c = ready(); const token = c.speak(0); c.dispose();
  assert.equal(c.schedule(token, { start: 0, duration: 1 }), false);
  assert.equal(c.sample(1).needsFrame, false);
});

test('ending or interrupting during a blink returns an open-eyed resting face', () => {
  for (const operation of ['finish', 'interrupt']) {
    const c = ready(); const token = c.speak(0);
    assert.ok(c.sample(4.6).blink > 0.9);
    c[operation](token);
    const resting = c.sample(4.6);
    assert.equal(resting.blink, 0); assert.equal(resting.nod, 0);
    assert.equal(resting.tilt, 0); assert.equal(resting.needsFrame, false);
  }
});
