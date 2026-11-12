'use strict';
/* KADE Nov 12 2026 (phase 4 pick 4): exact resume of the reply stream by cursor.
 * The route's writeEvent / onDone / subscribe steps are rebuilt here exactly as index.js wires
 * them, around a fake manager that numbers and logs events the way GenerationJobManager does in
 * in-memory mode (its own log is covered by GenerationJobManager.resumeReplay.spec.ts).
 * Run: node --test api/server/routes/agents/kadeStreamResume.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseKadeCursor, createKadeStreamResume, kadeStreamLogOn } = require('./kadeStreamResume');

class FakeManager {
  constructor() {
    this.seqs = new WeakMap();
    this.logs = new Map();
    this.listeners = new Map();
    /** Runs inside subscribe, before it resolves: lets a test emit while a replay is written. */
    this.duringSubscribe = null;
    this.finalEvent = null;
  }
  newJob(streamId, epoch) {
    this.logs.set(streamId, { epoch, next: 1, floor: 0, entries: [] });
    this.listeners.set(streamId, new Set());
    this.finalEvent = null;
  }
  emit(streamId, event) {
    const log = this.logs.get(streamId);
    const seq = log.next++;
    log.entries.push({ seq, event });
    this.seqs.set(event, { epoch: log.epoch, seq });
    for (const l of this.listeners.get(streamId)) l.onChunk(event);
  }
  done(streamId, event) {
    this.finalEvent = event;
    for (const l of this.listeners.get(streamId)) l.onDone(event);
  }
  kadeIdOf(event) {
    return event && typeof event === 'object' ? this.seqs.get(event) : undefined;
  }
  kadeReplayAfter(streamId, epoch, afterSeq) {
    const log = this.logs.get(streamId);
    if (!log) return null;
    if (log.epoch !== epoch) return { exact: false, reason: 'other-job', events: [] };
    if (!Number.isInteger(afterSeq) || afterSeq < log.floor || afterSeq > log.next - 1) {
      return { exact: false, reason: 'out-of-range', events: [] };
    }
    return { exact: true, events: log.entries.filter((e) => e.seq > afterSeq).map((e) => e.event) };
  }
  async subscribe(streamId, onChunk, onDone) {
    if (!this.listeners.has(streamId)) return null;
    const listener = { onChunk, onDone };
    this.listeners.get(streamId).add(listener);
    if (this.finalEvent) {
      const final = this.finalEvent;
      setImmediate(() => onDone(final));
    }
    if (this.duringSubscribe) {
      const hook = this.duringSubscribe;
      this.duringSubscribe = null;
      await hook();
    }
    await new Promise((r) => setImmediate(r));
    return { unsubscribe: () => this.listeners.get(streamId).delete(listener) };
  }
}

/** One GET /chat/stream/:streamId, wired the way index.js wires it. */
async function connect(manager, streamId, { kadeSeq = true, lastEventId, env = {} } = {}) {
  const res = { writes: [], writableEnded: false };
  res.write = (chunk) => res.writes.push(chunk);
  res.end = () => {
    res.writableEnded = true;
  };
  const req = {
    query: kadeSeq ? { kadeSeq: '1' } : {},
    get: (name) => (name === 'Last-Event-ID' ? lastEventId : undefined),
  };
  const kadeResume = createKadeStreamResume({ req, manager, env });
  const writeEvent = (event, options = {}) => {
    if (!res.writableEnded) {
      const idLine = kadeResume.idLine(event);
      if (idLine === null) return true;
      const eventName = options.eventName ?? 'message';
      res.write(`${idLine}event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`);
      return true;
    }
    return false;
  };
  const onDone = (event) => {
    if (kadeResume.holdDone(event)) return;
    writeEvent(event, { final: true });
    res.end();
  };
  const onError = (error) => {
    if (!res.writableEnded) {
      writeEvent({ error }, { eventName: 'error' });
      res.end();
    }
  };
  let result;
  if (kadeResume.cursor) {
    const resumed = await kadeResume.subscribe({ streamId, writeEvent, onDone, onError, subscriptionOptions: {}, res });
    if (resumed.ended) return { res, result: null };
    result = resumed.result;
  } else {
    result = await manager.subscribe(streamId, writeEvent, onDone, onError, {});
  }
  return { res, result };
}

const text = (t) => ({ event: 'on_message_delta', data: { delta: { content: [{ type: 'text', text: t }] } } });
/** Parse the SSE frames a fake response received. */
function frames(res) {
  return res.writes.map((w) => {
    const id = /^id: (.+)$/m.exec(w);
    const ev = /^event: (.+)$/m.exec(w);
    const data = JSON.parse(/^data: (.+)$/m.exec(w)[1]);
    return { id: id ? id[1] : undefined, event: ev[1], data };
  });
}
const words = (res) =>
  frames(res)
    .filter((f) => f.data.data && f.data.data.delta)
    .map((f) => f.data.data.delta.content[0].text);
const lastId = (res) => frames(res).filter((f) => f.id).at(-1).id;
const tick = () => new Promise((r) => setImmediate(r));

test('cursor parsing takes only epoch-seq', () => {
  assert.deepEqual(parseKadeCursor('9f3a1c2e-128'), { epoch: '9f3a1c2e', seq: 128 });
  assert.deepEqual(parseKadeCursor(' 9f3a1c2e-0 '), { epoch: '9f3a1c2e', seq: 0 });
  assert.equal(parseKadeCursor('128'), null);
  assert.equal(parseKadeCursor('9F3A1C2E-1'), null);
  assert.equal(parseKadeCursor('9f3a1c2e-12x'), null);
  assert.equal(parseKadeCursor('9f3a1c2e-1234567890'), null);
  assert.equal(parseKadeCursor(undefined), null);
  assert.equal(kadeStreamLogOn({}), true);
  assert.equal(kadeStreamLogOn({ KADE_STREAM_LOG: '0' }), false);
});

test('a client that does not ask for ids gets the old wire, byte for byte', async () => {
  const m = new FakeManager();
  m.newJob('s', 'aaaaaaaa');
  const { res } = await connect(m, 's', { kadeSeq: false, lastEventId: 'aaaaaaaa-0' });
  m.emit('s', text('One.'));
  assert.equal(res.writes[0], `event: message\ndata: ${JSON.stringify(text('One.'))}\n\n`);
});

test('KADE_STREAM_LOG=0: no ids and no cursor branch even when asked', async () => {
  const m = new FakeManager();
  m.newJob('s', 'aaaaaaaa');
  m.emit('s', text('Zero.'));
  const { res } = await connect(m, 's', { lastEventId: 'aaaaaaaa-0', env: { KADE_STREAM_LOG: '0' } });
  m.emit('s', text('One.'));
  assert.deepEqual(words(res), ['One.']);
  assert.equal(frames(res)[0].id, undefined);
});

test('drop and reconnect: every word arrives once, in order, and the final frame comes last', async () => {
  const m = new FakeManager();
  m.newJob('s', 'abcdef01');
  const first = await connect(m, 's');
  m.emit('s', text('One. '));
  m.emit('s', text('Two. '));
  assert.deepEqual(words(first.res), ['One. ', 'Two. ']);
  const cursor = lastId(first.res);
  assert.equal(cursor, 'abcdef01-2');
  first.result.unsubscribe(); // the drop
  m.emit('s', text('Three. '));
  m.emit('s', text('Four. '));
  /* While the replay is being written, one more word and the final frame arrive. */
  m.duringSubscribe = async () => {
    m.emit('s', text('Five.'));
    m.done('s', { final: true, text: 'One. Two. Three. Four. Five.' });
    await tick();
  };
  const second = await connect(m, 's', { lastEventId: cursor });
  await tick();
  assert.deepEqual(words(second.res), ['Three. ', 'Four. ', 'Five.']);
  const all = frames(second.res);
  assert.equal(all.at(-1).data.final, true, 'the final frame is written after the replay');
  assert.equal(all.filter((f) => f.data.final).length, 1);
  assert.equal(second.res.writableEnded, true);
  assert.deepEqual(
    all.filter((f) => f.id).map((f) => f.id),
    ['abcdef01-3', 'abcdef01-4', 'abcdef01-5'],
  );
});

test('a cursor at the very end gets only what comes next', async () => {
  const m = new FakeManager();
  m.newJob('s', 'abcdef02');
  m.emit('s', text('One.'));
  const { res } = await connect(m, 's', { lastEventId: 'abcdef02-1' });
  m.emit('s', text('Two.'));
  assert.deepEqual(words(res), ['Two.']);
});

test('a cursor from a replaced turn says other-job and ends the stream', async () => {
  const m = new FakeManager();
  m.newJob('s', 'abcdef03');
  m.emit('s', text('New turn.'));
  const { res, result } = await connect(m, 's', { lastEventId: 'deadbeef-7' });
  assert.equal(result, null);
  assert.equal(res.writableEnded, true);
  assert.deepEqual(frames(res), [{ id: undefined, event: 'kade_gap', data: { reason: 'other-job' } }]);
  m.emit('s', text('More.'));
  assert.equal(res.writes.length, 1, 'never handed the new turn');
});

test('an out-of-range cursor says so, then runs the plain subscribe', async () => {
  const m = new FakeManager();
  m.newJob('s', 'abcdef04');
  m.emit('s', text('One.'));
  const { res } = await connect(m, 's', { lastEventId: 'abcdef04-99' });
  m.emit('s', text('Two.'));
  const all = frames(res);
  assert.deepEqual(all[0], { id: undefined, event: 'kade_gap', data: { reason: 'out-of-range' } });
  assert.deepEqual(words(res), ['Two.']);
});

test('no log for the job (Redis, or made before the switch): no-log gap, then the plain subscribe', async () => {
  const m = new FakeManager();
  m.listeners.set('s', new Set());
  const { res } = await connect(m, 's', { lastEventId: 'abcdef05-3' });
  assert.deepEqual(frames(res)[0], { id: undefined, event: 'kade_gap', data: { reason: 'no-log' } });
  assert.equal(res.writableEnded, false);
});

test('the same event handed over twice is written once', async () => {
  const m = new FakeManager();
  m.newJob('s', 'abcdef06');
  const { res } = await connect(m, 's');
  const one = text('Once.');
  m.emit('s', one);
  for (const l of m.listeners.get('s')) l.onChunk(one); // a second delivery of the same object
  assert.deepEqual(words(res), ['Once.']);
});
