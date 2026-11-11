import test from 'node:test';
import assert from 'node:assert/strict';
import {
  expressionSchedule,
  syllableLevel,
  textSeed,
  voiceMessagePose,
} from './voice-message-motion.mjs';

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

// Nov 11 2026: Inworld's own mouth shapes and word times (timing-track.mjs).
const track = {
  v: 1,
  src: 'inworld',
  set: 'oxr',
  dur: 1500,
  vis: [
    [0, 80, 'sil'],
    [80, 200, 'ou'],
    [200, 330, 'E'],
    [330, 420, 'nn'],
    [420, 470, 'sil'],
    [470, 480, 'PP'],
    [480, 640, 'aa'],
    [640, 700, 'kk'],
    [700, 860, 'oh'],
    [860, 900, 'SS'],
    [900, 1100, 'FF'],
    [1100, 1200, 'ih'],
    [1200, 1400, 'sil'],
  ],
  w: [
    [80, 420, 'Well'],
    [470, 700, 'back'],
    [700, 900, 'home'],
    [900, 1200, '[laugh]'],
  ],
  cov: [[0, 1400]],
};
const frames = (extra, seconds = 1.6) => {
  let out = '';
  for (let t = 0; t < seconds; t += 1 / 24) {
    const p = voiceMessagePose({
      id: 'agent_pin',
      time: t,
      level: 0.12,
      active: true,
      cues: [],
      ...extra,
    });
    out += p.viseme + (p.visemeSource === 'track' ? '' : '*');
  }
  return out;
};

test('with a track, the mouth panel per 24 fps frame is a fixed sequence (* = loudness fallback)', () => {
  // closed, pursed oo, spread ee, slightly open, the 10 ms PP pressed, loud aa wide open, oh round,
  // FF teeth, then past the covered stretch the loudness method takes over
  assert.equal(frames({ track }), '0444555111668882333377777755000002*2*2*2*8*8*');
});

test('with no track the pose is exactly what it was before tracks existed', () => {
  // Pinned from the commit before timings (fd6c900b7), same inputs.
  const seed = textSeed('pin');
  let s = '';
  for (let t = 0; t < 4; t += 1 / 24) {
    const p = voiceMessagePose({
      id: 'agent_pin',
      time: t,
      level: syllableLevel(t, seed),
      sibilance: (t * 7) % 0.5,
      active: true,
      cues: [],
    });
    s += p.viseme;
    assert.equal(p.visemeSource, 'loudness');
  }
  assert.equal(
    s,
    '0332722472232000042275883123273277747557575570724747404274000000188874788827023375885217477122777',
  );
  assert.deepEqual(
    expressionSchedule('%%%warm%%% Well, I finally got the garden. %%%laughing%%% It was fun.', 3),
    [
      { at: 0, expression: 'warm', kind: 'direction' },
      { at: 2.13, expression: 'amused', kind: 'direction' },
    ],
  );
});

test('a direction lands on its anchored word, and a [laugh] the voice made is an amused moment', () => {
  const text = 'Well back %%%warm%%% home again, and then a good many more words.';
  const cues = expressionSchedule(text, 1.5, track);
  const warm = cues.find((c) => c.expression === 'warm');
  // "home" starts at 700 ms; cues lead the voice by 0.12 s
  assert.ok(Math.abs(warm.at + 0.12 - 0.7) <= 0.05, `warm at ${warm.at}`);
  const laugh = cues.find((c) => c.kind === 'moment');
  assert.deepEqual(laugh, { at: 0.78, expression: 'amused', kind: 'moment' });
  assert.ok(
    cues.every((c, i) => i === 0 || c.at >= cues[i - 1].at),
    'in time order',
  );
  // without the track the same direction sits at its share of the text instead
  const plain = expressionSchedule(text, 1.5);
  assert.equal(plain.length, 1);
  assert.ok(Math.abs(plain[0].at - (10 / 54) * 1.5 + 0.12) < 0.01, `proportional ${plain[0].at}`);
});

test('a written laugh near the heard one is not repeated', () => {
  const cues = expressionSchedule('Well back home %%%laugh%%% again.', 1.5, track);
  assert.equal(cues.filter((c) => c.expression === 'amused').length, 1);
});
