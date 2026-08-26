/**
 * Tests for the open-loop flag. The most important thing in this file is the
 * REGRESSION CORPUS at the bottom: the twelve real cards that the FIRST design
 * flagged wrongly. They are fixtures now, so nobody can reintroduce
 * infer-the-loop-from-the-text without every one of them going red.
 */
const test = require('node:test');
const assert = require('node:assert');
const L = require('./kadeOpenLoops.js');

const NOW = new Date('2026-08-26T05:00:00Z');
const loop = (value, staleAfter, extra = {}) => ({ key: 'k', value, staleAfter, ...extra });

test('extractDates takes explicit, year-bearing dates in four shapes', () => {
  const iso = (d) => d.toISOString().slice(0, 10);
  assert.deepStrictEqual(L.extractDates('surgery is Thursday August 27, 2026').map(iso), ['2026-08-27']);
  assert.deepStrictEqual(L.extractDates('27 August 2026').map(iso), ['2026-08-27']);
  assert.deepStrictEqual(L.extractDates('due 2026-08-27').map(iso), ['2026-08-27']);
  assert.deepStrictEqual(L.extractDates('8/27/2026').map(iso), ['2026-08-27']);
});

test('extractDates refuses everything without a year — on purpose', () => {
  for (const s of ['surgery is Thursday August 27', 'next Thursday', 'in three weeks',
                   'those were big in the 90s', 'call 8/27', 'sometime in August']) {
    assert.deepStrictEqual(L.extractDates(s), [], s);
  }
});

test('extractDates rejects a date that does not exist', () => {
  assert.deepStrictEqual(L.extractDates('February 31, 2026'), []);
});

test('dateFromText takes the LAST date so a range settles on its end', () => {
  assert.strictEqual(
    L.dateFromText('time off Aug 27 through September 8, 2026').toISOString().slice(0, 10),
    '2026-09-08',
  );
});

test('a declared loop flags only after its date, past the grace window', () => {
  const c = loop("Mom's foot surgery is Thursday August 27, 2026.", '2026-08-27T12:00:00Z');
  assert.strictEqual(L.isExpired(c, new Date('2026-08-26T05:00:00Z')), false, 'still ahead');
  assert.strictEqual(L.isExpired(c, new Date('2026-08-27T18:00:00Z')), false, 'same day, inside grace');
  assert.strictEqual(L.isExpired(c, new Date('2026-09-01T05:00:00Z')), true, 'days later');
  assert.match(L.describeStale(c, new Date('2026-09-01T05:00:00Z')), /ASK, don't assert/);
});

test('a card with no declared staleAfter never flags, whatever its text says', () => {
  assert.strictEqual(L.isExpired({ value: 'surgery was August 27, 2026' }, NOW), false);
  assert.strictEqual(L.describeStale({ value: 'August 1, 2020 and August 2, 2021' }, NOW), '');
});

test('reminder cards are left alone — the nudge sweep owns them', () => {
  const r = loop('take meds', '2026-08-01T12:00:00Z', { type: 'reminder', dueAt: '2026-08-01T12:00:00Z' });
  assert.strictEqual(L.isExpired(r, NOW), false);
});

test('KADE_OPEN_LOOPS=0 turns the whole thing off', () => {
  const c = loop('surgery Aug 27', '2026-08-01T12:00:00Z');
  const prev = process.env.KADE_OPEN_LOOPS;
  process.env.KADE_OPEN_LOOPS = '0';
  assert.strictEqual(L.isExpired(c, NOW), false);
  assert.strictEqual(L.describeStale(c, NOW), '');
  if (prev === undefined) delete process.env.KADE_OPEN_LOOPS; else process.env.KADE_OPEN_LOOPS = prev;
  assert.strictEqual(L.isExpired(c, NOW), true, 'and back on when the switch is removed');
});

test('junk never throws', () => {
  for (const c of [null, undefined, {}, { value: null }, { value: 12 }, { staleAfter: 'not a date' }]) {
    assert.doesNotThrow(() => L.describeStale(c, NOW));
    assert.strictEqual(L.describeStale(c, NOW), '');
  }
});

/* ── THE REGRESSION CORPUS ────────────────────────────────────────────────────
 * Real card text from two live seats. Version one of this module flagged EVERY
 * ONE of these, on a corpus where exactly one card was a genuine open loop.
 * A date is not a tense. If any of these ever flags again, the read side has
 * started inferring loops from text and the change should be reverted. */
const REAL_CARDS_THAT_MUST_NEVER_FLAG = [
  'Ziggy Tunes — tribute album for Ziggy (African grey parrot, companion since 2017, died July 10 2026).',
  'Got CPR certified July 22, 2026 through LifePro Safety — blended learning, online first.',
  'Goes to concerts regularly with Amber and Cameron. Saw Shinedown on July 28, 2026.',
  'Daisy was an English bulldog they got in 2018 as a retired breeder. She was put down September 11, 2025.',
  'Checked platform status on August 23, 2026 to understand current system state.',
  'FORGE-NOTE: Kiana Assumption Fix (August 23, 2026). VERIFIED: fixed in the iOS native app.',
  "Kade's personal Spotter is Whittney — renamed from Iris on July 17 2026, voice Leda.",
  'Deploy rules (updated July 18 2026): fork branch kade and the proxies AUTO-DEPLOY on push.',
  'Kade told me July 8 2026: never assume I will do anything but audio.',
  'The seven companions are LIVE on the marketplace as of July 18 2026.',
  'Oldest of six. Parents: Holly (b. 1978), Jerry (b. Sep 1975), first cardioversion July 7 2026.',
  'Kiana is Kade\'s default agent, built for accessibility, evolved through July 18 2026.',
];

test('THE CALIBRATION: twelve real cards that v1 got wrong all stay silent', () => {
  for (const value of REAL_CARDS_THAT_MUST_NEVER_FLAG) {
    assert.strictEqual(L.isExpired({ key: 'x', value }, NOW), false, value.slice(0, 60));
  }
});

test('and the one real loop in that corpus still works once DECLARED', () => {
  const real = loop(
    'Mom has a pre-op appointment on Monday, August 24, 2026 at 2:15 PM in Ozark.',
    '2026-08-24T12:00:00Z',
  );
  assert.strictEqual(L.isExpired(real, NOW), true);
});
