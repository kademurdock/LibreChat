import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playbackTime } from './clock.ts';

test('device clock interpolates the recent output timestamp without advancing past rendered audio', () => {
  const ctx = { currentTime: 10, state: 'running',
    getOutputTimestamp: () => ({ contextTime: 9.8, performanceTime: 1000 }) };
  assert.ok(Math.abs(playbackTime(ctx, 1050) - 9.85) < 1e-9);
  assert.equal(playbackTime(ctx, 1300), 10);
});

test('unsupported, uninitialized, invalid and stale device timestamps preserve the old audio clock', () => {
  const ctx = { currentTime: 10, state: 'running' };
  assert.equal(playbackTime(ctx, 1050), 10);
  for (const stamp of [{ contextTime: 0, performanceTime: 0 }, { contextTime: NaN, performanceTime: 1000 },
    { contextTime: 9, performanceTime: 50 }, { contextTime: 9, performanceTime: 2000 }]) {
    assert.equal(playbackTime({ ...ctx, getOutputTimestamp: () => stamp }, 1050), 10);
  }
  assert.equal(playbackTime({ ...ctx, getOutputTimestamp() { throw Error('device'); } }), 10);
});

test('suspended contexts do not advance from wall time', () => {
  const ctx = { currentTime: 10, state: 'suspended',
    getOutputTimestamp: () => ({ contextTime: 9.8, performanceTime: 1000 }) };
  assert.equal(playbackTime(ctx, 1050), 10);
  assert.equal(playbackTime(ctx, 5000), 10);
});
