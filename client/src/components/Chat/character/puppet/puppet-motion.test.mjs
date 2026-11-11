import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMotion, CHANNELS, EXPRESSIONS, hashSeed, TRACK_SHAPES } from './puppet-motion.mjs';

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/motion-golden.json', import.meta.url), 'utf8'),
);

test('the motion fixture is the one this engine is held to', () => {
  assert.equal(golden.schema, 'kade-puppet-motion-golden/1');
  assert.equal(golden.tolerance, 1e-6);
  assert.equal(golden.runs.length, 3);
});

for (const run of golden.runs) {
  test(`motion run seed ${run.seed} (${run.options.energy}) reproduces every checkpoint`, () => {
    const motion = createMotion({ seed: run.seed, ...run.options });
    const byFrame = new Map(run.checkpoints.map((c) => [c.frame, c.channels]));
    let checked = 0;
    run.script.forEach((step, frame) => {
      if (step.event) motion.setExpression(step.event[1], step.event[2], step.event[3]);
      const out = motion.update(step.dt, {
        speaking: step.speaking,
        level: step.level,
        listening: step.listening,
        reduceMotion: step.reduceMotion,
      });
      const expected = byFrame.get(frame);
      if (!expected) return;
      for (const channel of CHANNELS) {
        const diff = Math.abs(out[channel] - expected[channel]);
        assert.ok(
          diff <= golden.tolerance,
          `frame ${frame} ${channel}: ${out[channel]} vs ${expected[channel]}`,
        );
      }
      checked++;
    });
    assert.equal(checked, run.checkpoints.length);
  });
}

test('the engine is frame-rate independent enough that 60 fps tracks 30 fps', () => {
  const a = createMotion({ seed: 9 });
  const b = createMotion({ seed: 9 });
  let outA, outB;
  for (let i = 0; i < 30; i++) outA = { ...a.update(1 / 30, {}) };
  for (let i = 0; i < 60; i++) outB = { ...b.update(1 / 60, {}) };
  assert.ok(Math.abs(outA['body.breath'] - outB['body.breath']) < 1e-9);
});

test('reduced motion stops breathing, drift and the physics channels', () => {
  const m = createMotion({ seed: 3 });
  let out;
  for (let i = 0; i < 90; i++) out = m.update(1 / 30, { reduceMotion: true });
  assert.equal(out['body.breath'], 0);
  assert.equal(out['hair.swing'], 0);
  assert.equal(out['extras.flap'], 0);
  assert.equal(out['extras.float'], 0);
});

test('expressions name only real channels and seeds are stable', () => {
  for (const [name, targets] of Object.entries(EXPRESSIONS))
    for (const channel of Object.keys(targets))
      assert.ok(CHANNELS.includes(channel), `${name}: ${channel}`);
  assert.equal(hashSeed('agent_x'), hashSeed('agent_x'));
  assert.notEqual(hashSeed('agent_x'), hashSeed('agent_y'));
});

// Nov 11 2026: real mouth shapes (timing-track.mjs) instead of a random pick per syllable.
test('with track visemes the mouth follows the panel, re-picked when the panel changes', () => {
  const run = (visemes) => {
    const m = createMotion({ seed: 7 });
    const seen = [];
    for (const [panel, frames] of visemes)
      for (let i = 0; i < frames; i++) {
        const out = m.update(1 / 24, {
          speaking: true,
          level: 0.5,
          viseme: panel,
          visemeSource: 'track',
        });
        seen.push({
          panel,
          round: out['mouth.round'],
          wide: out['mouth.wide'],
          press: out['mouth.press'],
        });
      }
    return seen;
  };
  const seen = run([
    [3, 8],
    [5, 8],
    [6, 8],
  ]);
  const last = (panel) => seen.filter((s) => s.panel === panel).at(-1);
  assert.ok(last(3).round > 0.3 && last(3).round > last(3).wide, 'round "oh"');
  assert.ok(last(5).wide > 0.3 && last(5).wide > last(5).round, 'spread "ee"');
  assert.ok(last(6).press > 0.25, 'pressed');
  // the same input gives the same motion
  assert.deepEqual(run([[4, 6]]), run([[4, 6]]));
  assert.equal(TRACK_SHAPES.length, 9);
});
