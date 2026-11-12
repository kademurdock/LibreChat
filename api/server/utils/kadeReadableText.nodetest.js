'use strict';
/* Nov 12 2026 (phase 3 A2): the readable-text helper. Shapes, the field rules, and the hostile-input timing
 * that caught the first draft (its link, literal-citation and scene-tag patterns ran 13 s to over a minute on
 * 200,000 characters). Run: node --test api/server/utils/kadeReadableText.nodetest.js */
const test = require('node:test');
const assert = require('node:assert');
const { toReadableText, withReadableText, messageBodyText, MAX_CHARS } = require('./kadeReadableText');

test('the Nov 6 stray-tag shape reads only the words', () => {
  const raw = 'Two different problems.\n\n%%%\n%%%warm and curious%%% So what is the shape of it?';
  const out = toReadableText(raw);
  assert.ok(!out.includes('%'), out);
  assert.ok(!out.includes('warm and curious'), out);
  assert.ok(out.includes('Two different problems.'), out);
  assert.ok(out.includes('So what is the shape of it?'), out);
});

test('tags, markdown, scene tags, cues, citations and tokens', () => {
  assert.strictEqual(toReadableText('%%%warm%%% Hello **there**.'), 'Hello there.');
  assert.strictEqual(toReadableText('%%%%%% Hi.'), 'Hi.');
  assert.strictEqual(toReadableText('[[Narrator]] The door opens.'), 'Narrator: The door opens.');
  assert.strictEqual(toReadableText('Roll the dice [sound:dice_roll] now.'), 'Roll the dice now.');
  assert.strictEqual(toReadableText('It rained turn0search1 today.'), 'It rained today.');
  assert.strictEqual(toReadableText('Fact\\ue202turn1news2 here.'), 'Fact here.');
  assert.strictEqual(toReadableText('Done<|end|>'), 'Done');
  assert.strictEqual(toReadableText('# Title\n- one\n- two'), 'Title\none\ntwo');
  assert.strictEqual(
    toReadableText('See [Ozarks](https://en.wikipedia.org/wiki/Ozarks_(region)) please.'),
    'See Ozarks please.',
  );
  assert.strictEqual(toReadableText('a *quiet* word and ~~old~~ __new__'), 'a quiet word and old new');
  assert.strictEqual(toReadableText('one\n\n\n\n\ntwo'), 'one\n\ntwo');
});

test('doubled percents: prose loses them, code keeps them', () => {
  assert.strictEqual(toReadableText('It is 100%% true.'), 'It is 100 true.');
  assert.strictEqual(toReadableText('Use `printf("%%d", n)` here.'), 'Use `printf("%%d", n)` here.');
  const fenced = 'Code:\n```c\nprintf("%%d", n);\n  **not bold**\n```\nDone.';
  assert.strictEqual(toReadableText(fenced), fenced);
});

test('no text, too long, non-strings give no field', () => {
  assert.strictEqual(toReadableText(''), '');
  assert.strictEqual(toReadableText(null), '');
  assert.strictEqual(toReadableText(42), '');
  assert.strictEqual(toReadableText('a'.repeat(MAX_CHARS + 1)), '');
  assert.strictEqual(toReadableText('%%%warm%%%'), '');
});

test('withReadableText is additive and leaves text and content raw', () => {
  const message = {
    messageId: 'm1',
    text: '',
    content: [
      { type: 'think', think: 'hidden' },
      { type: 'text', text: '%%%warm%%% Hello **there**.' },
    ],
  };
  const out = withReadableText(message);
  assert.notStrictEqual(out, message);
  assert.deepStrictEqual(out.kade, { readableText: 'Hello there.' });
  assert.strictEqual(out.content, message.content);
  assert.strictEqual(message.kade, undefined);
  // no text: no field (the apps keep their own tool-only and failed-turn sentences)
  const toolOnly = { messageId: 'm2', text: '', content: [{ type: 'tool_call' }] };
  assert.strictEqual(withReadableText(toolOnly), toolOnly);
  assert.strictEqual(withReadableText(null), null);
  assert.strictEqual(messageBodyText({ text: 'plain' }), 'plain');
  // keeps other kade keys
  assert.deepStrictEqual(withReadableText({ text: 'Hi', kade: { x: 1 } }).kade, {
    x: 1,
    readableText: 'Hi',
  });
});

test('KADE_READABLE_TEXT=0 sends no field', () => {
  const before = process.env.KADE_READABLE_TEXT;
  process.env.KADE_READABLE_TEXT = '0';
  try {
    const message = { text: '%%%warm%%% Hi.' };
    assert.strictEqual(withReadableText(message), message);
  } finally {
    if (before === undefined) delete process.env.KADE_READABLE_TEXT;
    else process.env.KADE_READABLE_TEXT = before;
  }
});

test('32 hostile 200,000-character inputs stay fast', () => {
  const N = 199990;
  const fill = (unit) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  const units = [
    '`', '```', '[[', '[[ ', '[[a', '[', '[a](', '[a](b', '[a](b(', '](',
    '\\', '\\u', '\\ue20', '\\u e20', '', 'turn1', 'turn1search', '<|', '<|a',
    '#', '## ', '*', '**', '*a', '* ', '_', '__', '~~', '%', '%%%', ' ', '\n',
  ];
  assert.strictEqual(units.length, 32);
  let total = 0;
  let slowest = { ms: 0, unit: '' };
  for (const unit of units) {
    const input = fill(unit);
    const start = process.hrtime.bigint();
    toReadableText(input);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    total += ms;
    if (ms > slowest.ms) slowest = { ms, unit };
  }
  // The first draft took 13 s to over a minute on single inputs. Measured here about 100 ms in all.
  assert.ok(slowest.ms < 1500, `slowest ${JSON.stringify(slowest.unit)} took ${slowest.ms} ms`);
  assert.ok(total < 5000, `all 32 took ${total} ms`);
});
