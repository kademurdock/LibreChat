import test from 'node:test';
import assert from 'node:assert/strict';
import {
  preparedPortrait,
  KIANA_ID,
  KIANA_PORTRAIT_FILE,
  DELLA_ID,
  DELLA_PORTRAIT_FILE,
  facialBlend,
} from './portrait-rig.mjs';
test('Della and Kiana have separate registered facial regions and exact artwork ownership', () => {
  const k = preparedPortrait(KIANA_ID, 'https://example.com/' + KIANA_PORTRAIT_FILE);
  const d = preparedPortrait(
    DELLA_ID,
    'https://example.com/' + DELLA_PORTRAIT_FILE + '?signed=example',
  );
  assert.ok(k && d);
  assert.notEqual(k.portrait, d.portrait);
  assert.equal(d.features[0].to[0], 0.4);
  assert.equal(preparedPortrait(DELLA_ID, '/' + KIANA_PORTRAIT_FILE), null);
  assert.equal(preparedPortrait(DELLA_ID, '/changed.png'), null);
  assert.equal(preparedPortrait('unknown', '/' + DELLA_PORTRAIT_FILE), null);
});
test('mouth and eyelids have bounded graduated poses instead of on/off jumps', () => {
  assert.equal(facialBlend(0), 0);
  assert.equal(facialBlend(1), 1);
  assert.equal(facialBlend(NaN), 0);
  assert.equal(facialBlend(-1), 0);
  const values = Array.from({ length: 101 }, (_, i) => facialBlend(i / 100));
  assert.ok(new Set(values).size > 10);
  assert.ok(values.every((v, i) => i === 0 || v >= values[i - 1]));
});
