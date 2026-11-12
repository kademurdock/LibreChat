/**
 * Listening while a video is still being described (phase 4 pick 2, Nov 12 2026): ahead.ts.
 *
 * Run: node --import tsx --test packages/api/src/description/ahead.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { listenAheadOn, readyPrefix, startAdvice } from './ahead.ts';

test('readyPrefix stops at the first section not kept yet', () => {
  assert.deepEqual(readyPrefix([1, 1, null, 1], [0, 1, 2, 3]), [0, 1]);
  assert.deepEqual(readyPrefix([], [0, 1, 2]), []);
  assert.deepEqual(readyPrefix([0, 2, 2], [0, 1, 2]), [0, 1, 2]);
  assert.deepEqual(readyPrefix([1, undefined, 1], [0, 1, 2]), [0]);
  /* A preview's scope stops early: nothing past it is offered. */
  assert.deepEqual(readyPrefix([1, 1, 1, 1], [0, 1]), [0, 1]);
});

test('startAdvice: start now, wait, or no estimate yet', () => {
  assert.deepEqual(startAdvice(600, 600, 100), { readySeconds: 600, totalSeconds: 600, waitSeconds: 0 });
  assert.deepEqual(startAdvice(120, 1200, undefined), { readySeconds: 120, totalSeconds: 1200 });
  assert.deepEqual(startAdvice(0, 1200, 300), { readySeconds: 0, totalSeconds: 1200 });
  /* 20 minutes of film, 30 minutes of render left: wait 10 minutes at 1x. */
  assert.equal(startAdvice(120, 1200, 1800).waitSeconds, 600);
  /* At 2x the film lasts 10 minutes: wait 20. */
  assert.equal(startAdvice(120, 1200, 1800, 2).waitSeconds, 1200);
  /* Render finishes before she reaches the end: start now. */
  assert.equal(startAdvice(120, 1200, 900).waitSeconds, 0);
  /* A silly speed is clamped. */
  assert.equal(startAdvice(120, 1200, 1800, Number.NaN).waitSeconds, 600);
});

test('KADE_DESCRIPTION_LISTEN_AHEAD=0 turns it off; anything else is on', () => {
  const was = process.env.KADE_DESCRIPTION_LISTEN_AHEAD;
  try {
    delete process.env.KADE_DESCRIPTION_LISTEN_AHEAD;
    assert.equal(listenAheadOn(), true);
    process.env.KADE_DESCRIPTION_LISTEN_AHEAD = '0';
    assert.equal(listenAheadOn(), false);
    process.env.KADE_DESCRIPTION_LISTEN_AHEAD = '1';
    assert.equal(listenAheadOn(), true);
  } finally {
    if (was === undefined) delete process.env.KADE_DESCRIPTION_LISTEN_AHEAD;
    else process.env.KADE_DESCRIPTION_LISTEN_AHEAD = was;
  }
});
