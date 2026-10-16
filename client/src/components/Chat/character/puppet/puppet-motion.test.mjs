import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMotion, CHANNELS, EXPRESSIONS, hashSeed } from './puppet-motion.mjs';

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
