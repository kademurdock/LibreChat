/**
 * Recall timing, Nov 10 2026: only the query embed races the deadline; the
 * follow-up nudge and the month echo run whether it wins, loses or fails; no
 * vector means no logbook block; one memory embed per turn, shared with tool
 * retrieval; a bare greeting reaches the nudge with no embed.
 *
 * The real recall service, the real tool retrieval and the real query-words
 * helper run here. Storage, the embed and the side services are stubs: no
 * network, no database, no model call, invented people only.
 *   node --test api/server/services/kadeCardRecall.deadline.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DAY = 86400000;
const card = (key, value, extra = {}) => ({
  key, value, agentId: 'companion', tokenCount: 200, updated_at: '2026-09-06', ...extra,
});
/** A dated plan that passed two days ago and nobody has said how it went. */
const oldPlan = () => card('pottery_class', 'Planned to attend a pottery class.', {
  staleAfter: new Date(Date.now() - 2 * DAY).toISOString(),
  updated_at: new Date(Date.now() - 3 * DAY).toISOString(),
});
const pending = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function fixture({ own = [], env = {}, embed, cardHits = [], diaryRows = 1, diaryHits, echo = null } = {}) {
  const calls = { embeds: [], diary: [], cardSearches: 0, syncs: 0, audits: [], logs: [] };
  const logger = { info: (line) => calls.logs.push(String(line)), warn: (line) => calls.logs.push(String(line)), error() {}, debug() {} };
  const fullEnv = {
    KADE_MEMORY_RAG: '1', KADE_MEMORY_RAG_AGENTS: 'all', KADE_RECALL_TIMEOUT_MS: '500',
    KADE_TOOLS_RAG_STRICT: '1', ...env,
  };
  const load = (file, deps) => {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), {
      module, exports: module.exports, process: { env: fullEnv }, console, setTimeout, clearTimeout,
      require(id) {
        if (Object.hasOwn(deps, id)) return deps[id];
        throw new Error('Unexpected dependency: ' + id);
      },
    }, { filename: file });
    return module.exports;
  };
  const Q = load('kadeRecallQuery.js', {});
  const rag = load('kadeToolRetrieval.js', {
    '@librechat/data-schemas': { logger },
    './kadeRecallQuery': Q,
    './kadeJevJudges': { toolsAdd: async () => [], toolsShadow: () => null },
  });
  const embedText = async (text, opts = {}) => {
    calls.embeds.push({ text: String(text), purpose: opts.purpose || 'document' });
    return embed ? embed(String(text), opts) : [1, 0];
  };
  const recall = load('kadeCardRecall.js', {
    '@librechat/data-schemas': { logger },
    '~/models': { getAllUserMemories: async (_user, { agentId }) => (agentId ? own : []) },
    '~/models/kadeDiary': {
      embedText,
      countEntries: async () => diaryRows,
      searchDiary: async (options) => {
        calls.diary.push({ query: options.query, hasVector: Array.isArray(options.queryVector) });
        return diaryHits || [{ date: '2026-09-01', text: 'Talked about the telescope mount.', agentId: null }];
      },
    },
    '~/models/kadeCardVector': {
      syncBucketVectors: async () => { calls.syncs += 1; },
      searchCardVectors: async () => { calls.cardSearches += 1; return cardHits; },
    },
    '~/server/services/kadeOpenLoops': require('./kadeOpenLoops'),
    './kadeRecallQuery': Q,
    './kadeToolRetrieval': rag,
    './kadeMemoryShare': { otherBucketsFor: async () => [], agentNameOf: async () => 'Other', shareNotice: async () => '' },
    '~/models/kadeRecallAudit': { storeRecallAudit: (row) => calls.audits.push(row) },
    '~/server/services/kadeMemoryEchoes': {
      getTodayEchoForSeat: async () => echo,
      echoSurfacedToday: async () => false,
    },
  });
  const TOOLS = ['kade_help', 'kade_joke', 'kade_news', 'web_search', 'kade_games'].map((name) => ({ name, description: name + ' does things' }));
  /** One whole turn the way the server runs it: tool selection, then recall. */
  const turn = async ({ text, stored, previous, agentName = 'Juniper', samePurpose, tools = true, startedAgoMs, convo }) => {
    const req = { body: { text, conversationId: convo || 'convo-' + Math.random() } };
    let selection = null;
    if (tools) {
      selection = await rag.selectTools({
        tools: TOOLS, text: req.body.text, conversationId: req.body.conversationId, agentId: 'companion',
        embed: rag.memoEmbed(req, embedText, samePurpose || ((p) => p)),
      });
    }
    if (startedAgoMs != null) req._kadeTurnStartedAt = Date.now() - startedAgoMs;
    const t0 = Date.now();
    const out = await recall.getRecallTailBlock({
      userId: 'seat', agentId: 'companion',
      userText: Q.recallTurnText(req.body.text, stored === undefined ? text : stored, fullEnv),
      previousUserText: previous || '', agentName, req,
    });
    return { ...out, waited: Date.now() - t0, selection, req };
  };
  const memoryEmbeds = () => calls.embeds.filter((e) => e.purpose === 'query');
  return { turn, calls, memoryEmbeds, Q, rag, recall };
}

const ECHO = { phrase: 'two months ago today', when: '2026-09-10', text: 'Finished the telescope mount.' };
const LONG = 'Tell me about the telescope project we planned.';
const wrap = (earlier, latest) =>
  '[EARLIER IN THIS CONVERSATION — context only, already handled, do not re-answer:\n' + earlier.join('\n') +
  '\n— end of earlier context. Reply ONLY to what follows.]\n\n' + latest;

/* ── the embed stubbed FAST ─────────────────────────────────────────────── */

test('fast embed: cards, nudge, logbook and echo all ride, in that order', async () => {
  const f = fixture({
    own: [card('telescope_project', 'Building a telescope.'), oldPlan()],
    cardHits: [{ key: 'telescope_project', agentId: 'companion', score: 0.9 }],
    echo: ECHO,
  });
  const { block } = await f.turn({ text: LONG });
  const order = ['# Memory recall', '# Open loop', '# Logbook recall', '# Memory echo'].map((h) => block.indexOf(h));
  assert.ok(order.every((i) => i >= 0), block);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.deepEqual(f.calls.diary, [{ query: LONG, hasVector: true }]);
});

/* ── the embed stubbed SLOW ─────────────────────────────────────────────── */

test('slow embed: the nudge and the echo still ride; no cards, no logbook; the wait stays inside the old cap', async () => {
  const slow = pending();
  const f = fixture({ own: [oldPlan()], echo: ECHO, embed: () => slow.promise });
  /* tools:false so the only embed is recall's own and it never answers in time */
  const { block, waited } = await f.turn({ text: LONG, tools: false });
  slow.resolve([1, 0]);
  assert.match(block, /# Open loop/);
  assert.match(block, /# Memory echo/);
  assert.doesNotMatch(block, /# Memory recall|# Logbook recall/);
  assert.equal(f.calls.diary.length, 0, 'no vector, so the logbook is not even asked');
  assert.equal(f.calls.cardSearches, 0);
  assert.ok(waited < 500, `recall waited ${waited} ms; the old single wait here is 500 ms`);
  assert.ok(waited >= 300, `the embed got its share of the wait (${waited} ms)`);
  assert.ok(f.calls.logs.some((l) => /embed=late/.test(l)), 'the log says the embed was late');
  assert.deepEqual(Array.from(f.calls.audits[0].cards), ['pottery_class', 'echo:2026-09-10']);
});

test('slow embed: the deadline is measured from when the turn began, not from when recall began', async () => {
  const slow = pending();
  const f = fixture({ own: [oldPlan()], embed: () => slow.promise, env: { KADE_TOOLS_EMBED_WAIT_MS: '20' } });
  /* tool selection started the embed; the turn began 450 ms ago; 50 ms of the 500 are left */
  const { block, waited } = await f.turn({ text: LONG, startedAgoMs: 450 });
  slow.resolve([1, 0]);
  assert.match(block, /# Open loop/);
  assert.ok(waited < 250, `recall waited ${waited} ms after tool selection had used 450 of the 500`);
});

test('slow embed: a turn that began long ago does not wait at all, and takes a vector that is already in', async () => {
  const f = fixture({ own: [oldPlan()], cardHits: [] });
  const { block, waited } = await f.turn({ text: LONG, startedAgoMs: 60000 });
  assert.match(block, /# Logbook recall/, 'the vector tool selection started was ready, so it is used');
  assert.ok(waited < 200, `waited ${waited} ms`);
  const slow = pending();
  const g = fixture({ own: [oldPlan()], embed: () => slow.promise, env: { KADE_TOOLS_EMBED_WAIT_MS: '20' } });
  const late = await g.turn({ text: LONG, startedAgoMs: 60000 });
  slow.resolve([1, 0]);
  assert.doesNotMatch(late.block, /# Logbook recall/);
  assert.match(late.block, /# Open loop/);
  assert.ok(late.waited < 200, `waited ${late.waited} ms`);
});

test('review fix: an embed that only starts at recall keeps its wait from there, however old the turn is', async () => {
  /* No tool selection this turn, so recall starts the embed itself. A deadline
   * counted from an old turn stamp would already be past: the embed would be
   * paid for and dropped at once. It answers in 120 ms and is used. */
  const f = fixture({ own: [oldPlan()], embed: () => new Promise((done) => setTimeout(() => done([1, 0]), 120)) });
  const { block, waited } = await f.turn({ text: LONG, tools: false, startedAgoMs: 60000 });
  assert.match(block, /# Logbook recall/, 'the fresh embed was waited for and used');
  assert.ok(waited >= 100 && waited < 500, `waited ${waited} ms`);
  assert.ok(!f.calls.logs.some((l) => /embed=late/.test(l)));
});

test('review fix: a SHORT message does not wait at recall for an embed started late', async () => {
  /* The embed takes 300 ms. Tool selection waits for its own tools embed, and
   * the memory embed must have been started beside it, so recall finds it in.
   * (Before the fix recall started it from zero here and waited 300 ms more.) */
  const starts = [];
  const f = fixture({
    own: [card('hobby', 'Enjoys pottery.')],
    env: { KADE_RECALL_TIMEOUT_MS: '2500' },
    embed: (text, opts) => {
      starts.push({ purpose: opts.purpose || 'document', at: Date.now() });
      return new Promise((done) => setTimeout(() => done([1, 0]), 300));
    },
  });
  for (const text of ['what about her?', 'what about tomorrow then?']) {
    starts.length = 0;
    const began = Date.now();
    const { waited, block } = await f.turn({ text, previous: 'My sister starts her pottery class on Thursday.' });
    const memory = starts.filter((s) => s.purpose === 'query');
    assert.equal(memory.length, 1, 'one memory embed');
    assert.ok(memory[0].at - began < 100, `the memory embed started ${memory[0].at - began} ms into the turn, at tool selection`);
    assert.ok(waited < 150, `recall waited ${waited} ms on a short message`);
    assert.match(block, /# Logbook recall/);
  }
});

test('slow embed: a stamp from the future or a broken stamp falls back to recall start, never a longer wait', async () => {
  const slow = pending();
  const f = fixture({ own: [oldPlan()], embed: () => slow.promise });
  for (const stamp of [Date.now() + 60000, 'soon', -5]) {
    const req = { body: { text: LONG }, _kadeTurnStartedAt: stamp };
    const t0 = Date.now();
    await f.recall.getRecallTailBlock({ userId: 'seat', agentId: 'companion', userText: LONG, req });
    assert.ok(Date.now() - t0 < 500, String(stamp));
  }
  slow.resolve([1, 0]);
});

/* ── the embed stubbed FAILED ───────────────────────────────────────────── */

test('failed embed: NO logbook block (not the newest four), and the nudge and echo still ride', async () => {
  for (const embed of [async () => null, async () => { throw new Error('lane refused'); }]) {
    const f = fixture({ own: [oldPlan()], echo: ECHO, embed });
    const { block, waited } = await f.turn({ text: LONG, tools: false });
    assert.match(block, /# Open loop/);
    assert.match(block, /# Memory echo/);
    assert.doesNotMatch(block, /# Logbook recall/);
    assert.equal(f.calls.diary.length, 0);
    assert.ok(waited < 200, 'a failure is not waited on');
  }
});

test('failed embed with nothing else to say returns no block at all', async () => {
  const f = fixture({ own: [card('hobby', 'Enjoys pottery.')], embed: async () => null });
  assert.equal((await f.turn({ text: LONG })).block, null);
});

test('KADE_RECALL_DEADLINE=0: the old behaviour, whole (newest logbook entries on a failed embed; a slow embed loses everything)', async () => {
  const f = fixture({ own: [oldPlan()], env: { KADE_RECALL_DEADLINE: '0' }, embed: async () => null });
  const { block } = await f.turn({ text: LONG, tools: false });
  assert.match(block, /# Logbook recall/);
  assert.deepEqual(f.calls.diary, [{ query: null, hasVector: false }]);
  const slow = pending();
  const g = fixture({ own: [oldPlan()], env: { KADE_RECALL_DEADLINE: '0' }, embed: () => slow.promise });
  const lost = await g.turn({ text: LONG, tools: false });
  slow.resolve([1, 0]);
  assert.equal(lost.block, null);
  assert.ok(lost.waited >= 450 && lost.waited < 900, `waited ${lost.waited} ms`);
  /* review fix: with the deadline off a bare greeting still gets no logbook
   * block (it never searched the logbook before this work either) */
  const h = fixture({ own: [oldPlan()], env: { KADE_RECALL_DEADLINE: '0' } });
  const hey = await h.turn({ text: 'hey' });
  assert.deepEqual(h.calls.diary, []);
  assert.doesNotMatch(String(hey.block || ''), /# Logbook recall/);
});

/* ── one memory embed per turn ──────────────────────────────────────────── */

test('one memory embed per turn: tool retrieval starts it, recall reads the same one', async () => {
  const f = fixture({ own: [card('hobby', 'Enjoys pottery.')] });
  await f.turn({ text: LONG });
  assert.deepEqual(f.memoryEmbeds(), [{ text: LONG, purpose: 'query' }]);
  assert.equal(f.calls.embeds.filter((e) => e.purpose === 'tools' && e.text === LONG).length, 1);
});

test('one memory embed per turn: the stored message differing from the request text no longer causes a second one', async () => {
  const f = fixture({ own: [card('hobby', 'Enjoys pottery.')] });
  await f.turn({ text: LONG, stored: LONG + '\n\n[attached file: notes.txt]' });
  assert.deepEqual(f.memoryEmbeds(), [{ text: LONG, purpose: 'query' }]);
});

test('one memory embed per turn on a voice turn: both readers embed the latest words, wrapper removed', async () => {
  const f = fixture({ own: [card('hobby', 'Enjoys pottery.')] });
  const text = wrap(['THEM: tell me a joke about the news', 'YOU: ' + 'old reply '.repeat(200)], LONG);
  const { selection } = await f.turn({ text });
  assert.deepEqual(f.memoryEmbeds(), [{ text: LONG, purpose: 'query' }]);
  assert.deepEqual(f.calls.embeds.filter((e) => e.purpose === 'tools').map((e) => e.text), [LONG]);
  assert.deepEqual(f.calls.diary, [{ query: LONG, hasVector: true }]);
  /* "tell me about" in the latest words is a fair web_search alias; the joke and
   * the news asked for in the folded EARLIER turn must not attach anything. */
  assert.match(selection.reason, /kw=\[web_search\]/, 'aliases read the latest words only, not the folded earlier turns');
  assert.ok(!selection.keep.has('kade_joke') && !selection.keep.has('kade_news'));
});

test('KADE_RECALL_QUERY_CLEAN=0: both readers search the wrapped text again, still one embed', async () => {
  const f = fixture({ own: [card('hobby', 'Enjoys pottery.')], env: { KADE_RECALL_QUERY_CLEAN: '0' } });
  const text = wrap(['THEM: tell me a joke'], LONG);
  const { selection } = await f.turn({ text });
  assert.deepEqual(f.memoryEmbeds(), [{ text: text.slice(0, 1500), purpose: 'query' }]);
  assert.ok(selection.keep.has('kade_joke'), 'the old text matched the old alias');
});

test('short message: the previous user message rides the MEMORY query only, and it is still one memory embed', async () => {
  const f = fixture({ own: [card('hobby', 'Enjoys pottery.')] });
  const previous = 'My sister starts her pottery class on Thursday.';
  /* the server saw the previous message in this conversation, so tool selection
   * starts the one memory embed with it in front and recall uses that one */
  await f.turn({ text: previous, convo: 'c-talk' });
  f.calls.embeds.length = 0;
  f.calls.diary.length = 0;
  await f.turn({ text: 'what about her?', previous, convo: 'c-talk' });
  assert.deepEqual(f.memoryEmbeds(), [{ text: previous + '\nwhat about her?', purpose: 'query' }]);
  assert.deepEqual(f.calls.embeds.filter((e) => e.purpose === 'tools').map((e) => e.text), ['what about her?']);
  assert.deepEqual(f.calls.diary, [{ query: previous + '\nwhat about her?', hasVector: true }]);
});

test('short message whose previous one this server never saw: the plain words, one embed, started at tool selection', async () => {
  const f = fixture({ own: [card('hobby', 'Enjoys pottery.')] });
  await f.turn({ text: 'what about her?', previous: 'My sister starts her pottery class on Thursday.' });
  assert.deepEqual(f.memoryEmbeds(), [{ text: 'what about her?', purpose: 'query' }]);
});

test('short message with no tool selection this turn: recall starts the one embed itself, previous message in front', async () => {
  const f = fixture({ own: [card('hobby', 'Enjoys pottery.')] });
  const previous = 'My sister starts her pottery class on Thursday.';
  await f.turn({ text: 'what about her?', previous, tools: false });
  assert.deepEqual(f.memoryEmbeds(), [{ text: previous + '\nwhat about her?', purpose: 'query' }]);
});

test('short message on a lane where the tools query IS the memory query: recall reuses it, adds nothing', async () => {
  const f = fixture({ own: [card('hobby', 'Enjoys pottery.')] });
  await f.turn({
    text: 'what about her?', previous: 'My sister starts her pottery class on Thursday.',
    samePurpose: (p) => (p === 'tools' ? 'query' : p),
  });
  assert.deepEqual(f.calls.embeds.filter((e) => e.purpose !== 'document'), [{ text: 'what about her?', purpose: 'query' }]);
});

test('short message with no previous one, and a full message with one, search alone', async () => {
  const f = fixture({ own: [card('hobby', 'Enjoys pottery.')] });
  await f.turn({ text: 'what about her?' });
  assert.deepEqual(f.memoryEmbeds(), [{ text: 'what about her?', purpose: 'query' }]);
  const g = fixture({ own: [card('hobby', 'Enjoys pottery.')] });
  await g.turn({ text: LONG, previous: 'My sister starts her pottery class on Thursday.' });
  assert.deepEqual(g.memoryEmbeds(), [{ text: LONG, purpose: 'query' }]);
});

test('KADE_RECALL_PREV_TURN=0: a short message searches alone and tool retrieval starts the embed as before', async () => {
  const f = fixture({ own: [card('hobby', 'Enjoys pottery.')], env: { KADE_RECALL_PREV_TURN: '0' } });
  await f.turn({ text: 'what about her?', previous: 'My sister starts her pottery class on Thursday.' });
  assert.deepEqual(f.memoryEmbeds(), [{ text: 'what about her?', purpose: 'query' }]);
});

/* ── greetings under 12 characters ──────────────────────────────────────── */

test('"hey" and "hi <own name>" reach the nudge and the echo with NO embed, no cards, no logbook', async () => {
  for (const text of ['hey', 'Hello!', 'hi Juniper']) {
    const f = fixture({ own: [oldPlan()], echo: ECHO });
    const { block } = await f.turn({ text, tools: false });
    assert.match(block || '', /# Open loop/, text);
    assert.match(block, /# Memory echo/, text);
    assert.equal(f.calls.embeds.length, 0, text);
    assert.equal(f.calls.diary.length, 0, text);
    assert.equal(f.calls.cardSearches, 0, text);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.syncs, 0, 'no background index refresh (it embeds) on a greeting: ' + text);
  }
  const full = fixture({ own: [oldPlan()] });
  await full.turn({ text: LONG });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(full.calls.syncs > 0, 'a full turn still keeps the index fresh, as before');
});

test('"ok", "lol" and a greeting to somebody else get nothing, and nothing is read or embedded', async () => {
  for (const text of ['ok', 'lol', 'yes', 'hey Marlowe', 'thanks!']) {
    const f = fixture({ own: [oldPlan()], echo: ECHO });
    const out = await f.turn({ text, tools: false });
    assert.equal(out.block, null, text);
    assert.equal(f.calls.embeds.length, 0, text);
    assert.equal(f.calls.audits.length, 0, text);
  }
});

test('a short greeting nudges once: the ledger still stops a repeat in the same conversation', async () => {
  const f = fixture({ own: [oldPlan()] });
  const req = { body: { text: 'hey', conversationId: 'one-chat' } };
  const run = () => f.recall.getRecallTailBlock({ userId: 'seat', agentId: 'companion', userText: 'hey', agentName: 'Juniper', req });
  assert.match((await run()).block || '', /# Open loop/);
  assert.equal((await run()).block, null);
});

test("a focused character nudges on a greeting that uses ITS OWN name, not one hardcoded name", async () => {
  const env = { KADE_FOCUSED_MEMORY_AGENTS: 'companion' };
  const f = fixture({ own: [oldPlan()], env });
  assert.match((await f.turn({ text: 'good morning Juniper', tools: false })).block || '', /# Open loop/);
  const g = fixture({ own: [oldPlan()], env });
  assert.doesNotMatch((await g.turn({ text: 'good morning Marlowe', tools: false })).block || '', /# Open loop/);
  const h = fixture({ own: [oldPlan()], env });
  assert.doesNotMatch((await h.turn({ text: LONG, tools: false })).block || '', /# Open loop/, 'a focused character still nudges only on a greeting');
});

test('KADE_RECALL_GREETING=0: nothing under 12 characters, and the old greeting test', async () => {
  const f = fixture({ own: [oldPlan()], echo: ECHO, env: { KADE_RECALL_GREETING: '0' } });
  assert.equal((await f.turn({ text: 'hey', tools: false })).block, null);
  const g = fixture({ own: [oldPlan()], env: { KADE_RECALL_GREETING: '0', KADE_FOCUSED_MEMORY_AGENTS: 'companion' } });
  assert.doesNotMatch((await g.turn({ text: 'good morning Juniper', tools: false })).block || '', /# Open loop/);
  const h = fixture({ own: [oldPlan()], env: { KADE_RECALL_GREETING: '0' } });
  assert.match((await h.turn({ text: LONG, tools: false })).block || '', /# Open loop/, 'other characters nudge on any full turn, as before');
});
