'use strict';
/* Part 236 (Sep 20 2026). Plain node:test, not jest (the name keeps jest's
 * testMatch off it): kadeJev.js and kadeJevJudges.js have no app dependencies,
 * so this runs anywhere, including the Deno shim on kadepc:
 *   node --test api/server/services/kadeJevJudges.nodetest.js
 * No network: fetch and ask are stubbed. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jev = require('./kadeJev');
const J = require('./kadeJevJudges');

function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) {
    old[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  const restore = () => {
    for (const k of Object.keys(old)) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  };
  let r;
  try {
    r = fn();
  } catch (e) {
    restore();
    throw e;
  }
  if (r && typeof r.then === 'function') return r.finally(restore);
  restore();
  return r;
}
const ON = { TYPESAFE_API_KEY: 'apikey_test', KADE_JEV: undefined, KADE_JEV_LIBRARY: undefined, KADE_JEV_KEEPER_SHADOW: undefined, KADE_JEV_TOOLS_SHADOW: undefined };

test('enabled: needs a key, obeys the master kill and the per-feature kill', () => {
  withEnv({ ...ON, TYPESAFE_API_KEY: undefined }, () => assert.strictEqual(jev.enabled('KADE_JEV_LIBRARY'), false));
  withEnv(ON, () => assert.strictEqual(jev.enabled('KADE_JEV_LIBRARY'), true));
  withEnv({ ...ON, KADE_JEV: '0' }, () => assert.strictEqual(jev.enabled('KADE_JEV_LIBRARY'), false));
  withEnv({ ...ON, KADE_JEV_LIBRARY: '0' }, () => {
    assert.strictEqual(jev.enabled('KADE_JEV_LIBRARY'), false);
    assert.strictEqual(jev.enabled('KADE_JEV_TOOLS_SHADOW'), true);
  });
});

test('ask: throws with no key and never calls fetch', async () => {
  const realFetch = global.fetch;
  let called = 0;
  global.fetch = async () => { called++; return { ok: true, json: async () => ({ answers: {} }) }; };
  try {
    await withEnv({ ...ON, TYPESAFE_API_KEY: undefined }, () => assert.rejects(jev.ask({}, {}), /disabled/));
    assert.strictEqual(called, 0);
  } finally {
    global.fetch = realFetch;
  }
});

test('ask: pins the model, sends the bearer, counts ok and failed, throws on HTTP and on no answers', async () => {
  const realFetch = global.fetch;
  try {
    await withEnv(ON, async () => {
      let seen = null;
      global.fetch = async (url, opts) => { seen = { url, opts }; return { ok: true, json: async () => ({ answers: { a: { noul: 0.5 } } }) }; };
      const ok0 = jev.counts.ok;
      const r = await jev.ask({ message: 'hi' }, { a: { type: 'noul' } });
      assert.strictEqual(r.answers.a.noul, 0.5);
      assert.strictEqual(jev.counts.ok, ok0 + 1);
      const body = JSON.parse(seen.opts.body);
      assert.strictEqual(body.model, jev.MODEL);
      assert.notStrictEqual(body.model, 'jev-latest');
      assert.strictEqual(seen.opts.headers.Authorization, 'Bearer apikey_test');

      const f0 = jev.counts.failed;
      global.fetch = async () => ({ ok: false, status: 500 });
      await assert.rejects(jev.ask({}, {}), /HTTP 500/);
      global.fetch = async () => ({ ok: true, json: async () => ({}) });
      await assert.rejects(jev.ask({}, {}), /no answers/);
      global.fetch = (url, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }));
      await assert.rejects(jev.ask({}, {}, 20), /timeout 20ms/);
      assert.strictEqual(jev.counts.failed, f0 + 3);
      assert.strictEqual(JSON.stringify(jev.health()).includes('apikey_test'), false);
    });
  } finally {
    global.fetch = realFetch;
  }
});

test('the shelf slugs are exactly the 26 shelves of the sort route', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'kadeReadingRoomSort.js'), 'utf8');
  const m = src.match(/const SHELVES = (\[[\s\S]*?\]);/);
  assert.ok(m, 'SHELVES found in the route');
  const SHELVES = vm.runInNewContext(m[1]);
  assert.strictEqual(SHELVES.length, 26);
  assert.deepStrictEqual(Object.values(J.SHELF_OF).sort(), [...SHELVES].sort());
  assert.deepStrictEqual(Object.keys(J.SHELF_OF).sort(), Object.keys(J.SHELF_CRITERIA).sort());
});

const ans = (choice, confidence, noul) => ({ shelf: { choice, confidence }, adult: { noul } });
const plain = { _id: '1', title: 'The Silent Witness', synopsis: 'A detective has 48 hours.' };

test('decideBook: files only when sure of the shelf AND decisive on adult', () => {
  withEnv({ KADE_JEV_LIBRARY_MIN_CONF: undefined, KADE_JEV_LIBRARY_ADULT_LOW: undefined, KADE_JEV_LIBRARY_ADULT_HIGH: undefined }, () => {
    assert.deepStrictEqual(J.decideBook(plain, ans('fiction_mystery_thriller', 0.99, 0.04)), { shelf: 'Fiction — Mystery & thriller', adult: false });
    assert.equal(J.decideBook(plain, ans('fiction_romance', 0.95, 0.97)), null, 'an adult reading goes to the second reader: Jev alone never hides a book');
    assert.strictEqual(J.decideBook(plain, ans('fiction_mystery_thriller', 0.69, 0.04)), null, 'unsure shelf');
    assert.strictEqual(J.decideBook(plain, ans('fiction_mystery_thriller', 0.99, 0.16)), null, 'adult between the lines');
    assert.strictEqual(J.decideBook(plain, ans('fiction_mystery_thriller', 0.99, 0.84)), null, 'adult between the lines');
    assert.strictEqual(J.decideBook(plain, ans('made_up_shelf', 0.99, 0.01)), null, 'unknown shelf');
    assert.strictEqual(J.decideBook(plain, { shelf: { choice: 'poetry', confidence: 0.99 } }), null, 'no adult answer');
    assert.strictEqual(J.decideBook(plain, null), null);
  });
});

test('decideBook: a "not adult" is never taken on trust when the metadata uses an adult word', () => {
  const erotic = { _id: '2', title: 'Bound to Him: An Erotic Novel', synopsis: 'A billionaire.' };
  assert.strictEqual(J.decideBook(erotic, ans('fiction_romance', 0.99, 0.02)), null);
  assert.equal(J.decideBook(erotic, ans('fiction_romance', 0.99, 0.99)), null);
  const coy = { _id: '3', title: 'After Dark', synopsis: 'Tales of desire. Adults only.' };
  assert.strictEqual(J.decideBook(coy, ans('fiction_short_stories', 0.99, 0.02)), null);
  assert.strictEqual(J.decideBook(plain, ans('nonfiction_sex_dating', 0.99, 0.02)), null, 'sex shelf + not adult = second reader');
});

test('sortBooks: failures and the undecided go to leftovers in order; never throws', async () => {
  await withEnv(ON, async () => {
    const books = [{ _id: 'a', title: 'A' }, { _id: 'b', title: 'B' }, { _id: 'c', title: 'C' }, { _id: 'd', title: 'D' }];
    const ask = async (state) => {
      if (state.title === 'B') throw new Error('timeout');
      if (state.title === 'D') return { answers: ans('poetry', 0.5, 0.01), usage: { input_tokens: 1000 } };
      return { answers: ans('poetry', 0.99, 0.01), usage: { input_tokens: 1000 } };
    };
    const r = await J.sortBooks(books, { ask });
    assert.deepStrictEqual(Object.keys(r.out).sort(), ['a', 'c']);
    assert.deepStrictEqual(r.leftovers.map((b) => b._id), ['b', 'd']);
    assert.ok(Math.abs(r.costUSD - (3000 * 0.042) / 1e6) < 1e-12);
  });
});

test('sortBooks: switched off, every book is a leftover and Jev is never asked', async () => {
  let asked = 0;
  const ask = async () => { asked++; return { answers: ans('poetry', 0.99, 0.01) }; };
  const books = [{ _id: 'a', title: 'A' }];
  for (const env of [{ ...ON, KADE_JEV_LIBRARY: '0' }, { ...ON, KADE_JEV: '0' }, { ...ON, TYPESAFE_API_KEY: undefined }]) {
    const r = await withEnv(env, () => J.sortBooks(books, { ask }));
    assert.deepStrictEqual(r.out, {});
    assert.strictEqual(r.leftovers.length, 1);
  }
  assert.strictEqual(asked, 0);
});

test('keeperState: last human turn is latestUser, voice tags stripped, langchain and plain shapes', () => {
  const msgs = [
    { _getType: () => 'human', content: 'my cat is Kasper' },
    { _getType: () => 'ai', content: [{ type: 'text', text: 'Good name.' }] },
    { role: 'user', content: '%%%warm%%% we got a kitten, Biscuit' },
  ];
  const s = J.keeperState(msgs);
  assert.strictEqual(s.latestUser, 'we got a kitten, Biscuit');
  assert.ok(s.earlier.includes('PERSON: my cat is Kasper'));
  assert.ok(s.earlier.includes('ASSISTANT: Good name.'));
  assert.strictEqual(J.keeperState([{ role: 'assistant', content: 'hi' }]), null);
  assert.strictEqual(J.keeperState(null), null);
});

test('keeperWrote: reads cards from attachments, the logbook from the flag', () => {
  const card = { type: 'memory', memory: { type: 'update', key: 'cat' } };
  const err = { type: 'memory', memory: { type: 'error', key: 'cat' } };
  assert.strictEqual(J.keeperWrote({ attachments: [card], logged: false }), 'card');
  assert.strictEqual(J.keeperWrote({ attachments: [null, card], logged: true }), 'card+log');
  assert.strictEqual(J.keeperWrote({ attachments: [], logged: true }), 'log');
  assert.strictEqual(J.keeperWrote({ attachments: [err, null], logged: false }), 'nothing');
  assert.strictEqual(J.keeperWrote({ attachments: undefined, logged: false }), 'nothing');
  assert.strictEqual(J.keeperWrote({ failed: true }), 'error');
});

test('keeper shadow: one line, never rejects, silent when off or when Jev fails', async () => {
  const msgs = [{ role: 'user', content: 'we got a kitten' }];
  const lines = [];
  const log = (l) => lines.push(l);
  await withEnv(ON, async () => {
    const good = J.keeperShadowStart(msgs, { ask: async () => ({ answers: { card: { noul: 0.891 }, log: { noul: 0.9 } } }) });
    J.keeperShadowFinish(good, { attachments: [{ memory: { type: 'update' } }], logged: false, messageId: 'm1', log });
    await good;
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(lines, ['[kadeJev][keeper-shadow] card=0.89 log=0.90 keeper_wrote=card msg=m1']);

    const bad = J.keeperShadowStart(msgs, { ask: async () => { throw new Error('timeout'); } });
    assert.strictEqual(await bad, null);
    J.keeperShadowFinish(bad, { log });
    const malformed = J.keeperShadowStart(msgs, { ask: async () => ({ answers: { card: {}, log: {} } }) });
    assert.strictEqual(await malformed, null);
    J.keeperShadowFinish(null, { log });
    J.keeperShadowFinish(good, { log: () => { throw new Error('logger down'); } });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(lines.length, 1);
  });
  let asked = 0;
  const off = await withEnv({ ...ON, KADE_JEV_KEEPER_SHADOW: '0' }, () => J.keeperShadowStart(msgs, { ask: async () => { asked++; } }));
  assert.strictEqual(off, null);
  assert.strictEqual(asked, 0);
});

/* ── Part 237: the commercial shelf ──────────────────────────────────────── */

test('the ad categories are exactly the ones the library already files under', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../../packages/api/src/library/filing-data.ts'),
    'utf8',
  );
  const body = src.slice(src.indexOf('= {') + 2, src.lastIndexOf('}') + 1).replace(/\/\*[\s\S]*?\*\//g, '');
  const data = JSON.parse(body);
  const known = new Set([...Object.keys(data.prefixes), ...Object.keys(data.strong), ...Object.keys(data.generic)]);
  for (const c of Object.keys(J.AD_CATEGORY_CRITERIA)) {
    assert.ok(known.has(c), `Jev may choose "${c}" but the library has no such shelf`);
  }
  assert.strictEqual(Object.keys(J.AD_CATEGORY_CRITERIA).length, known.size, 'every shelf should be offered');
});

test('adState: the decade is read off the path and never invented', () => {
  assert.deepStrictEqual(J.adState({ title: 'Tegrin ad, 1969', path: 'Video/Commercials/Other Commercials/1960s' }), {
    title: 'Tegrin ad, 1969', decade: '1960s',
  });
  assert.strictEqual(J.adState({ title: 'x', path: 'Video/Commercials/Other Commercials/Undated' }).decade, 'Undated');
  assert.strictEqual(J.adState({ title: 'x', path: 'Video/Commercials/Other Commercials' }).decade, 'unknown');
  assert.strictEqual(J.adState({}).decade, 'unknown');
});

test('decideAd: needs a real shelf, confidence over the floor, and an actual advert', () => {
  const good = { category: { choice: 'Breakfast Cereal', confidence: 0.85 }, isAd: { noul: 0.93 } };
  assert.deepStrictEqual(J.decideAd(good, { minConfidence: 0.7, minIsAd: 0.5 }), {
    category: 'Breakfast Cereal', confidence: 0.85, isAd: 0.93,
  });
  const k = { minConfidence: 0.7, minIsAd: 0.5 };
  /* under the floor: this is the Lever 2000 case */
  assert.strictEqual(J.decideAd({ category: { choice: 'Cars and Trucks', confidence: 0.56 }, isAd: { noul: 0.94 } }, k), null);
  /* a PSA or a station ID is not a product advert */
  assert.strictEqual(J.decideAd({ category: { choice: 'Breakfast Cereal', confidence: 0.99 }, isAd: { noul: 0.2 } }, k), null);
  /* a shelf the library does not have is never honoured */
  assert.strictEqual(J.decideAd({ category: { choice: 'Submarines', confidence: 0.99 }, isAd: { noul: 0.99 } }, k), null);
  assert.strictEqual(J.decideAd({ category: { choice: 'Breakfast Cereal' }, isAd: { noul: 0.9 } }, k), null);
  assert.strictEqual(J.decideAd({ category: { choice: 'Breakfast Cereal', confidence: 0.9 }, isAd: {} }, k), null);
  assert.strictEqual(J.decideAd(null, k), null);
});

test('fileAds: renames only the product folder, keeps the decade, never throws', async () => {
  const items = [
    { _id: 'a', title: 'Team Flakes ad, 1978', path: 'Video/Commercials/Other Commercials/1970s' },
    { _id: 'b', title: 'Lever 2000 ad, 1992', path: 'Video/Commercials/Other Commercials/1990s' },
    { _id: 'c', title: 'boom', path: 'Video/Commercials/Other Commercials/1980s' },
  ];
  const answers = {
    a: { category: { choice: 'Breakfast Cereal', confidence: 0.85 }, isAd: { noul: 0.93 } },
    b: { category: { choice: 'Cars and Trucks', confidence: 0.56 }, isAd: { noul: 0.94 } },
  };
  const r = await withEnv(ON, () =>
    J.fileAds(items, {
      ask: async (state) => {
        const it = items.find((i) => i.title === state.title);
        if (it._id === 'c') throw new Error('timeout');
        return { answers: answers[it._id], usage: { input_tokens: 500 } };
      },
    }),
  );
  assert.strictEqual(r.moves.length, 1);
  assert.deepStrictEqual(
    { from: r.moves[0].from, to: r.moves[0].to },
    { from: 'Video/Commercials/Other Commercials/1970s', to: 'Video/Commercials/Breakfast Cereal/1970s' },
    'the decade folder must survive the move',
  );
  assert.deepStrictEqual(r.skipped.map((s) => s._id).sort(), ['b', 'c'], 'the unsure and the failed both stay put');
  assert.ok(r.costUSD > 0 && r.costUSD < 0.01);
});

test('fileAds: switched off, nothing is asked and nothing moves', async () => {
  let asked = 0;
  const items = [{ _id: 'a', title: 't', path: 'Video/Commercials/Other Commercials/1980s' }];
  const r = await withEnv({ ...ON, KADE_JEV_LIBRARY: '0' }, () =>
    J.fileAds(items, { ask: async () => { asked++; return {}; } }),
  );
  assert.strictEqual(asked, 0);
  assert.deepStrictEqual(r.moves, []);
  assert.strictEqual(r.skipped.length, 1);
});

/* ── Part 237: the gate that can actually skip the keeper ────────────────── */

test('keeperState: latestAssistant is the character turn before the last human one', () => {
  const s = J.keeperState([
    { role: 'assistant', content: 'older reply' },
    { role: 'user', content: 'how are you' },
    { role: 'assistant', content: "I'll check on that Tuesday" },
    { role: 'user', content: 'thanks' },
  ]);
  assert.strictEqual(s.latestUser, 'thanks');
  assert.strictEqual(s.latestAssistant, "I'll check on that Tuesday");
  /* nothing from the character yet */
  assert.strictEqual(J.keeperState([{ role: 'user', content: 'hi' }]).latestAssistant, '(none)');
});

test('keeperGateDecide: skips only when all three sit under the floor', () => {
  const low = { card: 0.04, log: 0.07, promise: 0.02 };
  assert.strictEqual(J.keeperGateDecide(low, 0.3), true);
  /* any one speaking up runs the keeper — including the promise, which is the
   * whole reason the third question exists */
  assert.strictEqual(J.keeperGateDecide({ ...low, card: 0.91 }, 0.3), false);
  assert.strictEqual(J.keeperGateDecide({ ...low, log: 0.57 }, 0.3), false);
  assert.strictEqual(J.keeperGateDecide({ ...low, promise: 0.88 }, 0.3), false);
  /* exactly at the floor is not under it */
  assert.strictEqual(J.keeperGateDecide({ card: 0.3, log: 0.1, promise: 0.1 }, 0.3), false);
  /* garbage never authorises a skip */
  assert.strictEqual(J.keeperGateDecide(null, 0.3), false);
  assert.strictEqual(J.keeperGateDecide({ card: 0.1, log: 0.1 }, 0.3), false);
  assert.strictEqual(J.keeperGateDecide({ card: NaN, log: 0.1, promise: 0.1 }, 0.3), false);
  assert.strictEqual(J.keeperGateDecide({ card: -1, log: 0.1, promise: 0.1 }, 0.3), false);
});

test("keeperGateDecide: the Part 236 trial's own numbers still say what they said", () => {
  /* the 9 save-nothing turns topped out at 0.23 card / 0.28 log; the worst
   * keeper-worthy turn (the rabbit hole) was 0.57 log */
  const promise = 0.05;
  assert.strictEqual(J.keeperGateDecide({ card: 0.23, log: 0.28, promise }, 0.3), true);
  assert.strictEqual(J.keeperGateDecide({ card: 0.1, log: 0.57, promise }, 0.3), false);
});

test('keeperGate: fails OPEN on every failure, and never rejects', async () => {
  const msgs = [{ role: 'user', content: 'good night' }];
  await withEnv(ON, async () => {
    const boom = await J.keeperGate(msgs, { ask: async () => { throw new Error('timeout 2500ms'); } });
    assert.deepStrictEqual(boom, { skip: false, scores: null });
    const malformed = await J.keeperGate(msgs, { ask: async () => ({ answers: { card: {}, log: {}, promise: {} } }) });
    assert.deepStrictEqual(malformed, { skip: false, scores: null });
    /* no human turn to read */
    const empty = await J.keeperGate([{ role: 'assistant', content: 'hi' }], { ask: async () => { throw new Error('never'); } });
    assert.deepStrictEqual(empty, { skip: false, scores: null });
  });
  /* switched off entirely: Jev is never even asked */
  let asked = 0;
  const off = await withEnv({ ...ON, KADE_JEV_KEEPER_SHADOW: '0' }, () =>
    J.keeperGate(msgs, { ask: async () => { asked++; return { answers: {} }; } }),
  );
  assert.deepStrictEqual(off, { skip: false, scores: null });
  assert.strictEqual(asked, 0);
});

test('keeperGate: asks all three and skips; KADE_JEV_KEEPER_GATE=0 keeps the reading, drops the skipping', async () => {
  const msgs = [{ role: 'user', content: 'good night' }];
  const quiet = async () => ({ answers: { card: { noul: 0.04 }, log: { noul: 0.07 }, promise: { noul: 0.02 } } });
  let sawQuestions = null;
  const spy = async (state, questions) => { sawQuestions = Object.keys(questions); return quiet(); };

  const on = await withEnv(ON, () => J.keeperGate(msgs, { ask: spy }));
  assert.deepStrictEqual(sawQuestions, ['card', 'log', 'promise']);
  assert.strictEqual(on.skip, true);
  assert.deepStrictEqual(on.scores, { card: 0.04, log: 0.07, promise: 0.02 });

  const gated = await withEnv({ ...ON, KADE_JEV_KEEPER_GATE: '0' }, () => J.keeperGate(msgs, { ask: quiet }));
  assert.strictEqual(gated.skip, false, 'gate off must never skip');
  assert.ok(gated.scores, 'gate off still reads, so the lines keep coming');

  /* a floor she moved herself is honoured */
  const strict = await withEnv({ ...ON, KADE_JEV_KEEPER_FLOOR: '0.01' }, () => J.keeperGate(msgs, { ask: quiet }));
  assert.strictEqual(strict.skip, false);
});

test('keeperGateLog: one line for both outcomes, and it never throws', () => {
  const lines = [];
  const log = (l) => lines.push(l);
  withEnv(ON, () => {
    J.keeperGateLog({ card: 0.04, log: 0.07, promise: 0.02 }, { skipped: true, messageId: 'm1', log });
    J.keeperGateLog({ card: 0.91, log: 0.12, promise: 0.03 }, {
      skipped: false, attachments: [{ memory: { type: 'update' } }], logged: false, messageId: 'm2', log,
    });
    J.keeperGateLog(null, { skipped: false, attachments: [], logged: false, messageId: 'm3', log });
  });
  assert.deepStrictEqual(lines, [
    '[kadeJev][keeper-gate] card=0.04 log=0.07 promise=0.02 floor=0.30 keeper=SKIPPED msg=m1',
    '[kadeJev][keeper-gate] card=0.91 log=0.12 promise=0.03 floor=0.30 keeper=card msg=m2',
    '[kadeJev][keeper-gate] card=? log=? promise=? (jev silent) floor=0.30 keeper=nothing msg=m3',
  ]);
  /* a dead logger must not take the keeper down with it */
  J.keeperGateLog({ card: 0, log: 0, promise: 0 }, { skipped: true, log: () => { throw new Error('logger down'); } });
});

test('tools shadow: asks only about loaded tools, logs one line, never rejects, never touches keep', async () => {
  const lines = [];
  const log = (l) => lines.push(l);
  await withEnv(ON, async () => {
    let seenQ = null;
    let seenState = null;
    const ask = async (state, questions) => {
      seenState = state;
      seenQ = questions;
      const answers = {};
      for (const k of Object.keys(questions)) answers[k] = { noul: k === 'kade_news' ? 0.96 : 0.05 };
      return { answers };
    };
    const keep = new Set(['kade_weather', 'kade_help']);
    const r = await J.toolsShadow({ text: '%%%tag%%% whats the news looking like tonight', tools: ['kade_news', 'kade_weather', 'kade_help', 'kade_joke'], keep, log }, { ask });
    assert.deepStrictEqual(Object.keys(seenQ).sort(), ['kade_news', 'kade_weather']);
    assert.strictEqual(seenState.message, 'whats the news looking like tonight');
    assert.strictEqual(r.kade_news, 0.96);
    assert.deepStrictEqual(lines, ['[kadeJev][tools-shadow] kept=[kade_weather] jev={kade_news:0.96,kade_weather:0.05}']);
    assert.deepStrictEqual([...keep], ['kade_weather', 'kade_help']);

    assert.strictEqual(await J.toolsShadow({ text: 'hi', tools: ['kade_news'], keep, log }, { ask: async () => { throw new Error('HTTP 500'); } }), null);
    assert.strictEqual(await J.toolsShadow({ text: 'hi', tools: ['kade_joke'], keep, log }, { ask }), null, 'none of the five loaded');
    assert.strictEqual(await J.toolsShadow({ text: '', tools: ['kade_news'], keep, log }, { ask }), null);
    assert.strictEqual(lines.length, 1);
  });
  let asked = 0;
  const off = await withEnv({ ...ON, KADE_JEV_TOOLS_SHADOW: '0' }, () => J.toolsShadow({ text: 'news?', tools: ['kade_news'], keep: new Set(), log }, { ask: async () => { asked++; } }));
  assert.strictEqual(off, null);
  assert.strictEqual(asked, 0);
});
