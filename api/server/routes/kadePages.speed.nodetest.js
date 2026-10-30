'use strict';
/* Oct 30 2026: the Describe page's read-aloud speed says numbers, the same nine as every other
 * voice. Her call: "The brisk and all that, that wasn't original". Slower, Normal, Faster and
 * Fastest were 0.9, 1, 1.2 and 1.4 behind words, and under FISH_SPEED_EXACT those are exact.
 * Run: node --test api/server/routes/kadePages.speed.nodetest.js */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

test('labels are numbers for the eye and for the ear, 1x is Normal, and no old words are left', () => {
  for (const [, value, spoken, shown] of options) {
    assert.strictEqual(shown, `${value}x`);
    assert.strictEqual(spoken, value === '1' ? 'Normal' : `${value} times`);
  }
  assert.ok(!/Slower|Faster|Fastest/.test(select));
});

test('1x is the one default', () => {
  assert.deepStrictEqual(
    options.filter((o) => o[0].includes(' selected')).map((o) => o[1]),
    ['1'],
  );
});

/* The real functions from the page, on small stand-ins for the select and the network. */
const clipSource = page.slice(
  page.indexOf('function speed(){'),
  page.indexOf('function stopAll(){'),
);
const clipRig = () => {
  const sent = [];
  const held = [];
  const rig = {
    sent,
    held,
    hold: false,
    select: { value: '1' },
    urls: 0,
  };
  rig.page = vm.runInNewContext(
    `var chunks = ['first clip', 'second clip'], blobCache = {}, TOKEN = 't';
     ${clipSource}
     ({ fetchClip });`,
    {
      document: { getElementById: () => rig.select },
      FormData,
      URL: { createObjectURL: () => `blob:${++rig.urls}` },
      fetch: async (_url, init) => {
        sent.push({ input: init.body.get('input'), speed: init.body.get('speed') });
        if (rig.hold) {
          await new Promise((resolve) => held.push(resolve));
        }
        return { ok: true, blob: async () => ({}) };
      },
    },
  );
  return rig;
};

test('a clip is fetched once at one speed', async () => {
  const rig = clipRig();
  const url = await rig.page.fetchClip(0);
  assert.strictEqual(await rig.page.fetchClip(0), url);
  assert.deepStrictEqual(rig.sent, [{ input: 'first clip', speed: '1' }]);
});

test('changing Speed never replays a clip fetched at the old speed', async () => {
  const rig = clipRig();
  const old = await rig.page.fetchClip(0);
  rig.select.value = '1.3';
  const fresh = await rig.page.fetchClip(0);
  assert.notStrictEqual(fresh, old);
  assert.deepStrictEqual(rig.sent, [
    { input: 'first clip', speed: '1' },
    { input: 'first clip', speed: '1.3' },
  ]);
});

test('going back to a speed reuses that clip instead of paying for it twice', async () => {
  const rig = clipRig();
  const old = await rig.page.fetchClip(0);
  rig.select.value = '1.3';
  await rig.page.fetchClip(0);
  rig.select.value = '1';
  assert.strictEqual(await rig.page.fetchClip(0), old);
  assert.strictEqual(rig.sent.length, 2);
});

test('the next clip fetched ahead at the old speed does not play after a change', async () => {
  const rig = clipRig();
  rig.hold = true;
  const ahead = rig.page.fetchClip(1);
  await new Promise(setImmediate);
  rig.select.value = '1.3';
  rig.held[0]();
  const old = await ahead;
  rig.hold = false;
  const fresh = await rig.page.fetchClip(1);
  assert.notStrictEqual(fresh, old);
  assert.deepStrictEqual(
    rig.sent.map((s) => s.speed),
    ['1', '1.3'],
  );
});
