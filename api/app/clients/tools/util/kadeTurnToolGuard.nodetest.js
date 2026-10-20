'use strict';
/* KADE Oct 20 2026: the search loop guard. Tavily ran past its plan and answered every web_search
 * with 432; Kiana searched again and again (3,835 calls in one of Amber's turns) until the
 * recursion limit ended the turn. Wikipedia answered her parallel lookups with 429.
 * A quota answer is final for the turn, and each turn has a cap.
 * Run: node --test api/app/clients/tools/util/kadeTurnToolGuard.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const G = require('./kadeTurnToolGuard');

const TAVILY_432 = 'Tavily API request failed: Request failed with status code 432';

/** A stand-in for the agents library's web_search tool: content_and_artifact, errors in the artifact. */
function fakeSearchTool(answer) {
  const tool = {
    name: 'web_search',
    calls: 0,
    async _call(args) {
      tool.calls += 1;
      return answer(args, tool.calls);
    },
  };
  return tool;
}
const ok = (q) => [`results for ${q.query}`, { web_search: { organic: [{ link: 'https://x' }] } }];
const failed = (error) => () => ['', { web_search: { organic: [], error } }];

test('quota answers are recognised; ordinary failures are not', () => {
  for (const e of [
    TAVILY_432,
    'Request failed with status code 429',
    'Tavily API request failed: Request failed with status code 433',
    'HTTP 402 Payment Required',
    'You have exceeded your monthly plan limit',
    'Rate limit reached for requests',
    'Too Many Requests',
    429,
    { response: { status: 432 } },
    { status: 429, message: 'x' },
  ]) {
    assert.equal(G.isProviderQuotaError(e), true, JSON.stringify(e));
  }
  for (const e of ['Request failed with status code 500', 'timeout of 10000ms exceeded', 'getaddrinfo ENOTFOUND', 404, null, undefined, '']) {
    assert.equal(G.isProviderQuotaError(e), false, JSON.stringify(e));
  }
});

test('web_search: a 432 is final for the turn; nothing more is sent to Tavily', async () => {
  const req = {};
  const tool = G.guardWebSearchTool(fakeSearchTool(failed(TAVILY_432)), { req });
  const first = await tool._call({ query: 'a' });
  assert.deepEqual(first, [G.UNAVAILABLE.web_search, undefined]);
  assert.equal(first[0], 'Web search is unavailable right now; answer from what you already know.');
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(await tool._call({ query: `again ${i}` }), [G.UNAVAILABLE.web_search, undefined]);
  }
  assert.equal(tool.calls, 1, 'only the first call reached the provider');
});

test('web_search: the turn is the request, so a new tool built for the next round of the same turn still refuses', async () => {
  const req = {};
  const roundOne = G.guardWebSearchTool(fakeSearchTool(failed('Request failed with status code 429')), { req });
  await roundOne._call({ query: 'a' });
  const roundTwo = G.guardWebSearchTool(fakeSearchTool(ok), { req });
  assert.deepEqual(await roundTwo._call({ query: 'b' }), [G.UNAVAILABLE.web_search, undefined]);
  assert.equal(roundTwo.calls, 0);
  /* The next turn (a new request) may search again. */
  const nextTurn = G.guardWebSearchTool(fakeSearchTool(ok), { req: {} });
  assert.deepEqual(await nextTurn._call({ query: 'c' }), ok({ query: 'c' }));
});

test('web_search: at most 6 searches a turn, parallel calls included', async () => {
  const req = {};
  const tool = G.guardWebSearchTool(fakeSearchTool(ok), { req });
  const answers = await Promise.all(Array.from({ length: 10 }, (_, i) => tool._call({ query: `q${i}` })));
  assert.equal(tool.calls, 6);
  assert.equal(answers.filter((a) => a[1] && a[1].web_search).length, 6);
  const refused = answers.filter((a) => !a[1]);
  assert.equal(refused.length, 4);
  assert.match(refused[0][0], /already used web search 6 times for this reply/);
  /* A second tool for the same turn is capped too. */
  const later = G.guardWebSearchTool(fakeSearchTool(ok), { req });
  assert.match((await later._call({ query: 'x' }))[0], /limit/);
  assert.equal(later.calls, 0);
});

test('web_search: an ordinary failure passes through and still counts toward the cap', async () => {
  const req = {};
  const tool = G.guardWebSearchTool(fakeSearchTool(failed('Request failed with status code 500')), { req });
  const out = await tool._call({ query: 'a' });
  assert.equal(out[1].web_search.error, 'Request failed with status code 500');
  assert.deepEqual(G.peek(req, 'web_search'), { calls: 1, unavailable: false });
});

test('caps follow the environment when set to a positive whole number', () => {
  assert.equal(G.capFor('web_search', {}), 6);
  assert.equal(G.capFor('kade_wikipedia', {}), 8);
  assert.equal(G.capFor('web_search', { KADE_WEB_SEARCH_TURN_CAP: '3' }), 3);
  assert.equal(G.capFor('kade_wikipedia', { KADE_WIKIPEDIA_TURN_CAP: '0' }), 8);
  assert.equal(G.capFor('kade_wikipedia', { KADE_WIKIPEDIA_TURN_CAP: 'x' }), 8);
});

test('guarding twice wraps once; a tool without _call is left alone', async () => {
  const req = {};
  const tool = G.guardWebSearchTool(G.guardWebSearchTool(fakeSearchTool(ok), { req }), { req });
  await tool._call({ query: 'a' });
  assert.equal(G.peek(req, 'web_search').calls, 1);
  const odd = { name: 'web_search' };
  assert.equal(G.guardWebSearchTool(odd, { req }), odd);
});

/* ---- KadeWikipedia --------------------------------------------------------------------------- */

function loadWikipedia(get) {
  const original = Module._load;
  Module._load = function (id, parent, isMain) {
    if (id === 'axios') return { get };
    if (id === '@librechat/agents/langchain/tools') return { Tool: class {} };
    if (id === '@librechat/data-schemas') return { logger: { warn() {}, info() {}, error() {} } };
    return original.call(this, id, parent, isMain);
  };
  try {
    const file = path.join(__dirname, '../structured/KadeWikipedia.js');
    delete require.cache[file];
    return require(file);
  } finally {
    Module._load = original;
  }
}

test('Wikipedia: a 429 is final for the turn, and a turn makes at most 8 lookups', async () => {
  let hits = 0;
  const KadeWikipedia = loadWikipedia(async () => {
    hits += 1;
    throw Object.assign(new Error('Request failed with status code 429'), { response: { status: 429 } });
  });
  const req = {};
  const w = new KadeWikipedia({ req });
  assert.equal(await w._call({ query: 'Ozarks' }), G.UNAVAILABLE.kade_wikipedia);
  assert.equal(await new KadeWikipedia({ req })._call({ query: 'Branson' }), G.UNAVAILABLE.kade_wikipedia);
  assert.equal(hits, 1, 'the second lookup in the same turn never reached Wikipedia');

  let ok = 0;
  const Fine = loadWikipedia(async (url) => {
    ok += 1;
    if (url.includes('/search/page')) return { data: { pages: [{ title: 'Ozarks' }] } };
    return { data: { title: 'Ozarks', extract: 'A region.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Ozarks' } } } };
  });
  const turn = {};
  const answers = [];
  for (let i = 0; i < 10; i += 1) answers.push(await new Fine({ req: turn })._call({ query: 'Ozarks' }));
  assert.equal(answers.filter((a) => a.startsWith('Ozarks: A region.')).length, 8);
  assert.match(answers[9], /already used Wikipedia 8 times for this reply/);
  assert.equal(ok, 16, 'two requests per lookup, eight lookups');
  /* Other failures keep their old wording. */
  const Down = loadWikipedia(async () => {
    throw new Error('getaddrinfo ENOTFOUND en.wikipedia.org');
  });
  assert.match(await new Down({ req: {} })._call({ query: 'x' }), /^Wikipedia lookup failed: getaddrinfo/);
});

/* ---- review: a run promised more rounds gets more lookups; the guard has a switch ------------ */

test('a background task with a step budget of 20 may search more than 6 times', async () => {
  assert.equal(G.capFor('web_search', {}, { kadeStepBudget: 20 }), 18, 'ceil(6 x 20 / 7)');
  assert.equal(G.capFor('kade_wikipedia', {}, { kadeStepBudget: 20 }), 23, 'ceil(8 x 20 / 7)');
  assert.equal(G.capFor('web_search', {}, { kadeStepBudget: 3 }), 6, 'never below the base cap');
  assert.equal(G.capFor('web_search', {}, {}), 6, 'an ordinary chat turn keeps 6');
  assert.equal(G.capFor('web_search', { KADE_WEB_SEARCH_TURN_CAP: '3' }, { kadeStepBudget: 14 }), 6, 'the env cap scales too');
  const req = { kadeStepBudget: 20 };
  const tool = G.guardWebSearchTool(fakeSearchTool(ok), { req });
  const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => tool._call({ query: `q${i}` })));
  assert.equal(tool.calls, 18);
  assert.match(answers.filter((a) => !a[1])[0][0], /already used web search 18 times/);
  /* A quota answer still ends search for the run, whatever the budget. */
  const quota = { kadeStepBudget: 40 };
  const q = G.guardWebSearchTool(fakeSearchTool(failed(TAVILY_432)), { req: quota });
  await q._call({ query: 'a' });
  assert.deepEqual(await q._call({ query: 'b' }), [G.UNAVAILABLE.web_search, undefined]);
  assert.equal(q.calls, 1);
});

test('KADE_TURN_TOOL_GUARD=0 turns the guard off: no caps, no quota stop, the tool is not wrapped', async () => {
  const env = { KADE_TURN_TOOL_GUARD: '0' };
  assert.equal(G.guardOn(env), false);
  assert.equal(G.guardOn({}), true);
  const raw = fakeSearchTool(failed(TAVILY_432));
  const original = raw._call;
  const tool = G.guardWebSearchTool(raw, { req: {}, env });
  assert.equal(tool, raw);
  assert.equal(tool._call, original, 'left unwrapped');
  const req = {};
  for (let i = 0; i < 12; i += 1) assert.deepEqual(G.beginCall(req, 'web_search', env), { ok: true });
  G.markUnavailable(req, 'web_search');
  assert.deepEqual(G.beginCall(req, 'web_search', env), { ok: true });

  const prev = process.env.KADE_TURN_TOOL_GUARD;
  process.env.KADE_TURN_TOOL_GUARD = '0';
  try {
    let hits = 0;
    const KadeWikipedia = loadWikipedia(async () => {
      hits += 1;
      throw Object.assign(new Error('Request failed with status code 429'), { response: { status: 429 } });
    });
    const turn = {};
    for (let i = 0; i < 10; i += 1) {
      assert.match(await new KadeWikipedia({ req: turn })._call({ query: 'Ozarks' }), /^Wikipedia lookup failed: Request failed with status code 429/);
    }
    assert.equal(hits, 10, 'every lookup went out, as before the guard');
  } finally {
    if (prev === undefined) delete process.env.KADE_TURN_TOOL_GUARD;
    else process.env.KADE_TURN_TOOL_GUARD = prev;
  }
});
