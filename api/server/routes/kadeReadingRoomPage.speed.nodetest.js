'use strict';
/* Oct 30 2026: the Library's speed list says numbers, and old clips cannot replay under them.
 * Run: node --test api/server/routes/kadeReadingRoomPage.speed.nodetest.js */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const page = fs.readFileSync(path.join(__dirname, 'kadeReadingRoomPage.js'), 'utf8');
const select = page.match(/<select id="speedSel">(.*?)<\/select>/)[1];
const options = [...select.matchAll(/<option value="([^"]+)" aria-label="([^"]+)"[^>]*>([^<]+)<\/option>/g)];

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
  assert.deepStrictEqual(
    options.map((o) => o[1]),
    ['0.75', '0.8', '0.9', '1', '1.1', '1.2', '1.3', '1.4', '1.5'],
  );
});

test('1x is the one default', () => {
  assert.deepStrictEqual(
    options.filter((o) => o[0].includes(' selected')).map((o) => o[1]),
    ['1'],
  );
});

test('labels are numbers for the eye and for the ear', () => {
  for (const [, value, spoken, shown] of options) {
    assert.strictEqual(shown, `${value}x`);
    assert.strictEqual(spoken, `${value} times`);
  }
  assert.ok(!/Slower|Faster|Fastest|Normal/.test(select));
});

test('every generated clip URL carries the pacing mark, so older cached clips cannot replay', () => {
  const urls = page.match(/'\/audio\/'.*?'&delivery='/g);
  assert.strictEqual(urls.length, 3);
  for (const url of urls) assert.ok(url.includes("'&speed=' + speed + AUDIO_PACING"), url);
  assert.ok(page.includes("var AUDIO_PACING = '&pacing=4';"));
});

/* The real function from the page, on a small stand-in for the select. */
const source = page.match(/function showSpeed\(n\)\{[\s\S]*?\n {2}\}\n/)[0];
const makeSelect = () => {
  const sel = {
    value: '',
    options: options.map((o) => ({ value: o[1] })),
    insertBefore(o, before) {
      const at = before ? sel.options.indexOf(before) : sel.options.length;
      sel.options.splice(at, 0, o);
    },
  };
  return sel;
};
const run = (sel, n) =>
  vm.runInNewContext(`${source}; showSpeed(${n});`, {
    $: () => sel,
    document: {
      createElement: () => ({
        attrs: {},
        setAttribute(k, v) {
          this.attrs[k] = v;
        },
      }),
    },
  });

test('a saved number on the list just selects', () => {
  const sel = makeSelect();
  run(sel, 1.3);
  assert.strictEqual(sel.value, '1.3');
  assert.strictEqual(sel.options.length, 9);
});

test('a saved number off the list, like the old 1.15, shows as itself, in order, never blank', () => {
  const sel = makeSelect();
  run(sel, 1.15);
  assert.strictEqual(sel.value, '1.15');
  assert.deepStrictEqual(
    sel.options.map((o) => o.value),
    ['0.75', '0.8', '0.9', '1', '1.1', '1.15', '1.2', '1.3', '1.4', '1.5'],
  );
  const added = sel.options[5];
  assert.strictEqual(added.textContent, '1.15x');
  assert.strictEqual(added.attrs['aria-label'], '1.15 times');
});
