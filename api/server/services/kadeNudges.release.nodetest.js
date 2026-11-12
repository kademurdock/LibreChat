/* TURN-9 (turn audit, Nov 12 2026): a waiting note picked up by a turn that is stopped, fails or
 * is replaced goes back for the next turn, at most twice; two turns at once never both take it.
 * Plain node:test with a stub model (no Mongo):
 *   node --test api/server/services/kadeNudges.release.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('./kadeNudges'), 'utf8');

/** A tiny in-memory stand-in for KadePendingNudge: just the filter shapes kadeNudges uses. */
function stubModel(rows) {
  const eq = (a, b) => String(a) === String(b);
  const fieldMatches = (value, cond) => {
    if (cond === null) return value == null;
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('$in' in cond) return cond.$in.some((x) => (x === null ? value == null : eq(x, value)));
      if ('$nin' in cond) return !cond.$nin.some((x) => eq(x, value));
      if ('$ne' in cond) return cond.$ne === null ? value != null : !eq(value, cond.$ne);
      if ('$not' in cond) return !fieldMatches(value, cond.$not);
      if ('$gte' in cond) return value != null && value >= cond.$gte;
    }
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    return eq(value, cond);
  };
  const matches = (row, filter) =>
    Object.entries(filter).every(([key, cond]) => fieldMatches(row[key], cond));
  const chain = (hit) => {
    const q = {
      sort: () => q,
      limit: (n) => chain(hit.slice(0, n)),
      select: () => q,
      lean: async () => hit.map((r) => ({ ...r })),
    };
    return q;
  };
  return {
    rows,
    find(filter) {
      return chain(rows.filter((r) => matches(r, filter)));
    },
    async updateMany(filter, update) {
      let modifiedCount = 0;
      for (const r of rows) {
        if (!matches(r, filter)) continue;
        modifiedCount += 1;
        Object.assign(r, update.$set || {});
        for (const [k, v] of Object.entries(update.$inc || {})) r[k] = (r[k] || 0) + v;
      }
      return { modifiedCount };
    },
  };
}

function load(rows) {
  const model = stubModel(rows);
  const logs = [];
  const logger = { info: (l) => logs.push(l), warn: (l) => logs.push(l) };
  const context = { KadePendingNudge: model, Array, String, Set, Date, logger, turnReadOptions: () => ({ maxTimeMS: 3000 }) };
  vm.createContext(context);
  vm.runInContext(
    source.slice(source.indexOf('async function takePendingChatNudges('), source.indexOf('/** ---- the sweep')) +
      '\n;this.takePendingChatNudges = takePendingChatNudges; this.releaseChatNudges = releaseChatNudges;',
    context,
  );
  return { context, model, logs };
}

const fresh = () => [
  { _id: 'n1', userId: 'k', channel: 'chat', deliveredAt: null, type: 'reminder', agentId: null, releases: 0, createdAt: 1 },
  { _id: 'n2', userId: 'k', channel: 'chat', deliveredAt: null, type: 'reminder', agentId: null, createdAt: 2 },
];

test('take, release, take again; the third release is refused and the note stays delivered', async () => {
  const { context, model } = load(fresh());
  const ids = (list) => Array.from(list, (n) => String(n._id)); /* host arrays, not the vm realm's */
  assert.deepEqual(ids(await context.takePendingChatNudges('k', 5)), ['n1', 'n2']);
  assert.deepEqual(ids(await context.takePendingChatNudges('k', 5)), [], 'taken notes are not taken twice');
  assert.equal(await context.releaseChatNudges(['n1', 'n2']), 2);
  assert.deepEqual(ids(await context.takePendingChatNudges('k', 5)), ['n1', 'n2'], 'the next turn gets them back');
  assert.equal(await context.releaseChatNudges(['n1', 'n2']), 2);
  assert.deepEqual(ids(await context.takePendingChatNudges('k', 5)), ['n1', 'n2']);
  assert.equal(await context.releaseChatNudges(['n1', 'n2']), 0, 'at most two releases');
  assert.ok(model.rows.every((r) => r.deliveredAt != null), 'still delivered after the cap');
  assert.ok(model.rows.every((r) => r.releases === 2));
});

test('release never throws and ignores empty input', async () => {
  const { context } = load(fresh());
  assert.equal(await context.releaseChatNudges(null), 0);
  assert.equal(await context.releaseChatNudges([]), 0);
  assert.equal(await context.releaseChatNudges(['n1']), 0, 'a note still waiting is not "released"');
});

test('two overlapping takes give each note to exactly one turn', async () => {
  const { context, model } = load(fresh());
  /* Both turns read before either marks: the read is the same, the mark decides. */
  const realFind = model.find;
  let reads = 0;
  let release;
  const bothRead = new Promise((r) => (release = r));
  model.find = (filter) => {
    const q = realFind(filter);
    if (filter.deliveredAt === null && filter.channel === 'chat') {
      reads += 1;
      const lean = q.lean;
      const wrap = {
        sort: () => wrap,
        limit: (n) => {
          const limited = q.limit(n);
          return {
            lean: async () => {
              const out = await limited.lean();
              if (reads >= 2) release();
              await bothRead;
              return out;
            },
          };
        },
        lean,
      };
      return wrap;
    }
    return q;
  };
  const [a, b] = await Promise.all([context.takePendingChatNudges('k', 5), context.takePendingChatNudges('k', 5)]);
  const all = [...a, ...b].map((n) => String(n._id)).sort();
  assert.deepEqual(all, ['n1', 'n2'], 'every note went to one turn, none to both');
});

test('request.js puts notes back on every unfinished path and checks ownership before each ending (TURN-9, TURN-4)', () => {
  const request = fs.readFileSync(path.join(__dirname, '../controllers/agents/request.js'), 'utf8');
  const resumable = request.slice(
    request.indexOf('const ResumableAgentController'),
    request.indexOf('const AgentController ='),
  );
  assert.equal(resumable.split('putBackNotes()').length - 1, 5, 'replaced, failed part, stopped, error, last-resort');
  assert.match(resumable, /const stepAside = async \(\{ settle, currentCreatedAt \}\) => \{\s+putBackNotes\(\);/);
  /* every emitDone in the controller is behind a fresh ownership look */
  const emits = resumable.split('await GenerationJobManager.emitDone(streamId, finalEvent);');
  assert.equal(emits.length - 1, 2);
  for (const before of emits.slice(0, -1)) {
    const tail = before.slice(-700);
    assert.match(tail, /await newerJobCreatedAt\(\);\s+if \(replacedBefore(?:Aborted)?Final\) \{/);
  }
  /* only the real stop signal counts as a stop */
  assert.match(resumable, /const wasAborted = job\.abortController\.signal\.aborted;\n/);
  const client = fs.readFileSync(path.join(__dirname, '../controllers/agents/client.js'), 'utf8');
  assert.match(client, /this\._kadeTurnFailed = true;\s+logger\.error\(\s+'\[api\/server\/controllers\/agents\/client\.js #sendCompletion\] Unhandled error type'/);
  assert.match(client, /this\._kadeTakenNudgeIds = \(taken \|\| \[\]\)\.map\(\(nudge\) => String\(nudge\._id\)\);/);
});
