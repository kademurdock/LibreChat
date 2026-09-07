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
  const start = src.indexOf('const LOOP_NUDGE_LEDGER = new Map()');
  const end = src.indexOf('async function getMemorySplit');
  assert.ok(start > -1 && end > start, 'could not locate the nudge ledger + selectLoopNudges');
  const ctx = { process, isExpired, cardDate };
  vm.createContext(ctx);
  vm.runInContext(
    src.slice(start, end) +
      '\nthis.fn = selectLoopNudges; this.recentlyNudgedKeys = recentlyNudgedKeys; this.recordLoopNudges = recordLoopNudges;',
    ctx,
  );
  return ctx;
}
const loaded = loadSelector();
const selectLoopNudges = loaded.fn;
const { recentlyNudgedKeys, recordLoopNudges } = loaded;
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
  const diary = stripped.indexOf('if (diaryN > 0');
  assert.ok(kill > -1 && diary > -1 && kill < diary);
});

test('nudged keys land in the recall audit', () => {
  const block = stripped.slice(stripped.indexOf("KADE_LOOP_NUDGE !== '0'"), stripped.indexOf('if (diaryN > 0'));
  assert.match(block, /surfacedCards\.push\(String\(m\.key\)\)/);
});

// ═══ PART 141 — a friend who remembered asks ONCE ═══════════════════════════
// (Sep 7 2026, Kade reading Amber A's chat: "it keeps bringing things up and
// repeating them" — the same expired plan rode four consecutive turns.)
const HOUR = 3600000;
const fresh = () => new Map();

test('a nudged card is not nudged again in the same conversation', () => {
  const ledger = fresh();
  const cards = [card('service', 1)];
  const first = recentlyNudgedKeys({ userId: 'u', conversationId: 'c1', cards, now: NOW, ledger });
  assert.strictEqual(first.size, 0);
  recordLoopNudges({ userId: 'u', conversationId: 'c1', keys: ['service'], now: NOW, ledger });
  const again = recentlyNudgedKeys({ userId: 'u', conversationId: 'c1', cards, now: NOW + 5 * 60000, ledger });
  assert.ok(again.has('service'));
  const out = selectLoopNudges({ ...base, shared: cards, own: [], recentlyNudged: again });
  assert.strictEqual(out.length, 0);
});

test('a different conversation inside the cooldown still waits; after it, one more ask', () => {
  const ledger = fresh();
  const cards = [card('service', 1)];
  recordLoopNudges({ userId: 'u', conversationId: 'c1', keys: ['service'], now: NOW, ledger });
  const soon = recentlyNudgedKeys({ userId: 'u', conversationId: 'c2', cards, now: NOW + 2 * HOUR, ledger, env: {} });
  assert.ok(soon.has('service'), 'inside the 24 h cooldown');
  const later = recentlyNudgedKeys({ userId: 'u', conversationId: 'c2', cards, now: NOW + 25 * HOUR, ledger, env: {} });
  assert.strictEqual(later.size, 0, 'cooldown over, a new conversation may ask once');
});

test('three asks and the card is consolidation business — never a fourth', () => {
  const ledger = fresh();
  const cards = [card('service', 1)];
  for (let i = 0; i < 3; i++) {
    recordLoopNudges({ userId: 'u', conversationId: 'c' + i, keys: ['service'], now: NOW + i * 30 * HOUR, ledger });
  }
  const out = recentlyNudgedKeys({ userId: 'u', conversationId: 'c9', cards, now: NOW + 400 * HOUR, ledger, env: {} });
  assert.ok(out.has('service'));
});

test('the ledger is per person: her card nudged does not silence his', () => {
  const ledger = fresh();
  const cards = [card('service', 1)];
  recordLoopNudges({ userId: 'amber', conversationId: 'c1', keys: ['service'], now: NOW, ledger });
  const his = recentlyNudgedKeys({ userId: 'corey', conversationId: 'c1', cards, now: NOW, ledger, env: {} });
  assert.strictEqual(his.size, 0);
});

test('the selector honors recentlyNudged and still nudges the rest', () => {
  const out = selectLoopNudges({ ...base, shared: [card('a', 2), card('b', 3)], own: [], recentlyNudged: new Set(['a']) });
  assert.strictEqual(out.map((m) => m.key).join(','), 'b');
});

test('wiring: selection stages nudges; the pipeline tests cover delivery and failure', () => {
  const block = stripped.slice(stripped.indexOf("KADE_LOOP_NUDGE !== '0'"), stripped.indexOf('if (diaryN > 0'));
  assert.match(block, /recentlyNudged: recentlyNudgedKeys\(/);
  assert.doesNotMatch(block, /recordLoopNudges\(/);
  assert.match(block, /pendingNudges\.push/);
  assert.match(block, /ask ONCE/);
});

test('a card rewritten AFTER its own date is answered, not open (Amber\'s uu_community)', () => {
  /* staleAfter 2 days ago, updated 2 hours ago: the keeper folded in how it went */
  const answered = { ...card('uu_community', 2), updated_at: iso(2 * HOUR) };
  const out = selectLoopNudges({ ...base, shared: [answered], own: [] });
  assert.strictEqual(out.length, 0);
  /* same card untouched since before its date: still a question */
  const open = { ...card('uu_community', 2), updated_at: iso(3 * DAY) };
  const out2 = selectLoopNudges({ ...base, shared: [open], own: [] });
  assert.strictEqual(out2.length, 1);
});
