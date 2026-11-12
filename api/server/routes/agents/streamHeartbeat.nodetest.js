'use strict';
/* WEB-13 (Nov 12 2026): the reply stream's heartbeat. The two helpers are cut out of index.js by
 * text (the route file needs the whole server to load) and run against a fake response with a
 * mocked clock. Run: node --test api/server/routes/agents/streamHeartbeat.nodetest.js */
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
  `${source.slice(start, end)}\nreturn { startStreamHeartbeat, sseHeartbeatMs };`,
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

const withEnv = (value) => load({ env: value == null ? {} : { KADE_SSE_HEARTBEAT_MS: value } });

test('writes a comment line every 20 s until the response ends', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { startStreamHeartbeat } = withEnv(undefined);
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
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { startStreamHeartbeat } = withEnv(undefined);
  const res = new FakeRes();
  startStreamHeartbeat(res);
  res.emit('close');
  t.mock.timers.tick(60000);
  assert.equal(res.writes.length, 0);
});

test('KADE_SSE_HEARTBEAT_MS=0 turns it off; a number sets the gap; junk keeps 20 s', () => {
  assert.equal(withEnv('0').startStreamHeartbeat(new FakeRes()), null);
  assert.equal(withEnv('5000').sseHeartbeatMs(), 5000);
  assert.equal(withEnv('soon').sseHeartbeatMs(), 20000);
  assert.equal(withEnv('').sseHeartbeatMs(), 20000);
});
