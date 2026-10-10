import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCallPresentation,
  characterAudioIdentity,
  authoredCallIdentity,
  outputLevel,
} from './call-presentation.mjs';
import { ANGEL_ID, KIANA_ID } from './portrait-rig.mjs';

const identity = (id = ANGEL_ID) =>
  characterAudioIdentity({
    type: 'character-audio',
    version: 1,
    speakerId: id,
    speech: true,
    expression: 'tender',
    moment: null,
  });
const sample = (controller, extra = {}) =>
  controller.pose({
    id: ANGEL_ID,
    time: 11,
    level: 0.2,
    enabled: true,
    visible: true,
    reducedMotion: false,
    running: true,
    status: 'speaking',
    live: false,
    ...extra,
  });

test('only valid adjacent version-one speaker metadata identifies speech', () => {
  assert.equal(identity().speakerId, ANGEL_ID);
  for (const value of [
    null,
    {},
    { type: 'character-audio', version: 2, speech: true, speakerId: ANGEL_ID },
    { type: 'character-audio', version: 1, speech: true, speakerId: 'Angel' },
    { type: 'character-audio', version: 1, speakerId: ANGEL_ID },
  ])
    assert.equal(characterAudioIdentity(value), null);
});

test('future clips wait for their real context start; early server listening cannot cut off a rendered tail', () => {
  const controller = createCallPresentation();
  controller.schedule(controller.token(), 10, 3, identity());
  assert.equal(sample(controller, { time: 9 }).mouth, 0);
  const tail = sample(controller, { time: 12, status: 'listening' });
  assert.ok(tail.active && tail.mouth > 0);
  assert.equal(tail.expression, 'tender');
  assert.equal(sample(controller, { time: 13 }).mouth, 0);
});

test('a switched speaker owns presentation at playback time and stale completions cannot remove it', () => {
  const controller = createCallPresentation();
  const first = controller.schedule(controller.token(), 10, 1, identity());
  controller.schedule(controller.token(), 11, 2, identity(KIANA_ID));
  assert.ok(sample(controller, { time: 10.5 }).mouth > 0);
  assert.equal(sample(controller).active, false);
  assert.ok(sample(controller, { id: KIANA_ID }).mouth > 0);
  controller.finish(first);
  assert.equal(controller.current(11.5).identity.speakerId, KIANA_ID);
});

test('barge-in, clear and new calls invalidate queued and still-decoding old clips', () => {
  const controller = createCallPresentation(),
    old = controller.token();
  controller.schedule(old, 10, 3, identity());
  controller.clear();
  assert.equal(controller.schedule(old, 11, 3, identity()), null);
  assert.equal(sample(controller).mouth, 0);
  assert.notEqual(controller.schedule(controller.token(), 10, 3, identity()), null);
});

test('queued speaker metadata cannot be changed by later caller mutation', () => {
  const controller = createCallPresentation();
  const observed = identity();
  controller.schedule(controller.token(), 10, 3, observed);
  observed.speakerId = KIANA_ID;
  observed.speech = false;
  assert.ok(sample(controller).mouth > 0);
  assert.equal(controller.current(11).identity.speakerId, ANGEL_ID);
  assert.throws(() => { controller.current(11).identity.speakerId = KIANA_ID; }, TypeError);
});

test('silence, game sounds, missing metadata, Spotter, suspended contexts and motion policy cannot produce a speech mouth', () => {
  for (const meta of [null, { ...identity(), speech: false }]) {
    const controller = createCallPresentation();
    controller.schedule(controller.token(), 10, 3, meta);
    assert.equal(sample(controller).mouth, 0);
    assert.equal(sample(controller).active, false);
  }
  const controller = createCallPresentation();
  controller.schedule(controller.token(), 10, 3, identity());
  for (const policy of [
    { enabled: false },
    { visible: false },
    { reducedMotion: true },
    { running: false },
    { live: true },
  ]) {
    const pose = sample(controller, policy);
    assert.equal(pose.active, false);
    assert.equal(pose.mouth, 0);
  }
  assert.equal(sample(controller, { level: 0 }).mouth, 0);
  assert.equal(sample(controller, { level: NaN }).mouth, 0);
});

test('bounded queue rejects overlapping clips and carries only authored opening directions', () => {
  const controller = createCallPresentation();
  assert.equal(controller.schedule(controller.token(), 10, 121, identity()), null);
  controller.schedule(controller.token(), 10, 3, identity());
  assert.equal(controller.schedule(controller.token(), 12, 3, identity()), null);
  assert.deepEqual(authoredCallIdentity(ANGEL_ID, '%%%tender%%% Hello %%%angry%%% later'), {
    speakerId: ANGEL_ID,
    speech: true,
    expression: 'tender',
    moment: null,
  });
  assert.equal(authoredCallIdentity(ANGEL_ID, 'Hello %%%angry%%% later').expression, 'neutral');
  assert.equal(authoredCallIdentity(ANGEL_ID, '%%%laugh%%% Hello').moment, 'amused');
});

test('real output RMS retains energy and zero crossings without classifying transcript text', () => {
  assert.deepEqual(outputLevel(new Float32Array(256)), { level: 0, sibilance: 0 });
  const level = outputLevel(Float32Array.from([0.2, -0.2, 0.2, -0.2]));
  assert.ok(Math.abs(level.level - 0.2) < 1e-6);
  assert.equal(level.sibilance, 0.75);
});
