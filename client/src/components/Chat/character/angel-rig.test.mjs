import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  ANGEL_FACES,
  ANGEL_STILL_ORNAMENTS,
  angelFace,
  angelFacial,
  angelMouth,
  angelOrnaments,
} from './angel-motion.mjs';
import {
  ANGEL_ID,
  ANGEL_PORTRAIT_FILE,
  ANGEL_SOURCE_SHA256,
  validAngelArt,
  createAngelRig,
} from './angel-rig.mjs';
import { preparedPortrait, KIANA_ID, KIANA_PORTRAIT_FILE } from './portrait-rig.mjs';
import { voiceMessagePose } from './voice-message-motion.mjs';
import AvatarExpression from './avatar-expression.mjs';

const masterBytes = readFileSync(new URL('./angel-vector.json', import.meta.url));
const master = JSON.parse(masterBytes);

test('Angel uses the identical original 149-shape native vector master and an exact public identity pair', () => {
  assert.equal(createHash('sha256').update(masterBytes).digest('hex'), ANGEL_SOURCE_SHA256);
  assert.equal(master.shapes.length, 149);
  assert.equal(validAngelArt(master), true);
  assert.equal(
    preparedPortrait(ANGEL_ID, `https://example.com/uploads/${ANGEL_PORTRAIT_FILE}?signed=1`)
      .vector,
    'angel',
  );
  for (const [id, path] of [
    [KIANA_ID, ANGEL_PORTRAIT_FILE],
    [ANGEL_ID, KIANA_PORTRAIT_FILE],
    [ANGEL_ID, ANGEL_PORTRAIT_FILE + '.replacement'],
    ['agent_angel', ANGEL_PORTRAIT_FILE],
  ])
    assert.equal(preparedPortrait(id, path), null);
});

test('invalid art falls back instead of drawing partial geometry or arbitrary path commands', () => {
  for (const mutate of [
    (a) => {
      a.shapes[0].path[0].op = 'eval';
    },
    (a) => {
      a.shapes[0].path[0].v[0] = Infinity;
    },
    (a) => {
      a.shapes[0].id = a.shapes[1].id;
    },
    (a) => {
      a.shapes[0].opacity = 2;
    },
    (a) => {
      a.shapes[0].fill = 'url(https://example.com)';
    },
    (a) => {
      a.pivots.head = [1];
    },
    (a) => {
      a.features.eyes[0].irisRadius = 80;
    },
    (a) => {
      a.gradients.skin.stops[1].at = -1;
    },
  ]) {
    const changed = structuredClone(master);
    mutate(changed);
    assert.equal(validAngelArt(changed), false);
  }
});

test('all seventeen faces have one distinct geometry; eyelids close continuously without image crossfades', () => {
  assert.equal(ANGEL_FACES.length, 17);
  assert.equal(
    new Set(ANGEL_FACES.map((face) => JSON.stringify(angelFacial(face, 0, true)))).size,
    17,
  );
  for (const face of ANGEL_FACES) {
    let previous = Infinity;
    for (let step = 0; step <= 100; step++) {
      const pose = angelFacial(face, step / 100, true);
      assert.ok(Object.values(pose).every(Number.isFinite));
      assert.ok(pose.leftEye <= previous && pose.leftEye >= 0 && pose.rightEye >= 0);
      previous = pose.leftEye;
    }
    assert.equal(angelFacial(face, 1, true).leftEye, 0);
    assert.equal(angelFacial(face, 1, true).rightEye, 0);
    assert.deepEqual(angelFacial(face, 1, false), angelFacial('neutral', 0, true));
  }
});

test('every existing authored delivery direction selects Angel geometry, including her own laugh and nuance faces', () => {
  const faces = new Set();
  for (const expression of AvatarExpression.expressions) {
    const pose = voiceMessagePose({
      id: ANGEL_ID,
      time: 4,
      level: 0.2,
      active: true,
      cues: [{ at: 0, expression, kind: 'direction' }],
    });
    assert.equal(pose.time, 4);
    faces.add(angelFace(pose));
    assert.ok(ANGEL_FACES.includes(angelFace(pose)));
  }
  assert.ok(faces.size >= 14);
  const laugh = voiceMessagePose({
    id: ANGEL_ID,
    time: 0.4,
    level: 0,
    active: true,
    cues: [{ at: 0, expression: 'amused', kind: 'moment' }],
  });
  assert.equal(angelFace(laugh), 'laugh');
  assert.equal(angelMouth(8, 1, 'laugh', true).aperture, 0.78);
  assert.equal(angelFace({ ...laugh, active: false }), 'neutral');
});

test('nine mouth roles remain bounded; silent, invalid and disabled speech has no talking mouth', () => {
  const mouths = new Set();
  for (let role = 0; role <= 8; role++) {
    const pose = angelMouth(role, 0.8, 'neutral', true);
    assert.ok(Object.values(pose).every(Number.isFinite));
    assert.ok(pose.aperture >= 0 && pose.aperture <= 1);
    mouths.add(JSON.stringify(pose));
    assert.equal(angelMouth(role, 1, 'neutral', false).aperture, 0);
    assert.equal(angelMouth(role, 0, 'neutral', true).aperture, 0);
    assert.equal(angelMouth(role, NaN, 'neutral', true).aperture, 0);
  }
  assert.equal(mouths.size, 9);
  for (const role of [-1, 9, 1.5, NaN])
    assert.equal(angelMouth(role, 1, 'neutral', true).aperture, 0);
});

test('wings, halo and stable jewels share the audio clock and stay inside reviewed native limits', () => {
  for (let frame = 0; frame < 60 * 24; frame++) {
    const time = frame / 24,
      pose = angelOrnaments(time, true, 'warm');
    assert.ok(Math.abs(pose.leftWingDegrees) <= 1.8 && Math.abs(pose.rightWingDegrees) <= 1.8);
    assert.ok(Math.abs(pose.haloOffsetY) <= 0.003 && Math.abs(pose.haloDegrees) <= 0.35);
    assert.ok(pose.sparkle >= 0.21 && pose.sparkle <= 0.51);
    assert.deepEqual(angelOrnaments(time, false, 'warm'), ANGEL_STILL_ORNAMENTS);
  }
  for (const time of [-1, NaN, Infinity])
    assert.deepEqual(angelOrnaments(time, true, 'warm'), ANGEL_STILL_ORNAMENTS);
  assert.ok(Object.values(angelOrnaments(Number.MAX_VALUE, true, 'warm')).every(Number.isFinite));
  const quiet = angelOrnaments(2, true, 'sad'),
    bright = angelOrnaments(2, true, 'warm');
  assert.ok(Math.abs(quiet.leftWingDegrees) < Math.abs(bright.leftWingDegrees));
});

test('unsupported Canvas leaves the static avatar visible', () => {
  const canvas = { hidden: false, width: 0, height: 0, getContext: () => null, setAttribute() {} };
  const visible = [],
    failed = [];
  const rig = createAngelRig(canvas, {
    id: ANGEL_ID,
    onFailure: () => failed.push(true),
    onVisibilityChange: (value) => visible.push(value),
  });
  rig.render({ characterId: ANGEL_ID, active: true });
  assert.equal(canvas.hidden, true);
  assert.equal(failed.length, 1);
  assert.equal(visible.at(-1), false);
  rig.dispose();
  assert.equal(visible.at(-1), false);
});
