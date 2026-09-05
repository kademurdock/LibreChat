/**
 * Tools-as-retrieval (Part 132). The embed function is injected, so these run
 * offline; the threshold numbers come from the live Gemini measurement on
 * Sep 5 2026 (real asks 0.64–0.74, chit-chat ≤0.55).
 */
const test = require('node:test');
const assert = require('node:assert');
const R = require('./kadeToolRetrieval.js');

const T = (names) => names.map((name) => ({ name, description: `${name} does ${name} things` }));
const KIANA = [
  'context', 'flux', 'kade_phone_call', 'kade_notify', 'kade_weather', 'kade_wikipedia', 'kade_joke',
  'kade_news', 'kade_read_page', 'kade_adventure', 'kade_games', 'kade_feedback', 'kade_code',
  'kade_help', 'kade_transcribe', 'kade_location', 'kade_memory_search', 'kade_research',
  'kade_living_memory', 'kade_errand', 'kade_council', 'kade_make_file', 'file_search', 'web_search',
  'kade_message', 'kade_call_me', 'kade_lyrics', 'kade_media',
];
/** A fake embedder: the query vector is one-hot on whichever tool name the
 *  text mentions after "@", descriptions are one-hot on their own name. */
function fakeEmbed(names) {
  const idx = new Map(names.map((n, i) => [n, i]));
  const label = (n) => n.replace(/^kade_/, '').replace(/_/g, ' ') + ':';
  return async (text) => {
    const v = new Array(names.length).fill(0);
    v[0] = 0.001; // never a zero vector
    const m = /@(\S+)/.exec(text);
    let key = m ? m[1] : null;
    if (!key) key = names.find((n) => text.startsWith(label(n)));
    if (key && idx.has(key)) v[idx.get(key)] = 1;
    return v;
  };
}

test('no text → everything rides (regenerate / edit safety)', async () => {
  R._resetForTests();
  const r = await R.selectTools({ tools: T(KIANA), text: '', agentId: 'a', conversationId: 'c1' });
  assert.strictEqual(r.dropped.length, 0);
  assert.strictEqual(r.reason, 'no-text');
});

test('kill switch keeps the old behaviour byte for byte', async () => {
  R._resetForTests();
  process.env.KADE_TOOLS_RAG = '0';
  const r = await R.selectTools({ tools: T(KIANA), text: 'tell me a joke', agentId: 'a' });
  delete process.env.KADE_TOOLS_RAG;
  assert.strictEqual(r.dropped.length, 0);
});

test('an agent with action tools (Forge) is never filtered', async () => {
  R._resetForTests();
  const r = await R.selectTools({
    tools: T([...KIANA, 'getServiceStatus_action_aW53b3JsZC']),
    text: 'hey', agentId: 'forge', embed: fakeEmbed(KIANA),
  });
  assert.strictEqual(r.reason, 'has-actions');
  assert.strictEqual(r.dropped.length, 0);
});

test('a plain companion turn rides core only', async () => {
  R._resetForTests();
  const r = await R.selectTools({
    tools: T(KIANA), text: 'ugh work was rough today and my back hurts',
    agentId: 'a', conversationId: 'c2', embed: fakeEmbed(KIANA),
  });
  assert.deepStrictEqual([...r.keep].sort(), [...R.DEFAULT_CORE].sort());
  assert.ok(r.dropped.includes('web_search'));
  assert.ok(r.dropped.includes('kade_phone_call'));
});

test('keywords pull the obvious tool; embedding pulls by meaning; both stick', async () => {
  R._resetForTests();
  const embed = fakeEmbed(KIANA);
  let r = await R.selectTools({ tools: T(KIANA), text: 'call my mom for me', agentId: 'a', conversationId: 'c3', embed });
  assert.ok(r.keep.has('kade_phone_call'), 'keyword: phone call');
  assert.ok(!r.keep.has('kade_joke'));
  r = await R.selectTools({ tools: T(KIANA), text: 'something @kade_lyrics shaped', agentId: 'a', conversationId: 'c3', embed });
  assert.ok(r.keep.has('kade_lyrics'), 'embedding: lyrics');
  assert.ok(r.keep.has('kade_phone_call'), 'sticky: phone call from the earlier turn');
  r = await R.selectTools({ tools: T(KIANA), text: 'night night', agentId: 'a', conversationId: 'c3', embed });
  assert.ok(r.keep.has('kade_phone_call') && r.keep.has('kade_lyrics'), 'sticky survives a quiet turn');
  const r4 = await R.selectTools({ tools: T(KIANA), text: 'night night', agentId: 'a', conversationId: 'OTHER', embed });
  assert.ok(!r4.keep.has('kade_phone_call'), 'sticky is per conversation');
});

test('embedding floor: a weak best match does not attach', async () => {
  R._resetForTests();
  const embed = async () => new Array(KIANA.length).fill(0.3); // everything equally meh, cos≈1... so use env floor above 1
  process.env.KADE_TOOLS_MIN_SCORE = '1.5';
  const r = await R.selectTools({ tools: T(KIANA), text: 'hmm okay', agentId: 'a', conversationId: 'c5', embed });
  delete process.env.KADE_TOOLS_MIN_SCORE;
  assert.deepStrictEqual([...r.keep].sort(), [...R.DEFAULT_CORE].sort());
});

test('embed lane down + no keyword → the full set rides (fail toward the old behaviour)', async () => {
  R._resetForTests();
  const r = await R.selectTools({ tools: T(KIANA), text: 'how are you feeling', agentId: 'a', conversationId: 'c6', embed: async () => null });
  assert.strictEqual(r.reason, 'embed-down');
  assert.strictEqual(r.dropped.length, 0);
});

test('embed lane down + keyword → keyword tool rides, rest deferred', async () => {
  R._resetForTests();
  const r = await R.selectTools({ tools: T(KIANA), text: 'tell me a joke', agentId: 'a', conversationId: 'c7', embed: async () => null });
  assert.ok(r.keep.has('kade_joke'));
  assert.ok(r.dropped.includes('web_search'));
});

test('files on the turn keep file_search attached', async () => {
  R._resetForTests();
  const r = await R.selectTools({ tools: T(KIANA), text: 'what do you think', agentId: 'a', conversationId: 'c8', hasFiles: true, embed: fakeEmbed(KIANA) });
  assert.ok(r.keep.has('file_search'));
});

test('applySelection filters tools and strips web_search context when dropped', () => {
  const keep = new Set(['context', 'kade_joke']);
  const result = {
    tools: T(['context', 'kade_joke', 'web_search', 'flux']),
    toolContextMap: { web_search: 'big block' },
    dynamicToolContextMap: { web_search: 'runtime ctx' },
    toolDefinitions: [],
  };
  const dropped = R.applySelection(result, keep);
  assert.deepStrictEqual(dropped, ['web_search', 'flux']);
  assert.deepStrictEqual(result.tools.map((t) => t.name), ['context', 'kade_joke']);
  assert.strictEqual(result.toolContextMap.web_search, undefined);
  assert.strictEqual(result.dynamicToolContextMap.web_search, undefined);
});

test('keyword aliases: the asks a friend actually types', () => {
  const all = Object.keys(R.ALIASES);
  const cases = [
    ["what's the weather doing in Springfield", 'kade_weather'],
    ['tell me a dad joke', 'kade_joke'],
    ['can you call my mom', 'kade_phone_call'],
    ["what's in the news", 'kade_news'],
    ['play blackjack with me', 'kade_games'],
    ['pull up the lyrics to gethsemane', 'kade_lyrics'],
    ['read this https://example.com/story', 'kade_read_page'],
    ['tell Skylee I said happy birthday', 'kade_message'],
    ['remind me at 8 to take my meds', 'kade_notify'],
    ['draw me a cozy cabin', 'flux'],
    ['look up how much a 2024 corolla costs', 'web_search'],
    ['really dig into whether solar pays off', 'kade_research'],
    ['where am i right now', 'kade_location'],
    ['make me a spreadsheet of my bills', 'kade_make_file'],
    ['continue my dungeon adventure', 'kade_adventure'],
    ['describe this youtube video https://youtube.com/watch?v=x', 'kade_media'],
    ['run some python for the date 90 days out', 'kade_code'],
    ["what's 17% of 240", 'calculator'],
    ['the voice cut out on my call, tell Kade', 'kade_feedback'],
  ];
  for (const [text, want] of cases) {
    assert.ok(R.keywordHits(text, all).has(want), `${text} → ${want}`);
  }
  for (const quiet of ['ugh work was rough', 'my dog died yesterday', 'lol', 'what do you think about tuesdays', "i'm bored"]) {
    const hits = R.keywordHits(quiet, all);
    assert.strictEqual(hits.size, 0, `${quiet} should match nothing, got ${[...hits]}`);
  }
});

test('memoEmbed: one embed per text per request, shared with recall', async () => {
  let calls = 0;
  const req = {};
  const e = R.memoEmbed(req, async () => { calls += 1; return [1, 2]; });
  await Promise.all([e('hello'), e('hello'), e('hello')]);
  await e('hello');
  assert.strictEqual(calls, 1);
  await e('other');
  assert.strictEqual(calls, 2);
});

test('applySelection in event-driven mode filters toolDefinitions, leaves the registry whole', () => {
  const keep = new Set(['context', 'kade_joke']);
  const defs = (names) => names.map((name) => ({ name, description: 'd', parameters: {} }));
  const registry = new Map([['web_search', {}], ['kade_joke', {}], ['flux', {}], ['tool_search', {}]]);
  const result = {
    toolDefinitions: defs(['context', 'kade_joke', 'web_search', 'flux', 'tool_search']),
    toolRegistry: registry,
    toolContextMap: { web_search: 'big block' },
    dynamicToolContextMap: { web_search: 'runtime' },
  };
  const dropped = R.applySelection(result, keep);
  assert.deepStrictEqual(dropped.sort(), ['flux', 'web_search']);
  assert.deepStrictEqual(result.toolDefinitions.map((d) => d.name), ['context', 'kade_joke', 'tool_search']);
  assert.strictEqual(result.toolRegistry.size, 4, 'registry untouched so execution by name still resolves');
  assert.strictEqual(result.toolContextMap.web_search, undefined);
});
