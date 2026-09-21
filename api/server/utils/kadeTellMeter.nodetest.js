/* The tell meter.
 *
 * A detector that fires on ordinary speech is worse than no detector, because
 * the number it produces cannot be trusted to move for the right reason. So
 * half of these tests are about what it must NOT catch, using lines written in
 * the voice this platform is actually trying to protect.
 *
 * Every line below is invented for this test. None of it is anybody's real
 * conversation.
 *
 * Run: node --test api/server/utils/kadeTellMeter.nodetest.js
 */
const test = require('node:test');
const assert = require('node:assert');
const meter = require('./kadeTellMeter');

const names = (text, opts) => meter.tellsIn(text, opts).map((t) => t.tell);

test('the contrastive pivot is caught, which is the one the style note calls number one', () => {
  assert.ok(names("It's not a diner, it's a living room with a grill.").includes('pivot'));
  assert.ok(names('That is not just a hobby, but a whole second job.').includes('pivot'));
  assert.ok(names("This isn't about the money, it's about the principle.").includes('pivot'));
});

test('ordinary negation is not a pivot', () => {
  for (const line of [
    'It is not ready yet.',
    'I am not sure, honestly. Let me look.',
    'She is not coming to dinner and she did not say why.',
    'No, that is not the one I meant.',
  ]) {
    assert.ok(!names(line).includes('pivot'), line);
  }
});

test('puffery is caught and plain words are not', () => {
  assert.ok(names('Let me delve into that for you.').includes('puffery'));
  assert.ok(names('It is a testament to how hard she worked.').includes('puffery'));
  assert.ok(names('a seamless experience across a myriad of devices').includes('puffery'));
  for (const line of [
    'That is a crucial detail and I nearly missed it.',
    'The key is to let it rest before you cut it.',
    'It matters to her a lot.',
  ]) {
    assert.deepStrictEqual(names(line), [], line);
  }
});

test('signposting and structure are caught only where they are structure', () => {
  assert.ok(names('First, get the pan hot.\nSecond, do not crowd it.').includes('signpost'));
  assert.ok(names('- one thing\n- another thing').includes('bullets'));
  assert.ok(names('**What to do**: start over.').includes('bold-header'));
  /* Code is code. A shell listing is not a textbook. */
  const code = 'Run this:\n```\n- not a bullet\nFirst, this is inside a fence\n```\nThat is all.';
  assert.deepStrictEqual(names(code), []);
});

test('one rule of three is speech; two is a shape', () => {
  assert.ok(!names('We got eggs, bacon, and the good coffee.').includes('triads'));
  assert.ok(
    names('We got eggs, bacon, and the good coffee. It was warm, quiet, and completely empty.').includes('triads'),
  );
});

test('the stock opener and the offer bait are caught', () => {
  assert.ok(names('Certainly! Here is what I found.').includes('stock-opener'));
  assert.ok(names("I'd be happy to: it opens at nine.").includes('stock-opener'));
  assert.ok(names('The bus leaves at six. Would you like me to set a reminder?').includes('offer-bait'));
  /* An offer in the MIDDLE of a reply is a person talking, not a closer. */
  assert.ok(!names('Want me to grab it? Anyway, she already left, so it can wait.').includes('offer-bait'));
});

test('restating the question is caught, and only with the question in hand', () => {
  const prompt = 'can you tell me how to keep the sourdough starter alive while I am travelling';
  const restated = 'You want to know how to keep your sourdough starter alive while travelling. Feed it and refrigerate it.';
  assert.ok(names(restated, { prompt }).includes('restated-question'));
  /* Without the question there is nothing to compare against. */
  assert.ok(!names(restated).includes('restated-question'));
  /* Answering straight away is not restating. */
  assert.ok(!names('Stick it in the fridge and feed it the day you get back.', { prompt }).includes('restated-question'));
});

test('a warm human reply scores clean', () => {
  const warm = [
    'Oh no. Okay, first thing, is she alright?',
    '',
    'I would not touch the insurance call until tomorrow. You have had enough today, and those people are not going anywhere.',
    '',
    'Tell me what the garage said, though. I want to know if they tried the same nonsense they tried on your brother.',
  ].join('\n');
  assert.deepStrictEqual(meter.tellsIn(warm), [], meter.summarize(meter.tellsIn(warm)));
});

test('a textbook reply scores badly, which is the whole point', () => {
  const textbook = [
    'Certainly! You asked about keeping a sourdough starter alive while travelling.',
    '',
    "It's not just about feeding it, but about managing its temperature.",
    '',
    'First, refrigerate it. Second, feed it before you go. Finally, revive it slowly.',
    '',
    'This is a testament to how resilient, adaptable, and forgiving a starter can be.',
    '',
    'Would you like me to write out a schedule?',
  ].join('\n');
  const tells = names(textbook, { prompt: 'how do I keep my sourdough starter alive while travelling' });
  for (const want of ['stock-opener', 'pivot', 'signpost', 'puffery', 'offer-bait']) {
    assert.ok(tells.includes(want), `missed ${want} in ${tells.join(',')}`);
  }
  assert.ok(tells.length >= 5);
});

test('the meter never throws and never edits', () => {
  for (const bad of [null, undefined, 42, {}, [], '', '   ']) {
    assert.deepStrictEqual(meter.tellsIn(bad), [], String(bad));
    assert.strictEqual(meter.measure(bad), null);
  }
  const text = "It's not a diner, it's a living room with a grill.";
  const copy = String(text);
  meter.measure(text, { agentId: 'kiana' });
  assert.strictEqual(text, copy, 'the meter changed the text it was given');
});

test('measure returns a readable log line, and nothing when the reply is clean', () => {
  assert.strictEqual(meter.measure('Sounds good. See you at six.'), null);
  const line = meter.measure("Let me delve into it. It's not hard, it's just fiddly.", { agentId: 'kiana' });
  assert.ok(/^\[telltale\] agent=kiana tells=\d+ /.test(line), line);
  assert.ok(line.includes('puffery'), line);
});

test('the kill switch turns it off without turning anything else off', () => {
  const before = process.env.KADE_TELL_METER;
  process.env.KADE_TELL_METER = '0';
  try {
    assert.strictEqual(meter.measure('Certainly! Let me delve into that.'), null);
    /* tellsIn itself still works -- the switch is about the logging lane. */
    assert.ok(meter.tellsIn('Certainly! Let me delve into that.').length > 0);
  } finally {
    if (before === undefined) {
      delete process.env.KADE_TELL_METER;
    } else {
      process.env.KADE_TELL_METER = before;
    }
  }
});
