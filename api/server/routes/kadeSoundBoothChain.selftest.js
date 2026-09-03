'use strict';
/* Part 122. The chain's job is to make five renders sound like one person
 * reading one thing. These are the ways it silently would not.
 * Run: node --test kadeSoundBoothChain.selftest.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { deterministicSeed, sayProgress, MAX_PARTS } = require('./kadeSoundBoothChain');

test('THE VOICE SEED IS THE SAME FOR EVERY PART OF A PIECE', () => {
  const user = '6a3cba4d0b0afa92194e42f7';
  const seeds = [0, 1, 2, 3, 4].map((i) => deterministicSeed(user, `part ${i} text differs wildly`, i));
  assert.equal(new Set(seeds).size, 1, `parts got different seeds: ${seeds.join(', ')} — that is five different readers`);
});

test('different people get different voices, and the seed is a valid one', () => {
  const a = deterministicSeed('6a3cba4d0b0afa92194e42f7', 'x', 0);
  const b = deterministicSeed('6a6125d73939d20b95251078', 'x', 0);
  assert.notEqual(a, b);
  for (const s of [a, b]) {
    assert.ok(Number.isInteger(s) && s >= 0 && s < 100000, `seed ${s} out of range`);
  }
});

test('the seed is stable across calls — a resume must not change the reader', () => {
  const first = deterministicSeed('abc123', 'anything', 0);
  for (let i = 0; i < 50; i++) assert.equal(deterministicSeed('abc123', 'anything', i), first);
});

test('progress is spoken as part N of M, counting from one not zero', () => {
  const project = {
    parts: [
      { index: 0, state: 'done' },
      { index: 1, state: 'running' },
      { index: 2, state: 'pending' },
    ],
  };
  const line = sayProgress(project, null);
  assert.match(line, /^Part 2 of 3\./);
  assert.doesNotMatch(line, /Part 0/);
});

test('progress carries the wait line through, so a cold part is not silent', () => {
  const project = { parts: [{ index: 0, state: 'queued' }, { index: 1, state: 'pending' }] };
  const line = sayProgress(project, { spoken: 'Got a card. It is waking up, which takes about six minutes.' });
  assert.match(line, /^Part 1 of 2\./);
  assert.match(line, /waking up/);
});

test('a finished chain still speaks a sane part number', () => {
  const project = { parts: [{ index: 0, state: 'done' }, { index: 1, state: 'done' }] };
  assert.match(sayProgress(project, null), /^Part 2 of 2\./);
});

test('there is a part ceiling, so a pasted novel cannot open fifty renders', () => {
  assert.ok(MAX_PARTS > 1 && MAX_PARTS <= 20, `MAX_PARTS is ${MAX_PARTS}`);
});
