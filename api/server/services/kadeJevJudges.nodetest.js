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

/* ── Part 237: the Reverie director ──────────────────────────────────────── */

const PRESENT = [
  { id: 'npc:nell', name: 'Nell Calder', doing: 'folding warm laundry', lines: ['Nell smooths a towel.', 'Nell turns a page.'] },
  { id: 'npc:pat', name: 'Pat Harris', doing: 'working the grill', lines: ['Pat calls an order through the window.'] },
];

test('directorOptions: every authored line is offered, plus nobody, and keys map back', () => {
  const { options, map } = J.directorOptions(PRESENT);
  assert.strictEqual(Object.keys(options).length, 4, 'three lines plus nobody');
  assert.ok(options[J.REVERIE_NOBODY], 'silence is always on the menu');
  assert.deepStrictEqual(map['npc:nell#0'], { id: 'npc:nell', name: 'Nell Calder', line: 'Nell smooths a towel.' });
  assert.ok(options['npc:pat#0'].includes('Pat Harris'), 'the option text names the speaker');
  /* a citizen with no lines contributes nothing and breaks nothing */
  const bare = J.directorOptions([{ id: 'x', name: 'X', lines: [] }]);
  assert.deepStrictEqual(Object.keys(bare.map), []);
});

test('decideDirector: silence, an unknown key and a shaky pick all mean no line', () => {
  const { map } = J.directorOptions(PRESENT);
  const k = { minConfidence: 0.45, freshAt: 0.7 };
  assert.strictEqual(J.decideDirector({ pick: { choice: J.REVERIE_NOBODY, confidence: 0.9 } }, map, k), null);
  /* a key Jev invented is never honoured — the city only says authored lines */
  assert.strictEqual(J.decideDirector({ pick: { choice: 'npc:ghost#9', confidence: 0.99 } }, map, k), null);
  assert.strictEqual(J.decideDirector({ pick: { choice: 'npc:nell#0', confidence: 0.2 } }, map, k), null);
  const got = J.decideDirector({ pick: { choice: 'npc:nell#0', confidence: 0.8 } }, map, k);
  assert.strictEqual(got.line, 'Nell smooths a towel.');
  assert.strictEqual(got.name, 'Nell Calder');
});

test('directRoom: SILENCE is answered, a failure is NOT — the difference the city rides on', async () => {
  await withEnv(ON, async () => {
    const silent = await J.directRoom({}, PRESENT, {
      ask: async () => ({ answers: { pick: { choice: J.REVERIE_NOBODY, confidence: 0.9 }, fresh: { noul: 0.1 } } }),
    });
    assert.deepStrictEqual({ answered: silent.answered, pick: silent.pick }, { answered: true, pick: null },
      'Jev choosing nobody is a decision and must stand');

    const dead = await J.directRoom({}, PRESENT, { ask: async () => { throw new Error('timeout 2000ms'); } });
    assert.strictEqual(dead.answered, false, 'an outage must hand the room back to the old coin flip');
    assert.strictEqual(dead.pick, null);

    const shaky = await J.directRoom({}, PRESENT, {
      ask: async () => ({ answers: { pick: { choice: 'npc:nell#0', confidence: 0.1 }, fresh: { noul: 0.1 } } }),
    });
    assert.strictEqual(shaky.answered, false, 'unsure is not silence');

    const junk = await J.directRoom({}, PRESENT, {
      ask: async () => ({ answers: { pick: { choice: 'npc:invented#3', confidence: 0.99 }, fresh: { noul: 0 } } }),
    });
    assert.strictEqual(junk.answered, false);
    assert.strictEqual(junk.pick, null);
  });
});

test('directRoom: picks a line, reports fresh, costs a fraction of a cent, never rejects', async () => {
  await withEnv(ON, async () => {
    const r = await J.directRoom(
      { place: 'pats_diner', time: '7:40 in the morning', weather: 'cold rain', justHappened: 'Kade: sits at the counter' },
      PRESENT,
      { ask: async () => ({ answers: { pick: { choice: 'npc:pat#0', confidence: 0.82 }, fresh: { noul: 0.85 } }, usage: { input_tokens: 900 } }) },
    );
    assert.strictEqual(r.answered, true);
    assert.strictEqual(r.pick.line, 'Pat calls an order through the window.');
    assert.strictEqual(r.fresh, true, 'the LLM-as-voice signal');
    assert.ok(r.costUSD > 0 && r.costUSD < 0.0001);
  });
  /* off: nothing asked, nothing answered, the old road runs */
  let asked = 0;
  const off = await withEnv({ ...ON, KADE_JEV_REVERIE: '0' }, () =>
    J.directRoom({}, PRESENT, { ask: async () => { asked++; return {}; } }),
  );
  assert.strictEqual(asked, 0);
  assert.strictEqual(off.answered, false);
  const none = await withEnv(ON, () => J.directRoom({}, [], { ask: async () => { asked++; return {}; } }));
  assert.strictEqual(asked, 0);
  assert.strictEqual(none.answered, false);
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

/* ── Part 238: the local shelf ─────────────────────────────────────────── */

test('localDestination: a kind goes between the root and the decade', () => {
  assert.strictEqual(
    J.localDestination('Video/Ozarks (Springfield Area)/1990s', 'Local Commercials'),
    'Video/Ozarks (Springfield Area)/Local Commercials/1990s',
  );
  for (const d of ['1920s', '2000s', 'Undated', 'Multiple decades']) {
    assert.strictEqual(
      J.localDestination('Video/Ozarks (Springfield Area)/' + d, 'Weather'),
      'Video/Ozarks (Springfield Area)/Weather/' + d,
      d,
    );
  }
});

test('localDestination: a SECOND run is a no-op, not a second burrowing', () => {
  /* The thing that would quietly ruin the shelf: re-running the filer and
   * getting .../Local News/Local News/1990s. The decade pattern is anchored
   * to the root, so an already-filed path simply does not match. */
  assert.strictEqual(J.localDestination('Video/Ozarks (Springfield Area)/Local News/1990s', 'Local News'), null);
  assert.strictEqual(J.localDestination('Video/Ozarks (Springfield Area)/Weather/1990s', 'Local News'), null);
  assert.strictEqual(J.localDestination('Video/Commercials/Other Commercials/1980s', 'Local News'), null);
  assert.strictEqual(J.localDestination('Video/Ozarks (Springfield Area)', 'Local News'), null);
  assert.strictEqual(J.localDestination('', 'Local News'), null);
});

test('decideLocal: the floor holds and an invented kind is refused', () => {
  const knobs = { minConfidence: 0.7 };
  assert.deepStrictEqual(J.decideLocal({ kind: { choice: 'Weather', confidence: 0.9 } }, knobs), { kind: 'Weather', confidence: 0.9 });
  assert.strictEqual(J.decideLocal({ kind: { choice: 'Weather', confidence: 0.69 } }, knobs), null);
  assert.strictEqual(J.decideLocal({ kind: { choice: 'Springfield Stuff', confidence: 1 } }, knobs), null);
  assert.strictEqual(J.decideLocal({ kind: { choice: 'Weather' } }, knobs), null);
  assert.strictEqual(J.decideLocal({}, knobs), null);
  assert.strictEqual(J.decideLocal(null, knobs), null);
});

test('localKnobs: the floor is an env var', () => {
  assert.strictEqual(withEnv({ KADE_JEV_LOCAL_MIN_CONF: undefined }, () => J.localKnobs().minConfidence), 0.7);
  assert.strictEqual(withEnv({ KADE_JEV_LOCAL_MIN_CONF: '0.85' }, () => J.localKnobs().minConfidence), 0.85);
});

test('fileLocal: reads the title, never invents a decade, and is off when the switch is off', async () => {
  const items = [
    { _id: 'a', title: 'KOLR-TV Channel 10 CBS Springfield Mo ID Back In The Winter Of 1987', path: 'Video/Ozarks (Springfield Area)/1980s', author: 'KOLR', meta: { decade: '1980s' } },
    { _id: 'b', title: 'Promo For Maury', path: 'Video/Ozarks (Springfield Area)/1990s', author: 'KOLR', meta: { decade: '1990s' } },
    { _id: 'c', title: 'a mystery', path: 'Video/Ozarks (Springfield Area)/1990s', author: 'KY3', meta: { decade: '1990s' } },
  ];
  const seen = [];
  const ask = async (state) => {
    seen.push(state);
    if (state.title.includes('ID')) return { answers: { kind: { choice: 'Station IDs & Sign-offs', confidence: 0.99 } }, usage: { input_tokens: 500 } };
    if (state.title.includes('Maury')) return { answers: { kind: { choice: 'Show Promos', confidence: 0.95 } }, usage: { input_tokens: 500 } };
    return { answers: { kind: { choice: 'Around the Ozarks', confidence: 0.4 } }, usage: { input_tokens: 500 } };
  };
  await withEnv(ON, async () => {
    const r = await J.fileLocal(items, { ask, concurrency: 1 });
    assert.strictEqual(r.moves.length, 2);
    assert.strictEqual(r.skipped.length, 1, 'the 0.40 answer stays put');
    assert.strictEqual(r.moves[0].to, 'Video/Ozarks (Springfield Area)/Station IDs & Sign-offs/1980s');
    assert.strictEqual(r.moves[1].to, 'Video/Ozarks (Springfield Area)/Show Promos/1990s');
    assert.ok(r.costUSD > 0);
    assert.deepStrictEqual(Object.keys(seen[0]).sort(), ['decade', 'station', 'title']);
    assert.strictEqual(seen[0].station, 'KOLR');
  });
  let asked = 0;
  const off = await withEnv({ ...ON, KADE_JEV_LIBRARY: '0' }, () => J.fileLocal(items, { ask: async () => { asked++; } }));
  assert.strictEqual(off.moves.length, 0);
  assert.strictEqual(off.skipped.length, 3);
  assert.strictEqual(asked, 0);
});

test('fileLocal: a thrown ask leaves the item exactly where it was', async () => {
  const items = [{ _id: 'a', title: 't', path: 'Video/Ozarks (Springfield Area)/1990s' }];
  await withEnv(ON, async () => {
    const r = await J.fileLocal(items, { ask: async () => { throw new Error('HTTP 500'); } });
    assert.strictEqual(r.moves.length, 0);
    assert.strictEqual(r.skipped.length, 1);
  });
});

/* ── Part 238: the audio shelf ─────────────────────────────────────────── */

test('audioDecade: from the year folder, then the title, never from Jev', () => {
  assert.strictEqual(J.audioDecade({ path: './old radio ads from 90s 2000s/2005', title: "Visa - 'Chicas'" }), '2000s');
  assert.strictEqual(J.audioDecade({ path: './old radio ads from 90s 2000s/1987', title: 'x' }), '1980s');
  assert.strictEqual(J.audioDecade({ path: './old radio ads/airchecks', title: 'KWTO FM 98 7 Rock99 Springfield MO August 2 1985' }), '1980s');
  assert.strictEqual(J.audioDecade({ path: './old radio ads/mountain dew', title: 'Mountain Dew spot' }), 'Undated');
  assert.strictEqual(J.audioDecade({}), 'Undated');
});

test('audioGame: the game is the folder up to the first dash', () => {
  assert.strictEqual(J.audioGame({ path: './x/Grand Theft Auto IV - Commercials' }), 'Grand Theft Auto IV');
  assert.strictEqual(J.audioGame({ path: './x/Grand Theft Auto IV - LibertyCityRadio.net - Vol. A' }), 'Grand Theft Auto IV');
  assert.strictEqual(J.audioGame({ path: './x/' }), 'Other Games');
  assert.strictEqual(J.audioGame({ path: './x/../evil' }), 'evil', 'the last segment is the folder; the dots are already spent');
  assert.strictEqual(J.audioGame({ path: './x/..' }), 'Other Games', 'a folder actually named .. cannot become a path segment');
  assert.strictEqual(J.audioGame({ path: './x/a/b' }), 'b');
  assert.strictEqual(J.audioGame({ path: './x/.hidden' }), 'Other Games', 'a name must start with a word character');
});

test('audioDestination: kind decides first, and a local advert is local before it is a category', () => {
  const knobs = { minKind: 0.7, minCategory: 0.7, minOzarks: 0.5 };
  const A = (kind, kc, oz, cat, cc) => ({
    kind: { choice: kind, confidence: kc },
    ozarks: { noul: oz },
    category: { choice: cat, confidence: cc },
  });
  const at = (folder, title) => ({ path: './old radio ads from 90s 2000s/' + folder, title: title || 'x' });

  assert.strictEqual(
    J.audioDestination(at('Grand Theft Auto IV - Commercials'), A('Video Game Radio', 0.95, 0.01, 'Medicine & Pharmacy', 0.9), knobs),
    'Audio/Video Game Radio/Grand Theft Auto IV',
    'a game spoof never lands beside real radio',
  );
  assert.strictEqual(
    J.audioDestination(at('airchecks', 'KTTS-FM, Springfield, MO, Station I.D'), A('Aircheck', 0.99, 0.98, 'Phone & Wireless', 0.8), knobs),
    'Audio/Ozarks (Springfield Area)/Radio Airchecks/Undated',
  );
  assert.strictEqual(
    J.audioDestination(at('airchecks', 'WLS Chicago ID'), A('Aircheck', 0.99, 0.02, 'Phone & Wireless', 0.8), knobs),
    'Audio/Radio Airchecks/Undated',
  );
  assert.strictEqual(
    J.audioDestination(at('2005'), A('Radio Commercial', 0.95, 0.9, 'Cars and Trucks', 0.95), knobs),
    'Audio/Ozarks (Springfield Area)/Radio Commercials/2000s',
    'a Springfield car dealer belongs with her local material, not under Cars and Trucks',
  );
  assert.strictEqual(
    J.audioDestination(at('2005'), A('Radio Commercial', 0.95, 0.02, 'Cars and Trucks', 0.95), knobs),
    'Audio/Radio Commercials/Cars and Trucks/2000s',
  );
  assert.strictEqual(
    J.audioDestination(at('2005'), A('Radio Commercial', 0.95, 0.02, 'Cars and Trucks', 0.4), knobs),
    'Audio/Radio Commercials/Other Commercials/2000s',
    'an unshelvable advert still leaves the drop folder and still gets its decade',
  );
  assert.strictEqual(J.audioDestination(at('2005'), A('Other Audio', 0.95, 0.02, 'x', 0.9), knobs), null);
  assert.strictEqual(J.audioDestination(at('2005'), A('Radio Commercial', 0.5, 0.02, 'Cars and Trucks', 0.95), knobs), null, 'the kind floor');
  assert.strictEqual(J.audioDestination(at('2005'), A('Invented Kind', 0.99, 0.02, 'Cars and Trucks', 0.95), knobs), null);
  assert.strictEqual(J.audioDestination(at('2005'), null, knobs), null);
});

test('audioDestination: a missing ozarks answer reads as not local rather than throwing', () => {
  const knobs = { minKind: 0.7, minCategory: 0.7, minOzarks: 0.5 };
  assert.strictEqual(
    J.audioDestination(
      { path: './drop/2005', title: 'x' },
      { kind: { choice: 'Radio Commercial', confidence: 0.9 }, category: { choice: 'Tobacco', confidence: 0.9 } },
      knobs,
    ),
    'Audio/Radio Commercials/Tobacco/2000s',
  );
});

test('fileAudio: asks all three questions in one call and is off when the switch is off', async () => {
  const items = [{ _id: 'a', title: "Folgers - 'Checkout Commotion'", path: './old radio ads from 90s 2000s/2007' }];
  let seenQ = null;
  let seenState = null;
  const ask = async (state, questions) => {
    seenQ = Object.keys(questions).sort();
    seenState = state;
    return {
      answers: { kind: { choice: 'Radio Commercial', confidence: 0.98 }, ozarks: { noul: 0.02 }, category: { choice: 'Drinks (Non-Alcoholic)', confidence: 0.92 } },
      usage: { input_tokens: 2400 },
    };
  };
  await withEnv(ON, async () => {
    const r = await J.fileAudio(items, { ask });
    assert.deepStrictEqual(seenQ, ['category', 'kind', 'ozarks'], 'one call, three questions');
    assert.deepStrictEqual(seenState, { title: "Folgers - 'Checkout Commotion'", folder: '2007' });
    assert.strictEqual(r.moves.length, 1);
    assert.strictEqual(r.moves[0].to, 'Audio/Radio Commercials/Drinks (Non-Alcoholic)/2000s');
    assert.strictEqual(r.moves[0].from, './old radio ads from 90s 2000s/2007');
  });
  let asked = 0;
  const off = await withEnv({ ...ON, KADE_JEV_LIBRARY: '0' }, () => J.fileAudio(items, { ask: async () => { asked++; } }));
  assert.strictEqual(off.moves.length, 0);
  assert.strictEqual(asked, 0);
});

test('the local and audio questions are shaped the way kadeJev demands', () => {
  for (const q of [J.LOCAL_KIND_Q, J.AUDIO_KIND_Q]) {
    assert.strictEqual(q.type, 'choice');
    assert.ok(q.instructions.length > 80);
    assert.ok(Object.keys(q.criteria).length >= 4);
    for (const v of Object.values(q.criteria)) assert.strictEqual(typeof v, 'string');
  }
  assert.strictEqual(J.OZARKS_Q.type, 'noul');
  assert.deepStrictEqual(Object.keys(J.OZARKS_Q.criteria).sort(), ['false', 'true']);
  /* Every kind Jev may answer has to be a folder name that is safe to paste
   * into a path — no slashes, no dot segments. */
  for (const k of [...Object.keys(J.LOCAL_KIND_CRITERIA), ...Object.keys(J.AUDIO_KIND_CRITERIA)]) {
    assert.ok(!k.includes('/') && !k.includes('\\') && k !== '..' && k.trim() === k, k);
  }
});

/* ── Part 238: the lyric tells ─────────────────────────────────────────── */

const DRAFT = [
  'Title: Route D',
  'Music: slow country, brushes',
  '',
  'Lyrics:',
  '[Verse 1]',
  'I scrubbed the truck bed clean and drove it to your mother',
  'The weight of everything we never said',
  'You texted me while I was still in the parkin lot',
  '',
  '[Chorus]',
  'I scrubbed the truck bed clean and drove it to your mother',
  'READBACK: Route D',
].join('\n');

test('lyricLines: below the heading, no tags, no READBACK, each line once', () => {
  assert.deepStrictEqual(J.lyricLines(DRAFT), [
    'I scrubbed the truck bed clean and drove it to your mother',
    'The weight of everything we never said',
    'You texted me while I was still in the parkin lot',
  ]);
  assert.deepStrictEqual(J.lyricLines('no heading here'), []);
  assert.deepStrictEqual(J.lyricLines(''), []);
  assert.deepStrictEqual(J.lyricLines(null), []);
});

test('refineTells: a veto saves her line, a catch finds what the list cannot see', () => {
  const knobs = { minFlag: 0.7, maxVeto: 0.4, perSong: 80 };
  const good = 'I scrubbed the truck bed clean and drove it to your mother';
  const slop = 'The weight of everything we never said';
  const tells = [{ line: good, tell: '"clean" or "steady" as filler' }];
  const scores = new Map([[good, 0.10], [slop, 0.91]]);
  const r = J.refineTells(tells, scores, knobs);
  assert.deepStrictEqual(r.map((t) => t.line), [slop], 'the good line is saved, the stock line is caught');

  /* Each half can be had without the other. */
  assert.deepStrictEqual(J.refineTells(tells, scores, knobs, { veto: false, catchMissed: true }).map((t) => t.line), [good, slop]);
  assert.deepStrictEqual(J.refineTells(tells, scores, knobs, { veto: true, catchMissed: false }).map((t) => t.line), []);
});

test('refineTells: an unanswered line keeps exactly what the word list said', () => {
  const knobs = { minFlag: 0.7, maxVeto: 0.4, perSong: 80 };
  const line = 'coffee on the dash';
  const tells = [{ line, tell: 'coffee' }];
  /* Jev never answered for it — a timeout, a 500, a line past the cap. */
  assert.deepStrictEqual(J.refineTells(tells, new Map(), knobs), tells);
  assert.deepStrictEqual(J.refineTells(tells, new Map([[line, undefined]]), knobs), tells);
  /* And a borderline score neither vetoes nor is invented into a new flag. */
  assert.deepStrictEqual(J.refineTells([], new Map([[line, 0.55]]), knobs), []);
  assert.deepStrictEqual(J.refineTells(tells, new Map([[line, 0.55]]), knobs), tells);
});

test('refineTells: never flags the same line twice', () => {
  const knobs = { minFlag: 0.7, maxVeto: 0.4, perSong: 80 };
  const line = 'shadows and neon and whispers';
  const tells = [{ line, tell: 'neon, shadows, whispers or echoes' }];
  const r = J.refineTells(tells, new Map([[line, 0.95]]), knobs);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].tell, 'neon, shadows, whispers or echoes', 'the list keeps its own wording');
});

test('lyricTellsJev: off means the word list is handed straight back, unasked', async () => {
  const tells = [{ line: 'x', tell: 'coffee' }];
  let asked = 0;
  const r = await withEnv({ ...ON, KADE_JEV_LYRIC_VETO: '0', KADE_JEV_LYRIC_CATCH: '0' }, () =>
    J.lyricTellsJev(DRAFT, tells, { ask: async () => { asked++; } }),
  );
  assert.strictEqual(r.tells, tells, 'the very same array');
  assert.strictEqual(asked, 0);
  assert.strictEqual(r.costUSD, 0);
});

test('lyricTellsJev: a total Jev failure changes nothing at all', async () => {
  const good = 'I scrubbed the truck bed clean and drove it to your mother';
  const tells = [{ line: good, tell: '"clean" or "steady" as filler' }];
  await withEnv(ON, async () => {
    const r = await J.lyricTellsJev(DRAFT, tells, { ask: async () => { throw new Error('HTTP 500'); } });
    assert.deepStrictEqual(r.tells, tells, 'the flag stands when Jev cannot answer');
    assert.strictEqual(r.scores.size, 0);
  });
});

test('lyricTellsJev: asks the flagged lines first, so a cap never costs a veto', async () => {
  const good = 'I scrubbed the truck bed clean and drove it to your mother';
  const order = [];
  await withEnv({ ...ON, KADE_JEV_LYRIC_MAX_LINES: '1' }, async () => {
    const r = await J.lyricTellsJev(DRAFT, [{ line: good, tell: 'filler' }], {
      ask: async (state) => {
        order.push(state.line);
        return { answers: { stock: { noul: 0.05 } }, usage: { input_tokens: 300 } };
      },
      concurrency: 1,
    });
    assert.deepStrictEqual(order, [good], 'the one question it could afford went to the flagged line');
    assert.deepStrictEqual(r.tells, [], 'and it bought back her line');
  });
});

test('lyricTellsJev: the real shape end to end', async () => {
  const good = 'I scrubbed the truck bed clean and drove it to your mother';
  const slop = 'The weight of everything we never said';
  await withEnv(ON, async () => {
    const r = await J.lyricTellsJev(DRAFT, [{ line: good, tell: '"clean" or "steady" as filler' }], {
      ask: async (state) => ({
        answers: { stock: { noul: state.line === slop ? 0.91 : 0.12 } },
        usage: { input_tokens: 300 },
      }),
    });
    assert.deepStrictEqual(r.tells.map((t) => t.line), [slop]);
    assert.strictEqual(r.asked, 3);
    assert.ok(r.costUSD > 0);
  });
});

test('lyricTellsLog: counts what was saved and what was caught', () => {
  const lines = [];
  const before = [{ line: 'a', tell: 'x' }, { line: 'b', tell: 'y' }];
  const after = [{ line: 'b', tell: 'y' }, { line: 'c', tell: 'z' }];
  const r = J.lyricTellsLog(before, after, { asked: 9, costUSD: 0.00012, log: (m) => lines.push(m) });
  assert.deepStrictEqual(r, { saved: 1, caught: 1 });
  assert.deepStrictEqual(lines, ['[kadeJev][lyric-tells] lines=9 list=2 jev=2 saved=1 caught=1 $0.00012']);
});

/* ── Part 238: the frame filer's decision ──────────────────────────────── */

test('decideAdFromFrame: the eye is handed to the same floor as the text filer', async () => {
  const item = { title: 'Tegrin ad, 1969', path: 'Video/Commercials/Other Commercials/1960s' };
  let seenState = null;
  const ask = async (state) => {
    seenState = state;
    return { answers: { category: { choice: 'Health & Beauty', confidence: 0.93 } }, usage: { input_tokens: 700 } };
  };
  await withEnv(ON, async () => {
    const r = await J.decideAdFromFrame(item, 'Tegrin medicated shampoo, tube and box', { ask });
    assert.strictEqual(r.category, 'Health & Beauty');
    assert.ok(r.costUSD > 0);
    /* The decade still comes off the path and is never invented. */
    assert.deepStrictEqual(seenState, {
      title: 'Tegrin ad, 1969',
      decade: '1960s',
      seen: 'Tegrin medicated shampoo, tube and box',
    });
  });
});

test('decideAdFromFrame: under the floor, an invented shelf, or a throw — nothing moves', async () => {
  const item = { title: 'x ad', path: 'Video/Commercials/Other Commercials/1970s' };
  await withEnv(ON, async () => {
    const low = await J.decideAdFromFrame(item, 'a crowd of people', {
      ask: async () => ({ answers: { category: { choice: 'Tobacco', confidence: 0.55 } }, usage: { input_tokens: 700 } }),
    });
    assert.strictEqual(low.category, null);
    assert.strictEqual(low.confidence, 0.55, 'the score is reported even when it loses');

    const bogus = await J.decideAdFromFrame(item, 'x', {
      ask: async () => ({ answers: { category: { choice: 'Shampoo Aisle', confidence: 0.99 } }, usage: { input_tokens: 700 } }),
    });
    assert.strictEqual(bogus.category, null, 'a shelf the library does not have is refused');

    const boom = await J.decideAdFromFrame(item, 'x', { ask: async () => { throw new Error('HTTP 500'); } });
    assert.deepStrictEqual(boom, { category: null, costUSD: 0 });
  });
});

test('decideAdFromFrame: the floor is the ads floor, not a second one', async () => {
  const item = { title: 'x ad', path: 'Video/Commercials/Other Commercials/1970s' };
  const ask = async () => ({ answers: { category: { choice: 'Tobacco', confidence: 0.75 } }, usage: { input_tokens: 700 } });
  await withEnv({ ...ON, KADE_JEV_ADS_MIN_CONF: '0.9' }, async () => {
    assert.strictEqual((await J.decideAdFromFrame(item, 'a pack of cigarettes', { ask })).category, null);
  });
  await withEnv({ ...ON, KADE_JEV_ADS_MIN_CONF: undefined }, async () => {
    assert.strictEqual((await J.decideAdFromFrame(item, 'a pack of cigarettes', { ask })).category, 'Tobacco');
  });
});

test('AD_FRAME_Q offers exactly the shelves the library already has', () => {
  assert.strictEqual(J.AD_FRAME_Q.type, 'choice');
  assert.strictEqual(J.AD_FRAME_Q.criteria, J.AD_CATEGORY_CRITERIA, 'one list of shelves, not two that can drift');
  assert.ok(/\bseen\b/.test(J.AD_FRAME_Q.instructions), 'the question has to mention the field it is given');
});

/* ── Part 239: the ideas she approved ──────────────────────────────────── */

test('sameIdea: reports the repeat, is off when the switch is off, survives a failure', async () => {
  const seen = ['a man waits in a parking lot', 'two sisters clean out a house'];
  const ask = async (state) => ({
    answers: { same: { noul: state.other.includes('parking lot') ? 0.88 : 0.04 } },
    usage: { input_tokens: 400 },
  });
  await withEnv({ ...ON, KADE_JEV_IDEA_SAME: undefined }, async () => {
    const hit = await J.sameIdea('a woman sits in a driveway and never goes in', seen, { ask, concurrency: 1 });
    assert.ok(hit);
    assert.strictEqual(hit.other, 'a man waits in a parking lot');
    assert.ok(hit.p >= 0.7);

    const miss = await J.sameIdea('x', seen, {
      ask: async () => ({ answers: { same: { noul: 0.2 } }, usage: {} }),
      concurrency: 1,
    });
    assert.strictEqual(miss, null);

    /* Every comparison throwing must read as "not a repeat", so the draw
     * stands — which is exactly what the word-run check already said. */
    assert.strictEqual(await J.sameIdea('x', seen, { ask: async () => { throw new Error('HTTP 500'); } }), null);
    assert.strictEqual(await J.sameIdea('x', [], { ask }), null, 'nothing to compare against');
    assert.strictEqual(await J.sameIdea('', seen, { ask }), null);
  });
  let asked = 0;
  const off = await withEnv({ ...ON, KADE_JEV_IDEA_SAME: '0' }, () => J.sameIdea('x', seen, { ask: async () => { asked++; } }));
  assert.strictEqual(off, null);
  assert.strictEqual(asked, 0);
});

test('sameIdea: only the newest handful are compared', async () => {
  const seen = Array.from({ length: 60 }, (_, i) => 'idea ' + i);
  const looked = [];
  await withEnv(ON, async () => {
    await J.sameIdea('x', seen, {
      ask: async (state) => { looked.push(state.other); return { answers: { same: { noul: 0.01 } }, usage: {} }; },
      concurrency: 1,
    });
  });
  assert.strictEqual(looked.length, 24, 'capped by KADE_JEV_IDEA_MAX_COMPARE');
  assert.strictEqual(looked[0], 'idea 59', 'newest first — a session\'s own draws are what a person notices');
});

test('reportText: reads the schema the board actually writes', () => {
  assert.strictEqual(
    J.reportText({ category: 'bug', subject: 'Rhett is under the women', detail: 'He sounds like a man to me.' }),
    'bug — Rhett is under the women — He sounds like a man to me.',
  );
  assert.strictEqual(J.reportText({ subject: 'only a subject' }), 'only a subject');
  assert.strictEqual(J.reportText({}), '');
  assert.strictEqual(J.reportText(null), '');
});

test('sameReports: names the newer row first and reports each pair once', async () => {
  const rows = [
    { _id: 'new', category: 'feedback', subject: 'Voice in the wrong section: Rhett', detail: 'Rhett' },
    { _id: 'old', category: 'bug', subject: 'Rhett is under the women', detail: 'I went to pick a voice.' },
    { _id: 'other', category: 'bug', subject: 'Sound Booth will not load', detail: 'spins forever' },
  ];
  const ask = async (state) => ({
    answers: { same: { noul: /Rhett/.test(state.report) && /Rhett/.test(state.other) ? 0.95 : 0.03 } },
    usage: {},
  });
  await withEnv(ON, async () => {
    const out = await J.sameReports(rows, { ask, concurrency: 1 });
    assert.strictEqual(out.length, 1, 'one pair, not two');
    assert.deepStrictEqual(out[0], { id: 'new', twinId: 'old', p: 0.95 });
  });
  let asked = 0;
  const off = await withEnv({ ...ON, KADE_JEV_FEEDBACK_TWINS: '0' }, () => J.sameReports(rows, { ask: async () => { asked++; } }));
  assert.deepStrictEqual(off, []);
  assert.strictEqual(asked, 0);
});

test('readSpine: counts, never decides, and an unread moment is counted neither way', async () => {
  const m = (replied) => ({ assistantSaid: 'a', personReplied: replied, assistantThen: 'c' });
  const ask = async (state) => ({
    answers: {
      pushback: { noul: state.person_replied === 'no' || state.person_replied === 'wrong' ? 0.9 : 0.05 },
      fold: { noul: state.person_replied === 'no' ? 0.9 : 0.05 },
    },
    usage: { input_tokens: 500 },
  });
  await withEnv(ON, async () => {
    const r = await J.readSpine([m('no'), m('wrong'), m('thanks')], { ask, concurrency: 1 });
    assert.deepStrictEqual(
      { pushbacks: r.pushbacks, folded: r.folded, held: r.held, read: r.read },
      { pushbacks: 2, folded: 1, held: 1, read: 3 },
    );
    assert.ok(r.costUSD > 0);

    const broke = await J.readSpine([m('no'), m('wrong')], { ask: async () => { throw new Error('nope'); } });
    assert.deepStrictEqual(
      { pushbacks: broke.pushbacks, folded: broke.folded, held: broke.held, read: broke.read },
      { pushbacks: 0, folded: 0, held: 0, read: 0 },
    );
  });
  const off = await withEnv({ ...ON, KADE_JEV_SPINE: '0' }, () => J.readSpine([m('no')], { ask }));
  assert.strictEqual(off.off, true);
  assert.strictEqual(off.pushbacks, 0);
});

test('toolsToAdd: adds above the floor, never touches what is already kept', () => {
  const knobs = { minAdd: 0.8, timeoutMs: 1200 };
  const keep = new Set(['kade_weather']);
  assert.deepStrictEqual(
    J.toolsToAdd({ web_search: 0.96, kade_news: 0.81, kade_weather: 0.99, kade_notify: 0.5 }, keep, knobs),
    ['kade_news', 'web_search'],
    'kade_weather is already kept; kade_notify is under the floor',
  );
  assert.deepStrictEqual(J.toolsToAdd({}, keep, knobs), []);
  assert.deepStrictEqual(J.toolsToAdd({ x: 0.79 }, keep, knobs), [], 'the floor is the floor');
  assert.deepStrictEqual(J.toolsToAdd({ x: undefined, y: null }, keep, knobs), []);
  /* The trial's numbers, as a guard: the highest UNNEEDED reading was 0.50
   * and the lowest needed was 0.87. Both must stay on their own side. */
  assert.deepStrictEqual(J.toolsToAdd({ needed: 0.87, unneeded: 0.5 }, new Set(), knobs), ['needed']);
});

test('toolsAdd: ADDS and never removes, and a failure leaves the selection alone', async () => {
  const keep = new Set(['kade_weather']);
  const before = [...keep];
  const lines = [];
  const ask = async (state, questions) => {
    const answers = {};
    for (const k of Object.keys(questions)) answers[k] = { noul: k === 'web_search' ? 0.96 : 0.02 };
    return { answers };
  };
  await withEnv(ON, async () => {
    const added = await J.toolsAdd({ text: 'whats the news looking like tonight', tools: ['web_search', 'kade_news', 'kade_weather'], keep, log: (l) => lines.push(l) }, { ask });
    assert.deepStrictEqual(added, ['web_search']);
    assert.ok(keep.has('web_search'));
    assert.ok(keep.has('kade_weather'), 'what was kept is still kept');
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].startsWith('[kadeJev][tools-add] added=[web_search]'));

    const keep2 = new Set(before);
    assert.deepStrictEqual(await J.toolsAdd({ text: 'hi', tools: ['web_search'], keep: keep2 }, { ask: async () => { throw new Error('HTTP 500'); } }), []);
    assert.deepStrictEqual([...keep2], before, 'a failure changes nothing');

    assert.deepStrictEqual(await J.toolsAdd({ text: '', tools: ['web_search'], keep: keep2 }, { ask }), []);
    assert.deepStrictEqual(await J.toolsAdd({ text: 'x', tools: ['not_a_known_tool'], keep: keep2 }, { ask }), []);
  });
  let asked = 0;
  const keep3 = new Set(before);
  const off = await withEnv({ ...ON, KADE_JEV_TOOLS_ADD: '0' }, () => J.toolsAdd({ text: 'news?', tools: ['web_search'], keep: keep3 }, { ask: async () => { asked++; } }));
  assert.deepStrictEqual(off, []);
  assert.strictEqual(asked, 0);
  assert.deepStrictEqual([...keep3], before);
});

test('the approved questions are shaped the way kadeJev demands', () => {
  for (const q of [J.SAME_IDEA_Q, J.SAME_REPORT_Q, J.PUSHBACK_Q, J.FOLD_Q]) {
    assert.strictEqual(q.type, 'noul');
    assert.ok(q.instructions.length > 80);
    assert.deepStrictEqual(Object.keys(q.criteria).sort(), ['false', 'true']);
  }
});

test('readVoiceFlags: counts the three flags, is off when off, and an unread reply counts for nothing', async () => {
  const replies = [
    'That is not laziness, that is your body asking for a rest.',
    'I put the bins out and the neighbour waved, so that is that.',
    'As an AI I do not have feelings about the weather.',
  ];
  const ask = async (state) => ({
    answers: {
      reframeTic: { noul: /That is not laziness/.test(state.reply) ? 0.93 : 0.04 },
      therapyPhrasing: { noul: 0.05 },
      aiSelfReference: { noul: /As an AI/.test(state.reply) ? 0.97 : 0.02 },
    },
    usage: { input_tokens: 600 },
  });
  await withEnv(ON, async () => {
    const r = await J.readVoiceFlags(replies, { ask, concurrency: 1 });
    assert.strictEqual(r.read, 3);
    assert.deepStrictEqual(r.flags, { reframeTic: 1, therapyPhrasing: 0, aiSelfReference: 1 });
    assert.ok(r.costUSD > 0);

    const broke = await J.readVoiceFlags(replies, { ask: async () => { throw new Error('HTTP 500'); } });
    assert.strictEqual(broke.read, 0);
    assert.deepStrictEqual(broke.flags, { reframeTic: 0, therapyPhrasing: 0, aiSelfReference: 0 });

    /* Too short to be a reply worth reading. */
    const tiny = await J.readVoiceFlags(['ok', '', null], { ask });
    assert.strictEqual(tiny.read, 0);
  });
  let asked = 0;
  const off = await withEnv({ ...ON, KADE_JEV_VOICE_FLAGS: '0' }, () => J.readVoiceFlags(replies, { ask: async () => { asked++; } }));
  assert.strictEqual(off.off, true);
  assert.strictEqual(asked, 0);
});

test('readVoiceFlags: the cap holds and the questions are shaped right', async () => {
  const many = Array.from({ length: 300 }, (_, i) => 'a reply long enough to be worth reading number ' + i);
  let asked = 0;
  await withEnv(ON, async () => {
    await J.readVoiceFlags(many, {
      ask: async () => { asked++; return { answers: { reframeTic: { noul: 0 }, therapyPhrasing: { noul: 0 }, aiSelfReference: { noul: 0 } }, usage: {} }; },
      concurrency: 2,
    });
  });
  assert.strictEqual(asked, 120, 'KADE_JEV_VOICE_FLAG_MAX');
  for (const q of Object.values(J.VOICE_FLAG_QS)) {
    assert.strictEqual(q.type, 'noul');
    assert.deepStrictEqual(Object.keys(q.criteria).sort(), ['false', 'true']);
  }
});

test('sameReports: the window keeps a long board from becoming every pair', async () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ _id: 'r' + i, subject: 'report ' + i, detail: 'detail ' + i }));
  let asked = 0;
  await withEnv(ON, async () => {
    await J.sameReports(rows, {
      ask: async () => { asked++; return { answers: { same: { noul: 0.01 } } }; },
      concurrency: 2,
    });
  });
  /* 40 rows, a window of 8: 8 comparisons each until the tail runs out. */
  assert.strictEqual(asked, 8 * 40 - (8 * 9) / 2, 'window, not 780 pairs');
  asked = 0;
  await withEnv({ ...ON, KADE_JEV_FEEDBACK_WINDOW: '2' }, async () => {
    await J.sameReports(rows.slice(0, 5), { ask: async () => { asked++; return { answers: { same: { noul: 0.01 } } }; }, concurrency: 1 });
  });
  assert.strictEqual(asked, 2 + 2 + 2 + 1, 'the env var moves it');
});
