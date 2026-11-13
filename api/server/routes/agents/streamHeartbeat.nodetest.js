'use strict';
/* WEB-13 (Nov 12 2026): the reply stream's heartbeat. The helpers are cut out of index.js by text
 * (the route file needs the whole server to load) and run against a fake response with a mocked
 * clock. Run: node --test api/server/routes/agents/streamHeartbeat.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');

const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('const DEFAULT_SSE_HEARTBEAT_MS');
const end = source.indexOf('/**\n * @route GET /chat/stream/:streamId');
assert.ok(start > 0 && end > start, 'heartbeat helpers found in index.js');
const load = new Function(
  'process',
  'logger',
  `${source.slice(start, end)}\nreturn { startStreamHeartbeat, sseHeartbeatMs, sseHeartbeatIdleCapMs };`,
);

class FakeRes extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.writableEnded = false;
    this.destroyed = false;
  }
  write(chunk) {
    this.writes.push(chunk);
    return true;
  }
}

const quietLogger = { warn: () => undefined };
const withEnv = (env = {}) => load({ env }, quietLogger);
const mockClock = (t) => t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1e12 });

test('writes a comment line every 20 s until the response ends', (t) => {
  mockClock(t);
  const { startStreamHeartbeat } = withEnv();
  const res = new FakeRes();
  assert.ok(startStreamHeartbeat(res));
  t.mock.timers.tick(19999);
  assert.equal(res.writes.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(res.writes, [': ping\n\n']);
  t.mock.timers.tick(20000);
  assert.equal(res.writes.length, 2);
  res.writableEnded = true;
  t.mock.timers.tick(60000);
  assert.equal(res.writes.length, 2, 'nothing after the end');
});

test('stops when the client goes away', (t) => {
  mockClock(t);
  const { startStreamHeartbeat } = withEnv();
  const res = new FakeRes();
  startStreamHeartbeat(res);
  res.emit('close');
  t.mock.timers.tick(60000);
  assert.equal(res.writes.length, 0);
});

test('goes quiet for good after 240 s with no real event, so the clients can time out', (t) => {
  mockClock(t);
  const { startStreamHeartbeat } = withEnv();
  const res = new FakeRes();
  startStreamHeartbeat(res);
  t.mock.timers.tick(220000);
  assert.equal(res.writes.length, 11, 'pings up to 220 s');
  t.mock.timers.tick(20000);
  assert.equal(res.writes.length, 11, 'no ping at 240 s');
  t.mock.timers.tick(600000);
  assert.equal(res.writes.length, 11, 'silent from then on, longer than any client timeout');
});

test('a real event restarts the 240 s allowance', (t) => {
  mockClock(t);
  const { startStreamHeartbeat } = withEnv();
  const res = new FakeRes();
  const beat = startStreamHeartbeat(res);
  t.mock.timers.tick(200000);
  beat.noteRealWrite();
  t.mock.timers.tick(220000);
  assert.equal(res.writes.length, 21, 'still pinging 420 s in, 220 s after the event');
  t.mock.timers.tick(20000);
  assert.equal(res.writes.length, 21, 'quiet 240 s after the last event');
});

test('env: heartbeat 0 is off; cap 0 never stops; numbers set the gaps; junk keeps defaults', (t) => {
  mockClock(t);
  assert.equal(withEnv({ KADE_SSE_HEARTBEAT_MS: '0' }).startStreamHeartbeat(new FakeRes()), null);
  assert.equal(withEnv({ KADE_SSE_HEARTBEAT_MS: '5000' }).sseHeartbeatMs(), 5000);
  assert.equal(withEnv({ KADE_SSE_HEARTBEAT_MS: 'soon' }).sseHeartbeatMs(), 20000);
  assert.equal(withEnv({ KADE_SSE_HEARTBEAT_MS: '' }).sseHeartbeatMs(), 20000);
  assert.equal(withEnv().sseHeartbeatIdleCapMs(), 240000);
  assert.equal(withEnv({ KADE_SSE_HEARTBEAT_IDLE_CAP_MS: 'x' }).sseHeartbeatIdleCapMs(), 240000);
  const res = new FakeRes();
  withEnv({ KADE_SSE_HEARTBEAT_IDLE_CAP_MS: '0' }).startStreamHeartbeat(res);
  t.mock.timers.tick(600000);
  assert.equal(res.writes.length, 30, 'cap 0: pings for the whole stream, the old behaviour');
});

/* Sweep 4.0 (Nov 13 2026): the quiet-cap follows the job, not the connection. */
test('a reconnect to a job that has been silent past the cap gets no fresh allowance', (t) => {
  mockClock(t);
  const { startStreamHeartbeat } = withEnv();
  const jobLastEventAt = 1e12 - 250000; // the job last emitted 250 s before this connection opened
  const res = new FakeRes();
  const beat = startStreamHeartbeat(res, () => jobLastEventAt);
  beat.noteRealWrite(); // the resume sync / replay write: not activity
  t.mock.timers.tick(600000);
  assert.equal(res.writes.length, 0, 'no pings: the web watchdog sees silence from the start');
});

test('across two connections the pings stop 240 s after the job went quiet, whatever was written', (t) => {
  mockClock(t);
  const { startStreamHeartbeat } = withEnv();
  const jobAt = 1e12; // last real event at connect time
  const first = new FakeRes();
  startStreamHeartbeat(first, () => jobAt);
  t.mock.timers.tick(200000);
  assert.equal(first.writes.length, 10);
  first.emit('close');
  const second = new FakeRes();
  const beat = startStreamHeartbeat(second, () => jobAt);
  beat.noteRealWrite(); // sync event on the new connection
  t.mock.timers.tick(20000);
  assert.equal(second.writes.length, 1, 'one ping at 220 s of job silence');
  t.mock.timers.tick(600000);
  assert.equal(second.writes.length, 1, 'then quiet: the cap was the job\'s, not the connection\'s');
});

test('a job that emits again after the cap gets its pings back on the same connection', (t) => {
  mockClock(t);
  const { startStreamHeartbeat } = withEnv();
  let jobAt = 1e12;
  const res = new FakeRes();
  startStreamHeartbeat(res, () => jobAt);
  t.mock.timers.tick(220000); // (one big tick would move the mocked clock to its end first)
  t.mock.timers.tick(80000);
  assert.equal(res.writes.length, 11, 'quiet from 240 s');
  jobAt = 1e12 + 300000; // a long silent tool finished and the job emitted
  t.mock.timers.tick(40000);
  assert.equal(res.writes.length, 13, 'pinging again');
});

test('KADE_SSE_HEARTBEAT_FOLLOW_JOB=0, or no job time, keeps the per-connection clock', (t) => {
  mockClock(t);
  const off = withEnv({ KADE_SSE_HEARTBEAT_FOLLOW_JOB: '0' });
  const res = new FakeRes();
  off.startStreamHeartbeat(res, () => 1e12 - 250000);
  t.mock.timers.tick(220000);
  assert.equal(res.writes.length, 11, 'switch off: a fresh 240 s per connection, as before');
  const res2 = new FakeRes();
  withEnv().startStreamHeartbeat(res2, () => undefined);
  t.mock.timers.tick(40000);
  assert.equal(res2.writes.length, 2, 'unknown job time falls back to the connection clock');
  const res3 = new FakeRes();
  withEnv().startStreamHeartbeat(res3, () => {
    throw new Error('boom');
  });
  t.mock.timers.tick(40000);
  assert.equal(res3.writes.length, 2, 'a throwing getter falls back too');
});

test('the stream route hands the heartbeat the job clock', () => {
  assert.match(
    source,
    /startStreamHeartbeat\(res, \(\) =>\s+typeof GenerationJobManager\.kadeLastEventAt === 'function'\s+\? GenerationJobManager\.kadeLastEventAt\(streamId\)/,
  );
});
