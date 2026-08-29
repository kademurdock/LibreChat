'use strict';
/* Part 97 — the open-loop nudge, tested on the PURE selector plus wiring pins.
 * Red-proof: drop the window filter, the pinned exclusion, or the cap and a
 * behavioral test fails; move the block after the diary branch or delete the
 * kill switch and a pin fails. Runs bare: module-alias for ~ is stubbed. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');
const { isExpired, cardDate } = require('./kadeOpenLoops.js');

/* Extracted from the SHIPPED kadeCardRecall.js, house pattern — a test that
 * runs against a transcription proves the transcription works. */
function loadSelector() {
  const src = fs.readFileSync(require.resolve('./kadeCardRecall.js'), 'utf8');
  const start = src.indexOf('function selectLoopNudges(');
  const end = src.indexOf('async function getMemorySplit');
  assert.ok(start > -1 && end > start, 'could not locate selectLoopNudges');
  const ctx = { process, isExpired, cardDate };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end) + '\nthis.fn = selectLoopNudges;', ctx);
  return ctx.fn;
}
const selectLoopNudges = loadSelector();
const DAY = 86400000;
const NOW = Date.UTC(2026, 7, 29, 12, 0, 0); // Aug 29 2026 noon UTC
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const card = (key, staleAgoDays, extra = {}) => ({
  key, value: `card ${key}`, updated_at: iso(10 * DAY),
  ...(staleAgoDays === null ? {} : { staleAfter: iso(staleAgoDays * DAY) }),
  ...extra,
});
const base = { surfacedKeys: [], headSharedKeys: new Set(), pats: [], now: NOW };

test('a declared date that passed 3 days ago surfaces', () => {
  const out = selectLoopNudges({ ...base, shared: [card('surgery', 3)], own: [] });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].key, 'surgery');
});

test('no declaration, no nudge — whatever the text says', () => {
  const out = selectLoopNudges({ ...base, shared: [card('memorial', null)], own: [] });
  assert.strictEqual(out.length, 0);
});

test('the window closes: a loop 9 days past is consolidation business now', () => {
  const out = selectLoopNudges({ ...base, shared: [card('old', 9)], own: [], days: 7 });
  assert.strictEqual(out.length, 0);
});

test('a pinned shared card never nudges — the head already flags it', () => {
  const out = selectLoopNudges({ ...base, shared: [card('pinnedone', 3)], own: [], headSharedKeys: new Set(['pinnedone']) });
  assert.strictEqual(out.length, 0);
});

test("this turn's topical hits are not re-nudged", () => {
  const out = selectLoopNudges({ ...base, shared: [card('dup', 3)], own: [], surfacedKeys: ['dup'] });
  assert.strictEqual(out.length, 0);
});

test('reminder cards belong to the nudge sweep, not this lane', () => {
  const out = selectLoopNudges({ ...base, own: [card('r', 3, { agentId: 'a', type: 'reminder', dueAt: iso(3 * DAY) })], shared: [] });
  assert.strictEqual(out.length, 0);
});

test('the cap holds and newest expiry wins', () => {
  const out = selectLoopNudges({ ...base, shared: [card('a', 6), card('b', 2), card('c', 4)], own: [], max: 2 });
  assert.strictEqual(out.map((m) => m.key).join(','), 'b,c');
});

test('agent-bucket cards with pin-pattern keys are excluded', () => {
  const out = selectLoopNudges({ ...base, own: [card('kade_core_fact', 3, { agentId: 'a' })], shared: [], pats: ['core'] });
  assert.strictEqual(out.length, 0);
});

// wiring pins
const src = fs.readFileSync(require.resolve('./kadeCardRecall.js'), 'utf8');
const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('kill switch present, block sits before the diary branch', () => {
  const kill = stripped.indexOf("KADE_LOOP_NUDGE !== '0'");
  const diary = stripped.indexOf('if (diaryN > 0) {');
  assert.ok(kill > -1 && diary > -1 && kill < diary);
});

test('nudged keys land in the recall audit', () => {
  const block = stripped.slice(stripped.indexOf("KADE_LOOP_NUDGE !== '0'"), stripped.indexOf('if (diaryN > 0) {'));
  assert.match(block, /surfacedCards\.push\(String\(m\.key\)\)/);
});
