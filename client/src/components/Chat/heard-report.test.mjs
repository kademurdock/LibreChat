import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlaybackLog,
  noteClipReceived,
  noteClipScheduled,
  heardAt,
  flushReport,
  heardClock,
} from './heard-report.mjs';

test('clips are numbered as they arrive, from 1', () => {
  const log = createPlaybackLog();
  assert.equal(noteClipReceived(log), 1);
  assert.equal(noteClipReceived(log), 2);
});

test('the clip playing now, and how far into it', () => {
  const log = createPlaybackLog();
  noteClipScheduled(log, 1, 10, 2);
  noteClipScheduled(log, 2, 12, 3);
  assert.deepEqual(heardAt(log, 9), { seq: 0, ms: 0 }, 'nothing started');
  assert.deepEqual(heardAt(log, 11.25), { seq: 1, ms: 1250 });
  assert.deepEqual(heardAt(log, 12.5), { seq: 2, ms: 500 });
  assert.deepEqual(heardAt(log, 20), { seq: 2, ms: 3000 }, 'finished clips report their length');
});

test('a flush reports once and the next report remembers it', () => {
  const log = createPlaybackLog();
  for (let i = 0; i < 3; i++) noteClipReceived(log);
  noteClipScheduled(log, 2, 0, 1);
  noteClipScheduled(log, 3, 1, 1);
  assert.deepEqual(flushReport(log, 1.4), { type: 'heard', seq: 3, ms: 400 });
  // The bridge's own clear right after the Stop button: same answer, nothing new played.
  assert.deepEqual(flushReport(log, 1.6), { type: 'heard', seq: 3, ms: 400 });
  // A clip that arrived but was not yet playing at the next flush never counts.
  noteClipReceived(log);
  noteClipScheduled(log, 4, 5, 1);
  assert.deepEqual(flushReport(log, 4.99), { type: 'heard', seq: 3, ms: 400 });
});

test('the clock takes off the output latency when the browser knows it', () => {
  assert.equal(heardClock({ currentTime: 5, outputLatency: 0.05 }), 4.95);
  assert.equal(heardClock({ currentTime: 5 }), 5);
  assert.equal(heardClock({ currentTime: 5, outputLatency: 7 }), 5, 'nonsense ignored');
  assert.equal(heardClock(null), 0);
});
