import test from 'node:test';
import assert from 'node:assert/strict';
import { syllableLevel, textSeed, voiceMessagePose } from './voice-message-motion.mjs';

const seed = textSeed('a-message-id');
const sample = (s, seconds, step = 0.01) =>
  Array.from({ length: Math.round(seconds / step) }, (_, i) => syllableLevel(i * step, s));

test('the stand-in syllable envelope is deterministic per message and differs between messages', () => {
  assert.deepEqual(sample(seed, 3), sample(seed, 3));
  assert.notDeepEqual(sample(seed, 3), sample(textSeed('another-message'), 3));
  assert.equal(textSeed('x'), textSeed('x'));
});

test('syllables come four to six times a second with varied strength and some gaps', () => {
  for (const s of [seed, textSeed('b'), textSeed('c'), 7]) {
    const levels = sample(s, 30);
    let onsets = 0;
    for (let i = 1; i < levels.length; i++) if (levels[i - 1] <= 0.02 && levels[i] > 0.02) onsets++;
    const rate = onsets / 30;
    // Voiced syllables: 4.2-5.8 a second minus the gaps between words.
    assert.ok(rate >= 3.4 && rate <= 6, `rate ${rate}`);
    const peaks = levels.filter(
      (v, i) => i > 0 && i < levels.length - 1 && v > levels[i - 1] && v >= levels[i + 1],
    );
    assert.ok(Math.max(...peaks) - Math.min(...peaks) > 0.05, 'peaks vary');
    assert.ok(
      levels.some((v) => v === 0),
      'there are gaps',
    );
  }
});

test('the stand-in stays inside envelope units and gives the pose a moving mouth', () => {
  const levels = sample(seed, 20);
  assert.ok(levels.every((v) => v >= 0 && v <= 0.2));
  assert.equal(syllableLevel(-1, seed), 0);
  assert.equal(syllableLevel(NaN, seed), 0);
  const mouths = new Set();
  for (let t = 0; t < 3; t += 0.04)
    mouths.add(
      voiceMessagePose({
        id: 'agent_x',
        time: t,
        level: syllableLevel(t, seed),
        active: true,
        cues: [],
      }).mouth.toFixed(2),
    );
  assert.ok(mouths.size > 10);
  const paused = voiceMessagePose({
    id: 'agent_x',
    time: 1,
    level: syllableLevel(1, seed),
    active: false,
    cues: [],
  });
  assert.equal(paused.mouth, 0);
});
