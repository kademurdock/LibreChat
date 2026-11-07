'use strict';
/* KADE Nov 7 2026: the website auto-play chunker never sends half of a %%%steering tag%%%.
 * Runs the REAL createChunkProcessor (streamAudio.js, scrubForSpeech.js, speechCap.js, tagSafe.js) with the four
 * modules it needs from the rest of the app replaced by stubs, so it needs no build:
 *   node --test api/server/services/Files/Audio/streamAudio.chunker.nodetest.js
 * (The Jest spec next to it needs the whole monorepo built; its cases for text without a tag are repeated in
 * the first test here so the two can be compared.) */
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const SEPARATORS = ['.', '?', '!', '۔', '。', '‥', ';', '¡', '¿', '\n', '```'];
let cacheImpl = null;
let dbImpl = async () => null;
/** packages/data-provider/src/parsers.ts, copied: what the chunker used before it knew about tags. */
function dataProviderFindLastSeparatorIndex(text, separators = SEPARATORS) {
  let lastIndex = -1;
  for (const separator of separators) {
    const index = text.lastIndexOf(separator);
    if (index > lastIndex) {
      lastIndex = index;
    }
  }
  return lastIndex;
}
const stubs = {
  '@librechat/data-schemas': { scopedCacheKey: (key) => key },
  'librechat-data-provider': {
    Time: { FIVE_MINUTES: 300000 },
    CacheKeys: { MESSAGES: 'messages' },
    SEPARATORS,
    findLastSeparatorIndex: dataProviderFindLastSeparatorIndex,
    parseTextParts: (content) => (Array.isArray(content) ? content.map((part) => (part && part.text) || '').join('') : String(content)),
  },
  '~/cache': { getLogStores: () => cacheImpl },
  '~/models': { getMessage: (...args) => dbImpl(...args) },
};
function loadStreamAudio() {
  const original = Module._load;
  Module._load = function (request) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) {
      return stubs[request];
    }
    return original.apply(this, arguments);
  };
  try {
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(__dirname + path.sep)) {
        delete require.cache[key];
      }
    }
    return require('./streamAudio');
  } finally {
    Module._load = original;
  }
}
const { createChunkProcessor } = loadStreamAudio();

/** Poll a processor once per state; a state is { text, complete } (as the cache holds it) or a bare string. */
async function polls(states, maxInputChars = 100000) {
  const holder = { value: null };
  cacheImpl = { get: async () => holder.value, set: async () => true };
  const processChunks = createChunkProcessor('user', 'message', maxInputChars);
  const results = [];
  for (const state of states) {
    holder.value = state;
    results.push(await processChunks());
  }
  return results;
}
const growing = (text) => ({ text, complete: false });
const done = (text) => ({ text, complete: true });
const piece = (text, isFinished = false) => ({ text, isFinished });

test('text without a tag is cut exactly as before (the Jest spec cases)', async () => {
  const [a] = await polls([growing('This is a long message. It should be split into chunks. Lol hi mom')]);
  assert.deepEqual(a, [piece('This is a long message. It should be split into chunks.')]);
  const text = 'This is a long message without separators hello there my friend';
  assert.deepEqual((await polls([growing(text)]))[0], [piece(text)]);
  assert.deepEqual((await polls([done('This is a finished message.')]))[0], [piece('This is a finished message.', true)]);
  assert.deepEqual((await polls(['This is a message as a string.']))[0], [piece('This is a message as a string.')]);
  assert.deepEqual((await polls([done('This is a finished message.'), done('This is a finished message.')]))[1], []);
});

test('a poll that lands inside a tag waits for its closer', async () => {
  // (no separator in front of the tag: the old rule sent the whole remainder, half a tag included)
  const [first, second, third] = await polls([
    growing('Sure thing and then some %%%warm and a little teasing'),
    growing("Sure thing and then some %%%warm and a little teasing%%% So what's the shape of it? And"),
    done("Sure thing and then some %%%warm and a little teasing%%% So what's the shape of it? And then some."),
  ]);
  assert.deepEqual(first, [piece('Sure thing and then some ')]);
  assert.deepEqual(second, [piece("%%%warm and a little teasing%%% So what's the shape of it?")]);
  assert.deepEqual(third, [piece('And then some.', true)]);
});

test('a sentence in front of a half-arrived tag is spoken, the tag waits', async () => {
  const [first, second] = await polls([
    growing('Sure thing.\n\n%%%warm and a little teasing'),
    growing("Sure thing.\n\n%%%warm and a little teasing%%% So what's the shape of it? And"),
  ]);
  assert.deepEqual(first, [piece('Sure thing.\n\n')]);
  assert.deepEqual(second, [piece("%%%warm and a little teasing%%% So what's the shape of it?")]);
});

test('a tag at the very start waits, and nothing is sent until its closer is there', async () => {
  const [first, second] = await polls([
    growing('%%%warm and a little teasing, quietly'),
    growing('%%%warm and a little teasing, quietly%%% Hello there my friend, how'),
  ]);
  assert.deepEqual(first, []);
  assert.deepEqual(second, [piece('%%%warm and a little teasing, quietly%%% Hello there my friend, how')]);
});

test('a separator inside a tag is not a place to cut', async () => {
  const text = '%%%like she is sharing a secret. quietly%%% okay then, and so it goes on and on';
  const [first] = await polls([growing(text)]);
  assert.deepEqual(first, [piece(text)], 'no separator outside the tag: the old rule sends the whole remainder');
  const [second] = await polls([growing(`${text}. Next one starts`)]);
  assert.deepEqual(second, [piece(`${text}.`)]);
});

test('a piece never starts on a bare closer', async () => {
  const [first, second] = await polls([
    growing('Hello there friend.%%% Then more words follow here and keep on'),
    done('Hello there friend.%%% Then more words follow here and keep on going.'),
  ]);
  assert.deepEqual(first, [piece('Hello there friend.%%%')]);
  assert.deepEqual(second, [piece('Then more words follow here and keep on going.', true)]);
});

test("Kiana's reply: an empty %%% line in front of the real tag does not hold the whole reply back", async () => {
  const head = 'Two different problems.\n\n%%%\n%%%warm and a little curious about it';
  const [first, second, third, fourth] = await polls([
    growing('Two different problems.\n\n%%%\n%%%warm and a little curi'),
    growing(head),
    growing(`${head}%%% So what's the shape of it? Then`),
    done(`${head}%%% So what's the shape of it? Then we go.`),
  ]);
  assert.deepEqual(first, [piece('Two different problems.\n\n%%%\n')], 'the stray line leaves with the sentence before it');
  assert.deepEqual(second, [], 'the REAL tag is the one that waits (a plain count of runs would have waited on the speech)');
  assert.deepEqual(third, [piece("%%%warm and a little curious about it%%% So what's the shape of it?")], 'and it arrives whole');
  assert.deepEqual(fourth, [piece('Then we go.', true)]);
});

test('a message that finishes while a tag is open sends the whole tag in the last piece', async () => {
  const [first, second, third] = await polls([
    growing('Hi there.\n\n%%%warm and a little teasing'),
    growing('Hi there.\n\n%%%warm and a little teasing, almost'),
    done('Hi there.\n\n%%%warm and a little teasing, almost%%% Come in.'),
  ]);
  assert.deepEqual(first, [piece('Hi there.\n\n')]);
  assert.deepEqual(second, []);
  assert.deepEqual(third, [piece('%%%warm and a little teasing, almost%%% Come in.', true)]);
});

test('a tag held on text that stopped growing is released after four polls', async () => {
  const stuck = growing('%%%warm and a little teasing, quietly');
  const results = await polls([stuck, stuck, stuck, stuck, stuck]);
  assert.deepEqual(results.slice(0, 4), [[], [], [], []]);
  assert.deepEqual(results[4], [piece('%%%warm and a little teasing, quietly')], 'never held forever');
});

test('the live path is untouched: a finished message is one finished piece, tags and all', async () => {
  const text = '%%%warm and easy like catching up with someone you like%%% Hey, there you are. %%%amused%%% Nothing new here.\n\n%%%fond%%% Anyway, tell me about you.';
  const store = new Map();
  cacheImpl = { get: async (key) => store.get(key), set: async (key, value) => (store.set(key, value), true) };
  dbImpl = async () => ({ text });
  try {
    const processChunks = createChunkProcessor('user', 'message');
    assert.deepEqual(await processChunks(), [piece(text, true)]);
    assert.deepEqual(await processChunks(), [], 'and nothing is left to send afterwards');
  } finally {
    dbImpl = async () => null;
  }
});

// ── the property: random tagged replies, random polling, the pieces never cut a tag ─────────────────────────────

function rng(seed) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const BODIES = [
  'warm', 'amused', 'sheepish', 'wistful, a little teasing', 'amused and baffled', 'apologetic and a little flustered',
  'warm and easy like catching up with someone you like', 'matter of fact with a bit of pride', 'quiet, almost to herself',
  'like she is sharing a secret. quietly', 'laughing, then catching her breath? almost', 'fond and curious',
];
const SENTENCES = [
  'Hey, there you are.', "I feel like I haven't seen you in a month, and it's been what, nine days?",
  'Nothing new here.', 'The neighbor got a leaf blower and now every Saturday sounds like an airport, so that is my life.',
  'Anyway, tell me about you', 'How did the thing go, the thing you were nervous about?', 'Oh, you are back already!',
  'I made too much rice again and somebody has to help me with it', 'Sit down.',
];
function makeReply(rnd) {
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const paragraphs = [];
  for (let p = 1 + Math.floor(rnd() * 4); p > 0; p--) {
    const sentences = [];
    for (let s = 1 + Math.floor(rnd() * 3); s > 0; s--) sentences.push(pick(SENTENCES));
    paragraphs.push(`%%%${pick(BODIES)}%%% ${sentences.join(' ')}`);
  }
  return paragraphs.join('\n\n');
}
/** Prefix lengths a poller might see: random steps of 1-70 characters, the last one the whole reply. */
function schedule(rnd, length) {
  const lengths = [];
  for (let at = 1 + Math.floor(rnd() * 70); at < length; at += 1 + Math.floor(rnd() * 70)) lengths.push(at);
  lengths.push(length);
  return lengths;
}
/** The chunker as it was before this change (the incomplete branch of createChunkProcessor), for comparison. */
function oldBoundaries(reply, lengths) {
  const lastSeparator = (text) => Math.max(...SEPARATORS.map((separator) => text.lastIndexOf(separator)));
  let processed = '';
  const boundaries = [];
  for (const length of lengths) {
    const text = reply.slice(0, length);
    const remaining = text.slice(processed.length);
    if (length < reply.length && remaining.length >= 20) {
      const index = lastSeparator(remaining);
      if (index !== -1) {
        processed += remaining.slice(0, index + 1);
      } else {
        processed = text;
      }
      boundaries.push(processed.length);
    }
  }
  return boundaries;
}
const spansOf = (reply) => [...reply.matchAll(/%%%[^%]+%%%/g)].map((m) => [m.index, m.index + m[0].length]);
const cuts = (boundaries, spans) => boundaries.filter((b) => spans.some(([start, end]) => b > start && b < end)).length;

test('random tagged replies, random polling: no piece ever cuts a tag, nothing is lost or sent twice', async () => {
  const rnd = rng(20261107);
  let trials = 0;
  let oldCutTrials = 0;
  let newCutTrials = 0;
  let lost = 0;
  let startedOnCloser = 0;
  for (let i = 0; i < 1500; i++) {
    const reply = makeReply(rnd);
    const lengths = schedule(rnd, reply.length);
    const spans = spansOf(reply);
    trials++;
    if (cuts(oldBoundaries(reply, lengths), spans) > 0) oldCutTrials++;

    const states = lengths.map((length) => ({ text: reply.slice(0, length), complete: length >= reply.length }));
    const pieces = (await polls(states)).flat();
    let offset = 0;
    const boundaries = [];
    for (const p of pieces) {
      if (!p.isFinished) {
        offset += p.text.length;
        boundaries.push(offset);
      }
    }
    if (cuts(boundaries, spans) > 0) newCutTrials++;
    if (pieces.map((p) => p.text).join('').replace(/\s+/g, '') !== reply.replace(/\s+/g, '')) lost++;
    if (pieces.slice(1).some((p) => /^\s*%%%/.test(p.text) && !/^\s*%%%[^%]+%%%/.test(p.text))) startedOnCloser++;
    assert.ok(pieces.length > 0 && pieces[pieces.length - 1].isFinished, 'the stream ends with a finished piece');
  }
  assert.ok(oldCutTrials >= 15, `the old chunker must cut some of these (it cut ${oldCutTrials} of ${trials}), or this test proves nothing`);
  assert.equal(newCutTrials, 0, `${newCutTrials} of ${trials} replies had a tag cut`);
  assert.equal(lost, 0, `${lost} replies lost or repeated text`);
  assert.equal(startedOnCloser, 0);
});
