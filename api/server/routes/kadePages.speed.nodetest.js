'use strict';
/* Oct 30 2026: the Describe page's read-aloud speed says numbers, the same nine as every other
 * voice. Her call: "The brisk and all that, that wasn't original". Slower, Normal, Faster and
 * Fastest were 0.9, 1, 1.2 and 1.4 behind words, and under FISH_SPEED_EXACT those are exact.
 * Run: node --test api/server/routes/kadePages.speed.nodetest.js */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const page = fs.readFileSync(path.join(__dirname, 'kadePages.js'), 'utf8');
const select = page.match(/<select id="speed" aria-label="Reading speed">([\s\S]*?)<\/select>/)[1];
const options = [
  ...select.matchAll(/<option value="([^"]+)" aria-label="([^"]+)"[^>]*>([^<]+)<\/option>/g),
];

test('the list is the same nine numbers as every other voice', () => {
  const shared = fs.readFileSync(
    path.join(__dirname, '../../../client/src/utils/voicePace.ts'),
    'utf8',
  );
  const voiceSpeeds = shared.match(/voiceSpeeds = \[([^\]]+)\]/)[1].split(', ');
  assert.deepStrictEqual(
    options.map((o) => o[1]),
    voiceSpeeds,
  );
  assert.strictEqual(select.match(/<option/g).length, 9);
});

test('labels are numbers for the eye and for the ear, and no words are left', () => {
  for (const [, value, spoken, shown] of options) {
    assert.strictEqual(shown, `${value}x`);
    assert.strictEqual(spoken, `${value} times`);
  }
  assert.ok(!/Slower|Normal|Faster|Fastest/.test(select));
});

test('1x is the one default', () => {
  assert.deepStrictEqual(
    options.filter((o) => o[0].includes(' selected')).map((o) => o[1]),
    ['1'],
  );
});
