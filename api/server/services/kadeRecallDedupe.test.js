/* Nov 10 2026 (N5): one fact, once per turn. Plain node:test, no model, no network, no database:
 *   node --test api/server/services/kadeRecallDedupe.test.js
 * The first half holds the rule still. The second half runs the real recall service with only
 * storage and the embed replaced (the same rig as kadeCardRecall.pipeline.test.js) and reads the
 * tail it would have handed the model. Every person and fact here is made up. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const crypto = require('node:crypto');

const D = require('./kadeRecallDedupe');

/* ── the rule ─────────────────────────────────────────────────────────── */

test('content words drop small words, fold plurals and endings, and numbers are read as written', () => {
  assert.deepEqual([...D.contentWords('She walks the dogs and walked them yesterday')].sort(), ['dog', 'walk', 'yesterday']);
  assert.deepEqual([...D.contentWords("The sister's garden")].sort(), ['garden', 'sister']);
  assert.deepEqual([...D.numbers('On the 27th at 3:30, room 4.')].sort(), ['27', '3:30', '4']);
  assert.equal(D.bare('- [2026-11-03] [from their talks with Someone] Plays the banjo.'), 'Plays the banjo.');
});

test('a line the head already says is a repeat; a line that adds something is kept', () => {
  const places = D.headPlaces({ pinned: ['Her sister Dana moved to Denver this March and likes it there.'] });
  assert.equal(D.alreadySaid('- [2026-11-01] Sister Dana moved to Denver in March.', places), true);
  /* same people, new fact */
  assert.equal(D.alreadySaid('Sister Dana is thinking about moving back from Denver next summer.', places), false);
  /* too short to judge by overlap: always kept */
  assert.equal(D.alreadySaid('Dana moved.', places), false);
  assert.equal(D.alreadySaid('', places), false);
  assert.equal(D.alreadySaid('Sister Dana moved to Denver in March.', []), false);
});

test('a number the head does not carry keeps the line: the number is the news', () => {
  const places = D.headPlaces({ pinned: ['The dentist appointment for the crown fitting is on Thursday the 14th.'] });
  assert.equal(D.alreadySaid('Dentist appointment Thursday the 14th, for the crown fitting.', places), true);
  assert.equal(D.alreadySaid('The dentist appointment for the crown fitting moved to Thursday the 27th at 3:30.', places), false);
});

test('the summary counts sentence by sentence, and two sentences that touch count together', () => {
  const summary =
    'She has been building a telescope with her neighbor. The mirror arrived cracked and a replacement is on order. ' +
    'Work has been slow this week.';
  const places = D.headPlaces({ summary });
  assert.equal(D.alreadySaid('She has been building a telescope with her neighbor.', places), false, 'three real words is too few to judge');
  assert.equal(D.alreadySaid('The mirror arrived cracked, replacement on order.', places), true);
  assert.equal(D.alreadySaid('The telescope mirror arrived cracked; a replacement is on order with the neighbor building it.', places), true);
  /* words spread across far-apart sentences are not one fact */
  assert.equal(D.alreadySaid('Building a telescope has been slow work this week.', places), false);
  assert.equal(D.alreadySaid('She adopted a second cat from the shelter downtown.', places), false);
});

test('dropRepeats keeps order, counts what it dropped, and the switch turns it off', () => {
  const head = { pinned: ['Plays the banjo in a bluegrass band on weekends.'], summary: '' };
  const lines = ['Plays banjo in a weekend bluegrass band.', 'Allergic to shellfish since childhood, carries medicine.', 'Loves bluegrass.'];
  const on = D.dropRepeats(lines, head, {});
  assert.deepEqual(on.kept, [lines[1], lines[2]]);
  assert.equal(on.dropped, 1);
  assert.deepEqual(on.keptIndex, [1, 2]);
  const off = D.dropRepeats(lines, head, { KADE_RECALL_ONE_FACT: '0' });
  assert.deepEqual(off.kept, lines);
  assert.equal(off.dropped, 0);
  assert.deepEqual(D.dropRepeats(lines, { pinned: [], summary: '' }, {}).kept, lines);
  assert.deepEqual(D.dropRepeats(null, head, {}).kept, []);
});

test('the overlap setting is read, and junk falls back to all the words', () => {
  assert.equal(D.overlapNeeded({}), 1);
  assert.equal(D.overlapNeeded({ KADE_RECALL_ONE_FACT_OVERLAP: '0.95' }), 0.95);
  assert.equal(D.overlapNeeded({ KADE_RECALL_ONE_FACT_OVERLAP: '0.1' }), 1);
  assert.equal(D.overlapNeeded({ KADE_RECALL_ONE_FACT_OVERLAP: 'junk' }), 1);
  /* six words, five found: a repeat at 0.8, kept at 0.95 */
  const places = D.headPlaces({ pinned: ['Garden tomatoes ripen late beside the fence.'] });
  const line = 'Garden tomatoes ripen late beside the shed.';
  assert.equal(D.alreadySaid(line, places, 0.8), true);
  assert.equal(D.alreadySaid(line, places, 0.95), false);
});

test('peekable never waits: nothing yet reads as undefined, a failure reads as undefined', async () => {
  let release;
  const slow = D.peekable(new Promise((resolve) => { release = resolve; }));
  assert.equal(slow.peek(), undefined);
  release('here');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(slow.peek(), 'here');
  const failed = D.peekable(Promise.reject(new Error('down')));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failed.peek(), undefined);
});

/* ── the real recall service, storage and embed replaced ──────────────── */

let ts = null;
try {
  ts = require('typescript');
} catch (_) {
  ts = null;
}
const skipRig = ts ? false : 'typescript is not installed here';

function fixture({ shared = [], own = [], summary = '', summaryNeverAnswers = false, diaryHits = [], env: extraEnv = {} } = {}) {
  const helperFile = path.resolve(__dirname, '../../../packages/api/src/memory/embedding.ts');
  const helperModule = new Module(helperFile, module);
  helperModule.paths = Module._nodeModulePaths(path.dirname(helperFile));
  helperModule._compile(ts.transpileModule(fs.readFileSync(helperFile, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, helperFile);
  const audits = [];
  const lines = [];
  const timers = [];
  let summaryReads = 0;
  const logger = { info: (l) => lines.push(String(l)), warn() {} };
  const cards = { '': shared, companion: own };
  const vectorRows = Object.entries(cards).flatMap(([agentId, rows]) =>
    rows.map((m) => ({
      key: m.key, agentId: agentId || null, embedding: m.vector || [1, 0], embedModel: 'fixture-model',
      valueHash: crypto.createHash('sha1').update(String(m.value || '')).digest('hex'),
    })));
  const vectorModel = {
    find(filter) {
      const scopes = new Set(filter.$or.map((x) => x.agentId));
      return { select: () => ({ lean: async () => vectorRows.filter((x) => scopes.has(x.agentId)) }) };
    },
  };
  class Schema { index() {} }
  const diary = {
    embedText: async () => [1, 0], currentEmbedModel: () => 'fixture-model',
    countEntries: async () => (diaryHits.length ? 1 : 0), searchDiary: async () => diaryHits,
  };
  const load = (file, deps, env = {}) => {
    const mod = { exports: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      module: mod, exports: mod.exports, process: { env }, console,
      setTimeout: (callback) => { timers.push(callback); return callback; },
      clearTimeout: (callback) => { const i = timers.indexOf(callback); if (i >= 0) timers.splice(i, 1); },
      require(id) {
        if (Object.hasOwn(deps, id)) return deps[id];
        if (id === 'crypto') return require('node:crypto');
        throw new Error('Unexpected dependency: ' + id);
      },
    }, { filename: file });
    return mod.exports;
  };
  const ranking = load(path.join(__dirname, '../../models/kadeCardVector.js'), {
    mongoose: { Schema, models: { KadeCardVector: vectorModel } },
    '@librechat/data-schemas': { logger }, '~/models/kadeDiary': diary,
    '@librechat/api': { ...helperModule.exports, memoryEmbeddingLane: () => ({ dimensions: 2 }) },
  });
  const serviceEnv = { KADE_MEMORY_RAG: '1', KADE_MEMORY_RAG_AGENTS: 'all', KADE_ECHOES: '0', KADE_LOOP_NUDGE: '0', ...extraEnv };
  const service = load(path.join(__dirname, 'kadeCardRecall.js'), {
    '@librechat/data-schemas': { logger },
    './kadeRecallQuery': load(path.join(__dirname, 'kadeRecallQuery.js'), {}, serviceEnv),
    './kadeRecallDedupe': load(path.join(__dirname, 'kadeRecallDedupe.js'), {}, serviceEnv),
    '~/models': { getAllUserMemories: async (_userId, { agentId }) => cards[agentId || ''] || [] },
    '~/models/kadeDiary': diary,
    '~/models/kadeCardVector': { ...ranking, syncBucketVectors: async () => {} },
    '~/models/kadeMemorySummary': {
      getMemorySummary: () => {
        summaryReads += 1;
        return summaryNeverAnswers ? new Promise(() => {}) : Promise.resolve(summary ? { summary } : null);
      },
    },
    '~/server/services/kadeOpenLoops': require('./kadeOpenLoops'),
    './kadeToolRetrieval': { memoEmbed: (_req, embed) => embed },
    './kadeMemoryShare': { otherBucketsFor: async () => [], agentNameOf: async () => 'Other companion', shareNotice: async () => '' },
    '~/models/kadeRecallAudit': { storeRecallAudit: (row) => audits.push(row) },
  }, serviceEnv);
  const run = () => service.getRecallTailBlock({ userId: 'seat', agentId: 'companion', userText: 'Tell me about the telescope project.', req: {} });
  return { run, audits, lines, summaryReads: () => summaryReads };
}

const card = (key, value, agentId = 'companion', vector = [1, 0]) => ({ key, value, agentId, tokenCount: 200, updated_at: '2026-09-06', vector });
/* Seven cards that never match the query, so the seat is over the small-seat floor (1,200 tokens). */
const filler = () => Array.from({ length: 7 }, (_, i) => card('filler_' + i, 'Filler note number ' + i + ' about nothing in particular.', 'companion', [0, 1]));

test('a recalled card that repeats a pinned card is left out; a card that adds something stays', { skip: skipRig }, async () => {
  const own = [
    ...filler(),
    card('identity_hobby', 'Builds telescopes with her neighbor Sam in the garage most weekends.'),
    card('garage_weekends', 'Most weekends she builds telescopes in the garage with neighbor Sam.'),
    card('mirror_order', 'The telescope mirror arrived cracked and a replacement is on order.'),
  ];
  const f = fixture({ own });
  const { block } = await f.run();
  assert.match(block, /mirror arrived cracked/);
  assert.doesNotMatch(block, /Most weekends she builds/);
  assert.doesNotMatch(block, /Builds telescopes with her neighbor/, 'the pinned card itself still never rides the tail');
  assert.deepEqual(Array.from(f.audits[0].cards), ['mirror_order']);
  assert.ok(f.lines.some((l) => /\[kadeCardRecall\] user=.* repeats=1/.test(l)), 'the count is in the log line');
});

test('a recalled card that repeats the summary is left out, and the switch brings it back', { skip: skipRig }, async () => {
  const own = [...filler(), card('mirror_order', 'The telescope mirror arrived cracked and a replacement is on order.')];
  const summary = 'She is building a telescope. The mirror arrived cracked, so a replacement mirror is on order. Work is busy.';
  const on = fixture({ own, summary });
  assert.equal((await on.run()).block, null);
  assert.equal(on.summaryReads(), 1);
  const off = fixture({ own, summary, env: { KADE_RECALL_ONE_FACT: '0' } });
  assert.match((await off.run()).block, /mirror arrived cracked/);
  assert.equal(off.summaryReads(), 0, 'switched off, the summary is not even read');
  const noSummaries = fixture({ own, summary, env: { KADE_MEMORY_SUMMARY: '0' } });
  assert.match((await noSummaries.run()).block, /mirror arrived cracked/, 'no summary rides the head, so nothing repeats it');
});

test('a summary read that never answers is not waited for', { skip: skipRig }, async () => {
  const own = [...filler(), card('mirror_order', 'The telescope mirror arrived cracked and a replacement is on order.')];
  const f = fixture({ own, summary: 'ignored', summaryNeverAnswers: true });
  const { block } = await f.run();
  assert.match(block, /mirror arrived cracked/);
});

test('a logbook line that repeats the head or a card recalled this turn is left out', { skip: skipRig }, async () => {
  const own = [
    ...filler(),
    card('identity_hobby', 'Builds telescopes with her neighbor Sam in the garage most weekends.'),
    card('mirror_order', 'The telescope mirror arrived cracked and a replacement is on order.'),
  ];
  const diaryHits = [
    { date: '2026-11-01', text: 'The telescope mirror arrived cracked; a replacement is on order.', agentId: 'companion' },
    { date: '2026-11-02', text: 'Garage weekends: she builds telescopes with neighbor Sam.', agentId: 'companion' },
    { date: '2026-11-03', text: 'First clear night in weeks, and she saw the rings of Saturn through the old scope.', agentId: 'companion' },
  ];
  const f = fixture({ own, diaryHits });
  const { block } = await f.run();
  assert.match(block, /# Memory recall/);
  assert.match(block, /rings of Saturn/);
  assert.equal((block.match(/mirror arrived cracked/g) || []).length, 1, 'said once, by the card');
  assert.doesNotMatch(block, /Garage weekends/);
  assert.deepEqual(Array.from(f.audits[0].logbook), ['2026-11-03']);
});

test('on a small seat every card already rides the head, so none is recalled a second time', { skip: skipRig }, async () => {
  const own = [card('hobby', 'Enjoys pottery on Sunday mornings at the studio.')];
  const on = fixture({ own });
  assert.equal((await on.run()).block, null);
  const off = fixture({ own, env: { KADE_RECALL_ONE_FACT: '0' } });
  assert.match((await off.run()).block, /Enjoys pottery/, 'the old behaviour, exactly');
});

test('build two: the card that carries the correction is never dropped as a repeat', () => {
  const head = {
    summary:
      'She has a dentist appointment Thursday at the Springfield clinic. She decided to take the job at the hospital in Springfield.',
  };
  const lines = [
    'Dentist appointment is Friday at the Springfield clinic',
    'She decided not to take the job at the hospital in Springfield',
    'She decided to take the job at the hospital in Springfield',
  ];
  const out = D.dropRepeats(lines, head, {});
  assert.deepEqual(out.kept, lines.slice(0, 2), 'the changed day and the "not" are news; the exact repeat is not');
  assert.equal(out.dropped, 1);
  /* a negation is a content word however short */
  assert.equal(D.contentWords('she did not go').has('not'), true);
  assert.equal(D.contentWords("she didn't go").has('not'), true);
});
