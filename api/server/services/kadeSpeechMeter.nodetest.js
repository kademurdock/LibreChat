/* Part 291: the Inworld speech meter. Her plan, from her receipts: $25 a month of credit at $10 per
 * million characters, so about 2,500,000 characters are included (not 25 million), then $10 per
 * million. Both numbers come from env; the iPhone reads monthChars and includedChars.
 *
 * Run: node --test api/server/services/kadeSpeechMeter.nodetest.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inworldMeter, DEFAULT_INCLUDED_CHARS, DEFAULT_USD_PER_M } = require('./kadeSpeechMeter');

test('defaults: 2,500,000 characters included, $10 per million past that', () => {
  assert.equal(DEFAULT_INCLUDED_CHARS, 2500000);
  assert.equal(DEFAULT_USD_PER_M, 10);
  assert.deepEqual(inworldMeter(1804198, {}), {
    monthChars: 1804198,
    includedChars: 2500000,
    overagePerMillionUSD: 10,
    overageChars: 0,
    overageUSD: 0,
    phoneCallsCounted: false,
  });
});

test('past the credit, the overage is counted at the plan rate', () => {
  const m = inworldMeter(3250000, {});
  assert.equal(m.overageChars, 750000);
  assert.equal(m.overageUSD, 7.5);
});

test('env sets both numbers; junk, zero or negative values fall back to the defaults', () => {
  const m = inworldMeter(1500000, { KADE_INWORLD_INCLUDED_CHARS: '1250000', KADE_INWORLD_USD_PER_M: '20' });
  assert.equal(m.includedChars, 1250000);
  assert.equal(m.overagePerMillionUSD, 20);
  assert.equal(m.overageChars, 250000);
  assert.equal(m.overageUSD, 5);
  for (const bad of ['', 'lots', '0', '-5']) {
    const d = inworldMeter(10, { KADE_INWORLD_INCLUDED_CHARS: bad, KADE_INWORLD_USD_PER_M: bad });
    assert.equal(d.includedChars, 2500000);
    assert.equal(d.overagePerMillionUSD, 10);
  }
});

test('a missing or odd count reads as zero, never negative', () => {
  assert.equal(inworldMeter(undefined, {}).monthChars, 0);
  assert.equal(inworldMeter(-40, {}).monthChars, 0);
  assert.equal(inworldMeter('12', {}).monthChars, 12);
});

test('the usage route uses the meter, and the card says what it counts', () => {
  const kade = fs.readFileSync(path.join(__dirname, '../routes/kade.js'), 'utf8');
  assert.match(kade, /inworld = require\('~\/server\/services\/kadeSpeechMeter'\)\.inworldMeter\(/);
  assert.doesNotMatch(kade, /includedChars: 25e6/);
  const pages = fs.readFileSync(path.join(__dirname, '../routes/kadePages.js'), 'utf8');
  const card = pages.slice(pages.indexOf('<div class="card" id="inworld_card"'), pages.indexOf('Add or link a caller'));
  assert.match(card, /monthly speech credit of your Inworld plan/);
  assert.match(card, /Phone-call speech is not counted here yet/);
  assert.doesNotMatch(card, /founder plan|\$10 per million/);
  assert.match(pages, /iw\.overagePerMillionUSD/);
});
