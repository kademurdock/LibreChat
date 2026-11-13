/**
 * The nightly logbook vector repair (kadeDiary.js, Nov 10 2026): capped per
 * night, stops after three failures in a row, skips empty rows, never throws.
 * The loop is extracted from the shipped file and run bare, so no database,
 * no network and no embed call is made:
 *   node --test api/models/kadeDiary.nightlyRepair.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, 'kadeDiary.js'), 'utf8');
function extract(name) {
  const start = SRC.indexOf('async function ' + name + '(');
  assert.ok(start > -1, name + ' not found');
  /* the body is the first "{" at the start of a line's end after the signature */
  let i = SRC.indexOf(') {\n', start) + 2;
  let depth = 0;
  let end = -1;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > start + 200, name + ' extracted too short');
  return SRC.slice(start, end);
}
const ctx = {};
vm.createContext(ctx);
vm.runInContext(extract('repairEmbedLoop') + '\nthis.fn = repairEmbedLoop;', ctx);
const repairEmbedLoop = ctx.fn;

const rows = (n) => Array.from({ length: n }, (_, i) => ({ _id: i, text: 'entry ' + i }));
const plain = (o) => JSON.parse(JSON.stringify(o));

test('a healthy lane embeds every row up to the nightly cap and no further', async () => {
  const saved = [];
  let embeds = 0;
  const out = await repairEmbedLoop({
    rows: rows(10), cap: 4,
    embed: async () => { embeds += 1; return [0.1, 0.2]; },
    save: async (r) => saved.push(r._id),
  });
  assert.deepEqual(plain(out), { scanned: 4, embedded: 4, failed: 0, skipped: 0, stopped: false });
  assert.equal(embeds, 4, 'the cap is the most embed calls a night can make');
  assert.deepEqual(saved, [0, 1, 2, 3]);
});

test('a dead lane costs exactly three calls', async () => {
  let embeds = 0;
  const out = await repairEmbedLoop({
    rows: rows(50), cap: 50,
    embed: async () => { embeds += 1; return null; },
    save: async () => { throw new Error('nothing to save'); },
  });
  assert.equal(embeds, 3);
  assert.deepEqual(plain(out), { scanned: 3, embedded: 0, failed: 3, skipped: 0, stopped: true });
});

test('an embed that throws counts as a failure and never escapes', async () => {
  const out = await repairEmbedLoop({
    rows: rows(5), cap: 5,
    embed: async () => { throw new Error('refused'); },
    save: async () => {},
  });
  assert.equal(out.stopped, true);
  assert.equal(out.failed, 3);
});

test('three failures must be IN A ROW: scattered failures do not stop the pass', async () => {
  const answers = [null, null, [1], null, [1], null, null, [1], [1]];
  let n = 0;
  const out = await repairEmbedLoop({
    rows: rows(9), cap: 9,
    embed: async () => answers[n++],
    save: async () => {},
  });
  assert.deepEqual(plain(out), { scanned: 9, embedded: 4, failed: 5, skipped: 0, stopped: false });
});

test('a lane that dies mid-pass stops three calls later, keeping what it embedded', async () => {
  let n = 0;
  const saved = [];
  const out = await repairEmbedLoop({
    rows: rows(20), cap: 20,
    embed: async () => (n++ < 5 ? [1] : null),
    save: async (r) => saved.push(r._id),
  });
  assert.equal(n, 8);
  assert.deepEqual(plain(out), { scanned: 8, embedded: 5, failed: 3, skipped: 0, stopped: true });
  assert.equal(saved.length, 5);
});

test('rows with no text are skipped without an embed call and are not failures', async () => {
  let embeds = 0;
  const out = await repairEmbedLoop({
    rows: [{ _id: 1, text: '' }, { _id: 2, text: '   ' }, { _id: 3 }, { _id: 4, text: '' }, { _id: 5, text: 'real entry' }],
    cap: 10,
    embed: async () => { embeds += 1; return [1]; },
    save: async () => {},
  });
  assert.equal(embeds, 1);
  assert.deepEqual(plain(out), { scanned: 5, embedded: 1, failed: 0, skipped: 4, stopped: false });
});

test('an empty vector is a failure, long text is clipped, and the pause runs between rows', async () => {
  const seen = [];
  let pauses = 0;
  const out = await repairEmbedLoop({
    rows: [{ _id: 1, text: 'x'.repeat(9000) }, { _id: 2, text: 'short' }],
    cap: 5,
    embed: async (text) => { seen.push(text.length); return seen.length === 1 ? [] : [1]; },
    save: async () => {},
    pause: async () => { pauses += 1; },
  });
  assert.deepEqual(seen, [4000, 5]);
  assert.equal(pauses, 2);
  assert.deepEqual(plain(out), { scanned: 2, embedded: 1, failed: 1, skipped: 0, stopped: false });
});

test('no rows, or a cap of zero, does nothing', async () => {
  const never = async () => { throw new Error('must not be called'); };
  assert.equal((await repairEmbedLoop({ rows: [], cap: 60, embed: never, save: never })).scanned, 0);
  assert.equal((await repairEmbedLoop({ rows: rows(3), cap: 0, embed: never, save: never })).scanned, 0);
});

/* Sweep 8.2 (Nov 13 2026): an entry saved while the embed lane timed out has no vector. Both
 * repair passes (the nightly one and the admin backfill) must pick such rows up. */
test('an entry with no vector is in the repair backlog, and both passes read that backlog', () => {
  assert.match(
    SRC,
    /\$or: \[\{ embedding: null \}, \{ embedding: \{ \$size: 0 \} \}, \{ embedModel: \{ \$ne: model \} \}\]/,
  );
  const nightly = extract('nightlyDiaryEmbedRepair');
  assert.match(nightly, /diaryEmbedBacklog\(model, lane\.dimensions, cap, \{\s*newestFirst: true,?\s*\}\)/);
  assert.match(nightly, /: \{ embedding: vec, embedModel: model \}/);
  assert.match(extract('backfillDiaryEmbeddings'), /diaryEmbedBacklog\(model, lane\.dimensions, dry \? 0 : limit\)/);
  /* Cards mend on every turn: a row whose vector is missing fails indexedCardEmbedding and is embedded again. */
  const cards = fs.readFileSync(path.join(__dirname, 'kadeCardVector.js'), 'utf8');
  assert.match(cards, /!row \|\|\s+!indexedCardEmbedding\(row, model, [^\n]+, value\)\s+\) \{\s+work\.push/);
});

test('the shipped file wires the switch, the cap and the sweep', () => {
  assert.match(SRC, /KADE_DIARY_NIGHTLY_EMBED === '0'\) return \{ ran: false, reason: 'disabled' \}/);
  assert.match(SRC, /KADE_DIARY_NIGHTLY_EMBED_MAX/);
  assert.match(SRC, /maxStraight: NIGHTLY_STRAIGHT_FAILURES/);
  assert.match(SRC, /const NIGHTLY_STRAIGHT_FAILURES = 3;/);
  const sweep = fs.readFileSync(path.join(__dirname, '../server/services/kadeMemorySummarySweep.js'), 'utf8');
  assert.match(sweep, /await runSummarySweep\(\);[\s\S]{0,200}await repairLogbookVectors\(\);/);
  assert.match(sweep, /nightlyDiaryEmbedRepair\(\)/);
});
