/* kadeCardRecall.ceiling.test.js — Aug 28 2026.
 *
 * THE HOLE BETWEEN TWO CORRECT HALVES. The Aug-20 shared-pin ceiling evicts
 * over-budget shared cards from the head and says, in its own log line, that
 * the rest are "moved to retrieval." The retrieval half then dropped every
 * shared card on the floor with `m.agentId == null` — "it's shared, so it's
 * already in the head" — which was true before the ceiling existed and false
 * for every evicted card since. On one live seat: 6 of 10 shared cards in
 * neither lane, every turn.
 *
 * These run standalone:  node --test api/server/services/kadeCardRecall.ceiling.test.js
 * They extract the SHIPPED functions rather than a transcription of them.
 *
 * ⚠️ HONEST NOTE ON THE RED-PROOF. There is no old function to revert here —
 * before this fix the tail simply had no way to ask the question, so the
 * usual revert-and-watch-it-go-red is not available. The discriminating pair
 * is the pair of budget tests: at budget 250 the head must hold FEWER than
 * all ten shared cards, and at budget 5000 it must hold all ten. A stub that
 * returned a constant fails one or the other, whichever way it leaned.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, 'kadeCardRecall.js'), 'utf8');

/* Bracket-match that actually knows about strings, template literals and
 * comments. The naive version counts braces inside `${...}` and inside the
 * comment blocks this codebase is full of, and then reports "Unexpected end
 * of input" — which reads like broken source instead of a broken reader.
 * Same family as the Aug-23 source-guard that matched its own comment. */
function bodyEnd(src, from) {
  let i = src.indexOf('{', from), depth = 0;
  const tmpl = []; // nesting of template literals
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2) + 2; continue; }
    if (c === '/' && n === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) { if (src[i] === '\\') i++; i++; }
      i++; continue;
    }
    if (c === '`') { tmpl.push(depth); i++; 
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '`') { tmpl.pop(); i++; break; }
        if (src[i] === '$' && src[i + 1] === '{') { i = bodyEnd(src, i + 1); continue; }
        i++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return -1;
}

/* ⚠️ And the FIRST version of this started bracket-matching at the first `{`
 * after the function name, which is `opts = {}` in the parameter list — it
 * "extracted" a 51-character function signature and reported the SOURCE as
 * "Unexpected end of input". Skip the parameter list first. */
function paramsEnd(src, from) {
  let i = src.indexOf('(', from), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

function extract(name, ctx) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name} not found in kadeCardRecall.js`);
  const afterParams = paramsEnd(SRC, start);
  assert.ok(afterParams > -1, `could not find the parameter list of ${name}`);
  const end = bodyEnd(SRC, afterParams);
  assert.ok(end > -1, `could not bracket-match ${name}`);
  const code = SRC.slice(start, end);
  assert.ok(code.length > 200, `${name} extracted as only ${code.length} chars — the reader is broken, not the source`);
  vm.runInContext(code, ctx);
}

function load({ budget, order = 'recent' }) {
  const ctx = {
    Set, Map, String, Number, Math, Array, Object,
    sharedPinBudget: () => budget,
    cardTokens: (m) => m.tokenCount || 0,
    pinPatterns: () => ['family', 'identity', 'name'],
    SHARED_RANK_EXTRA: [],
    sharedPinOrder: () => order,
    logger: { info() {}, warn() {} },
  };
  vm.createContext(ctx);
  extract('applySharedCeiling', ctx);
  extract('pinnedSharedKeysFor', ctx);
  return ctx;
}

const shared = [
  { _id: '1', key: 'preferences',              agentId: null, tokenCount: 125 },
  { _id: '2', key: 'kade_personal_basics',     agentId: null, tokenCount: 76 },
  { _id: '3', key: 'deepseek_research',        agentId: null, tokenCount: 74 },
  { _id: '4', key: 'whittney_spotter',         agentId: null, tokenCount: 55 },
  { _id: '5', key: 'kiana_personality_issue',  agentId: null, tokenCount: 53 },
  { _id: '6', key: 'task_spoken_diff_js',      agentId: null, tokenCount: 44 },
  { _id: '7', key: 'platform_snapshot_temp',   agentId: null, tokenCount: 21 },
  { _id: '8', key: 'sleep_token_granite',      agentId: null, tokenCount: 21 },
  { _id: '9', key: 'platform_status_check',    agentId: null, tokenCount: 19 },
  { _id: '10', key: 'thunderstorm_enthusiast', agentId: null, tokenCount: 18 },
];
const own = [
  { _id: '20', key: 'kade_interests_concerts', agentId: 'agent_x', tokenCount: 63 },
  { _id: '21', key: 'kade_family',             agentId: 'agent_x', tokenCount: 190 },
];

/* Her real seat, Aug 28 2026: 506 shared tokens against a 250 budget, the
 * live log line reading "kept 4/10 card(s) (238 tok), rest moved to retrieval". */
test('the ceiling still evicts exactly what it always did', () => {
  const { applySharedCeiling } = load({ budget: 250 });
  const pinned = [...shared];
  const r = applySharedCeiling(pinned, ['family', 'identity', 'name'], {});
  assert.strictEqual(pinned.length + r.evicted.length, 10, 'no card may vanish entirely');
  assert.ok(r.evicted.length > 0, 'a 506-token bucket against a 250 budget must evict');
  const kept = pinned.reduce((s, m) => s + m.tokenCount, 0);
  assert.ok(kept <= 250, `kept ${kept} tokens, over the 250 budget`);
});

test('THE BUG: an evicted shared card is NOT reported as riding the head', () => {
  const { pinnedSharedKeysFor } = load({ budget: 250 });
  const head = pinnedSharedKeysFor(shared, own);
  const evicted = shared.filter((m) => !head.has(m.key));
  assert.ok(evicted.length > 0,
    'nothing was evicted — the test seat no longer reproduces the live one');
  // The old rule said EVERY shared card was pinned. That is the bug.
  assert.ok(head.size < shared.length,
    'every shared card is still being reported as pinned — retrieval will skip them all');
});

test('what the head keeps, retrieval must NOT duplicate', () => {
  const { pinnedSharedKeysFor } = load({ budget: 250 });
  const head = pinnedSharedKeysFor(shared, own);
  assert.ok(head.size > 0, 'the head must still hold something');
  for (const k of head) {
    assert.ok(shared.some((m) => m.key === k), `${k} is not a shared card`);
  }
});

test('a bucket under budget evicts nothing (the fix changes nothing else)', () => {
  const { pinnedSharedKeysFor } = load({ budget: 5000 });
  const head = pinnedSharedKeysFor(shared, own);
  assert.strictEqual(head.size, shared.length,
    'under budget, every shared card still rides the head exactly as before');
});

test('budget 0 disables the ceiling entirely', () => {
  const { pinnedSharedKeysFor } = load({ budget: 0 });
  assert.strictEqual(pinnedSharedKeysFor(shared, own).size, shared.length);
});

test('an agent-bucket card is never mistaken for a shared one', () => {
  const { pinnedSharedKeysFor } = load({ budget: 250 });
  const head = pinnedSharedKeysFor(shared, own);
  assert.ok(!head.has('kade_interests_concerts'),
    'the concerts card lives in Kiana\'s own bucket, not the shared head');
});

/* ── Part 99.4 (Aug 30 2026): THE TIE-BREAK WAS SMALLEST-FIRST ──────────────
 *
 * Not a hypothetical. Amber A's live seat, the day this was found: 720 tokens
 * of shared cards against the 250 ceiling. What the old tie-break kept on the
 * head: that she likes two Sleep Token songs (25 tok). What it evicted:
 * `relationship_unconventional_breakup_arrangement` (70 tok), written that
 * same evening, saying she and her partner had broken up. The recall audit
 * says that card reached the model ZERO times across 30 turns — evicted from
 * the head, never scored high enough for retrieval — and forty minutes after
 * it was filed Kiana told her the breakup "hasn't happened yet."
 *
 * Smallest-first maximises the NUMBER of cards kept, which was never the
 * objective, and it evicts the longest cards — which are the ones about the
 * complicated things, because complicated things take more words. */
const AMBER_A = [
  { _id: 'a1', key: 'user_vision_blind_oph_nystagmus',                 agentId: null, tokenCount: 42,  updated_at: '2026-08-22T00:00:00Z' },
  { _id: 'a2', key: 'user_recent_losses_emotional_weight',             agentId: null, tokenCount: 22,  updated_at: '2026-08-22T00:00:00Z' },
  { _id: 'a3', key: 'user_music_interest_sleep_token',                 agentId: null, tokenCount: 25,  updated_at: '2026-08-22T00:00:00Z' },
  { _id: 'a4', key: 'user_physical_features',                          agentId: null, tokenCount: 28,  updated_at: '2026-08-22T00:00:00Z' },
  { _id: 'a5', key: 'user_meds_lexapro',                               agentId: null, tokenCount: 38,  updated_at: '2026-08-22T00:00:00Z' },
  { _id: 'a6', key: 'user_comparison_ellaun_jason',                    agentId: null, tokenCount: 42,  updated_at: '2026-08-22T00:00:00Z' },
  { _id: 'a7', key: 'user_plays_cosmic_rage_rp_chemistry',             agentId: null, tokenCount: 59,  updated_at: '2026-08-22T00:00:00Z' },
  { _id: 'a8', key: 'relationship_intimacy_drought_two_years',         agentId: null, tokenCount: 62,  updated_at: '2026-08-22T00:00:00Z' },
  { _id: 'a9', key: 'relationship_timeline_corrected',                 agentId: null, tokenCount: 66,  updated_at: '2026-08-27T00:00:00Z' },
  { _id: 'a10', key: 'relationship_unconventional_breakup_arrangement', agentId: null, tokenCount: 70,  updated_at: '2026-08-29T19:36:12Z' },
  { _id: 'a11', key: 'ellaun_relationship_dynamic',                    agentId: null, tokenCount: 104, updated_at: '2026-08-22T00:00:00Z' },
  { _id: 'a12', key: 'relationship_timeline_detailed',                 agentId: null, tokenCount: 162, updated_at: '2026-08-29T00:00:00Z' },
];
const keptKeys = (order) => {
  const { applySharedCeiling } = load({ budget: 250, order });
  const pinned = [...AMBER_A];
  applySharedCeiling(pinned, ['family', 'identity', 'name'], {});
  return pinned.map((m) => m.key);
};

test('THE LIVE FAILURE: newest-first puts the breakup card back on the head', () => {
  const kept = keptKeys('recent');
  assert.ok(kept.includes('relationship_unconventional_breakup_arrangement'),
    `the card the whole complaint is about must ride the head; kept: ${kept.join(', ')}`);
});

test('and the OLD tie-break provably did not — this is the red proof', () => {
  const kept = keptKeys('size');
  assert.ok(!kept.includes('relationship_unconventional_breakup_arrangement'),
    'smallest-first must still evict it, or this fixture no longer reproduces the bug');
  assert.ok(kept.includes('user_music_interest_sleep_token'),
    'and must still keep the Sleep Token trivia that beat it, which is the whole indictment');
});

test('the accessibility card outranks recency — a rank-1 card is never traded away', () => {
  /* The generic load() stubs the pattern list down to family/identity/name, so
   * this one test hands applySharedCeiling the REAL patterns: with 'blind' in
   * them, user_vision_... is rank 1 and must survive even though it is the
   * oldest card in the fixture and one of the larger ones. This is the
   * guarantee that recency never gets to evict accessibility. */
  const REAL = ['family', 'accessib', 'access', 'blind', 'screen_reader', 'pronounc', 'identity', 'call_me', 'name', 'how_we_talk'];
  const { applySharedCeiling } = load({ budget: 250, order: 'recent' });
  const pinned = [...AMBER_A];
  applySharedCeiling(pinned, REAL, {});
  const kept = pinned.map((m) => m.key);
  assert.ok(kept.includes('user_vision_blind_oph_nystagmus'),
    `blind/vision is rank 1; recency must not evict it. kept: ${kept.join(', ')}`);
  assert.ok(kept.includes('relationship_unconventional_breakup_arrangement'),
    'and the breakup card still makes it in alongside, which is the point of the fix');
});

test('the budget is still respected — recency buys no extra room', () => {
  const { applySharedCeiling } = load({ budget: 250, order: 'recent' });
  const pinned = [...AMBER_A];
  applySharedCeiling(pinned, ['family', 'identity', 'name'], {});
  const used = pinned.reduce((n, m) => n + m.tokenCount, 0);
  assert.ok(used <= 250, `head must fit the budget, used ${used}`);
});

test('no card vanishes: everything evicted is handed to retrieval', () => {
  const { applySharedCeiling } = load({ budget: 250, order: 'recent' });
  const pinned = [...AMBER_A];
  const r = applySharedCeiling(pinned, ['family', 'identity', 'name'], {});
  assert.strictEqual(pinned.length + r.evicted.length, AMBER_A.length);
});

test('undated cards fall back to size, so a legacy corpus behaves exactly as before', () => {
  // Every card in the original fixture above has no updated_at at all.
  const a = keptKeys('recent');
  const undated = load({ budget: 250, order: 'recent' });
  const p1 = [...shared];
  undated.applySharedCeiling(p1, ['family', 'identity', 'name'], {});
  const p2 = [...shared];
  load({ budget: 250, order: 'size' }).applySharedCeiling(p2, ['family', 'identity', 'name'], {});
  assert.deepStrictEqual(p1.map((m) => m.key).sort(), p2.map((m) => m.key).sort(),
    'with no dates present the two orderings must keep the identical set');
  assert.ok(a.length > 0);
});

test('ties on the same timestamp still break by size, so ordering is deterministic', () => {
  const same = [
    { _id: 's1', key: 'aaa', agentId: null, tokenCount: 200, updated_at: '2026-08-29T00:00:00Z' },
    { _id: 's2', key: 'bbb', agentId: null, tokenCount: 40,  updated_at: '2026-08-29T00:00:00Z' },
    { _id: 's3', key: 'ccc', agentId: null, tokenCount: 40,  updated_at: '2026-08-29T00:00:00Z' },
  ];
  const { applySharedCeiling } = load({ budget: 100, order: 'recent' });
  const pinned = [...same];
  applySharedCeiling(pinned, ['family'], {});
  assert.deepStrictEqual(pinned.map((m) => m.key), ['bbb', 'ccc']);
});
