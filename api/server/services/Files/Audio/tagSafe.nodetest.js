'use strict';
/* KADE Nov 7 2026: the rules that keep a %%%steering tag%%% whole when a reply is spoken in pieces.
 * Plain node, no build:   node --test api/server/services/Files/Audio/tagSafe.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_SEPARATORS,
  scanTags,
  findLastSeparatorIndex,
  keepBareCloserWithPreviousPiece,
  planChunk,
} = require('./tagSafe');

/** The function librechat-data-provider ships (packages/data-provider/src/parsers.ts), the one this replaces. */
function dataProviderFindLastSeparatorIndex(text, separators = DEFAULT_SEPARATORS) {
  let lastIndex = -1;
  for (const separator of separators) {
    const index = text.lastIndexOf(separator);
    if (index > lastIndex) {
      lastIndex = index;
    }
  }
  return lastIndex;
}

test('a closed tight tag is a span, nothing is held back', () => {
  const text = '%%%warm%%% Hello there. More';
  assert.deepEqual(scanTags(text), { spans: [[0, 10]], openFrom: -1 });
});

test('an opener whose closer has not arrived is held back from its first percent sign', () => {
  assert.equal(scanTags('%%%warm and a lit').openFrom, 0);
  assert.equal(scanTags('Hi there.\n\n%%%warm and curi').openFrom, 11);
});

test('a padded tag is read the same way', () => {
  assert.deepEqual(scanTags('%%% warm %%% Hello'), { spans: [[0, 12]], openFrom: -1 });
  assert.equal(scanTags('%%% warm ').openFrom, 0);
});

test('a padded closer at the very end waits for the next character instead of starting a new tag', () => {
  assert.equal(scanTags('%%% warm %%%').openFrom, 0);
  // once the next character is there it is a closer
  assert.deepEqual(scanTags('%%% warm %%% '), { spans: [[0, 12]], openFrom: -1 });
});

test('the incident shape: an empty %%% line in front of the real tag does not turn the speech into a tag body', () => {
  const whole = 'Two different problems.\n\n%%%\n%%%warm and curious%%% So what is the shape of it? Then';
  const { spans, openFrom } = scanTags(whole);
  assert.equal(openFrom, -1, 'a plain count of runs would think a tag is open to the end');
  assert.equal(spans.length, 1);
  const [start, end] = spans[0];
  assert.equal(whole.slice(start, end), '%%%warm and curious%%%', 'the span is the REAL tag, not stray + opener');
  // halfway through the real tag the hold-back starts at the real opener, not at the stray
  const partial = 'Two different problems.\n\n%%%\n%%%warm and cur';
  assert.equal(scanTags(partial).openFrom, partial.indexOf('%%%warm'));
});

test('a bare closer (a word before it, a space after, nothing open) is ignored, not held', () => {
  assert.deepEqual(scanTags('Hello there.%%% Then more text'), { spans: [], openFrom: -1 });
});

test('a run at the very end could still be an opener, so it is held', () => {
  assert.equal(scanTags('Hello there.%%%').openFrom, 12);
  assert.equal(scanTags('Hello there.\n\n%%%').openFrom, 14);
});

test('two tags touching (a six-sign run) close the first and open the second', () => {
  const text = '%%%warm%%%%%%curious%%% yes';
  const { spans, openFrom } = scanTags(text);
  assert.equal(openFrom, -1);
  assert.equal(spans.length, 2);
  assert.equal(text.slice(spans[0][0], spans[0][1]).startsWith('%%%warm'), true);
  assert.equal(text.slice(spans[1][0], spans[1][1]).endsWith('curious%%%'), true);
});

test('a half-arrived delimiter at the end is held, a real percent sign is not', () => {
  assert.equal(scanTags('and then %%').openFrom, 9);
  assert.equal(scanTags('and then %').openFrom, 9);
  assert.equal(scanTags('The rate is 50%').openFrom, -1, '"50%" stays with its number');
  assert.equal(scanTags('The rate is 50 %').openFrom, -1);
  assert.equal(scanTags('no percent signs at all').openFrom, -1);
});

test('a held tag is released when it cannot be a direction: too long, or across a paragraph', () => {
  const tight = '%%%' + 'a'.repeat(470);
  assert.equal(scanTags(tight).openFrom, -1, 'tight tags stop at 400 characters in the proxy');
  assert.equal(scanTags('%%%' + 'a'.repeat(400)).openFrom, 0);
  assert.equal(scanTags('%%% ' + 'a'.repeat(230)).openFrom, -1, 'padded tags stop at 200');
  assert.equal(scanTags('%%% ' + 'a'.repeat(150)).openFrom, 0);
  assert.equal(scanTags('%%%warm and soft\n\nthen the next paragraph begins').openFrom, -1, 'a tag never spans a blank line');
});

test('findLastSeparatorIndex ignores separators inside a tag, closed or open', () => {
  assert.equal(findLastSeparatorIndex('%%%like she is sharing a secret. quietly%%% okay then'), -1);
  assert.equal(findLastSeparatorIndex('Hi. %%%a. b%%% okay then'), 2);
  assert.equal(findLastSeparatorIndex('Hi there.\n\n%%%warm; and curious? and soft'), 10, 'before the open tag only');
  assert.equal(findLastSeparatorIndex('%%%warm and a lit. tle'), -1);
});

test('without a tag it is the data-provider function, exactly (4,000 random strings)', () => {
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const alphabet = ['a', 'b', 'c', ' ', ' ', '.', '?', '!', ';', '\n', '۔', '。', '‥', '¡', '¿', '`', '``', '```', 'é', '%', '5'];
  for (let i = 0; i < 4000; i++) {
    let text = '';
    const length = Math.floor(rnd() * 60);
    for (let k = 0; k < length; k++) {
      text += alphabet[Math.floor(rnd() * alphabet.length)];
    }
    if (/%{2,}/.test(text)) {
      continue; // delimiter runs are covered above
    }
    const expected = dataProviderFindLastSeparatorIndex(text);
    // (a lone % at the very end is held back, which only moves the answer when a separator sits after it: it cannot)
    assert.equal(findLastSeparatorIndex(text), expected, JSON.stringify(text));
  }
});

test('a piece never starts on a bare closer: the stray stays with the piece in front of it', () => {
  assert.equal(keepBareCloserWithPreviousPiece('Hello there.%%% Then more', 12), 15);
  // a padded OPENER after a space is not a bare closer
  assert.equal(keepBareCloserWithPreviousPiece('Hello there. %%% warm %%% Then', 12), 12);
  // a tight opener right after the separator is not one either
  assert.equal(keepBareCloserWithPreviousPiece('Hello there.%%%warm%%% Then', 12), 12);
  assert.equal(keepBareCloserWithPreviousPiece('Hello there. Then', 12), 12);
});

test('planChunk: text in front of a half-arrived tag goes, the tag waits', () => {
  assert.deepEqual(planChunk('Hi there.\n\n%%%warm and a little teasing'), { send: 'Hi there.\n\n', held: true });
});

test('planChunk: a tag at the very start with nothing before it sends nothing', () => {
  assert.deepEqual(planChunk('%%%warm and a little teasing, quietly'), { send: '', held: true });
});

test('planChunk: short text with no separator in front of a half-arrived tag waits for more', () => {
  assert.deepEqual(planChunk('Oh, hi %%%warm and a little teas'), { send: '', held: true });
  assert.deepEqual(planChunk('Oh hi there, how are you doing today %%%warm and a little teas'), {
    send: 'Oh hi there, how are you doing today ',
    held: true,
  });
});

test('planChunk: a stray closer at the next piece start moves to the end of this one', () => {
  assert.deepEqual(planChunk('Hello there.%%% Then more words follow and keep going'), { send: 'Hello there.%%%', held: false });
});

test('planChunk: release sends the tag as it is (a message that stopped growing)', () => {
  const tag = '%%%warm and a little teasing';
  assert.deepEqual(planChunk(tag, { release: true }), { send: tag, held: false });
  // with a sentence in front it still cuts where it always cut; the tag is the next piece
  assert.deepEqual(planChunk(`Hi there.\n\n${tag}`, { release: true }), { send: 'Hi there.\n\n', held: false });
});

test('planChunk: tag-free text is cut exactly where the old function cut it', () => {
  for (const text of [
    'This is a long message. It should be split into chunks. Lol hi mom',
    'This is a long message without separators hello there my friend',
    'One sentence here, then a line\nand another one right after it',
  ]) {
    const index = dataProviderFindLastSeparatorIndex(text);
    const expected = index === -1 ? text : text.slice(0, index + 1);
    assert.equal(planChunk(text).send, expected, text);
  }
});

test('nothing here is slow: 300,000 characters of runs and near-runs scan in well under a second', () => {
  const started = Date.now();
  for (const text of [
    '%'.repeat(300000),
    '%%%a'.repeat(75000),
    '%%% '.repeat(75000),
    'a%%%'.repeat(75000),
    ' '.repeat(150000) + '%%%x' + ' '.repeat(150000),
    '\n \t'.repeat(100000) + '%%%',
  ]) {
    planChunk(text);
    findLastSeparatorIndex(text);
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, `took ${elapsed} ms`);
});

test('planChunk always sends a prefix of what it was given and never more than the text (30,000 delimiter-heavy strings)', () => {
  let seed = 424242;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const parts = ['%', '%%', '%%%', '%%%%', '%%%%%%', ' ', ' ', '\n', '\n\n', '.', '?', 'warm', 'and a little', 'Hello there', ', ', '5', "it's"];
  for (let i = 0; i < 30000; i++) {
    let text = '';
    for (let k = Math.floor(rnd() * 14); k > 0; k--) text += parts[Math.floor(rnd() * parts.length)];
    for (const release of [false, true]) {
      const plan = planChunk(text, { release });
      assert.ok(typeof plan.send === 'string' && text.startsWith(plan.send), JSON.stringify(text));
      assert.ok(plan.send.length <= text.length);
      if (release) assert.equal(plan.held, false);
      if (text.length >= 20 && !plan.held) assert.ok(plan.send.length > 0 || text.trim() === '', `nothing sent and nothing held: ${JSON.stringify(text)}`);
    }
  }
});

test('nothing here throws on odd input', () => {
  for (const text of ['', ' ', '%', '%%', '%%%', '%%%%', '%%%%%%%', '\u0000%%%\u0000', 'é%%%é']) {
    assert.doesNotThrow(() => {
      scanTags(text);
      planChunk(text);
      findLastSeparatorIndex(text);
    }, JSON.stringify(text));
  }
  assert.deepEqual(scanTags(undefined), { spans: [], openFrom: -1 });
  assert.deepEqual(scanTags(null), { spans: [], openFrom: -1 });
});
