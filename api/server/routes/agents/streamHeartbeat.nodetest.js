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
