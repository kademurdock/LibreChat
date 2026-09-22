/* The Sep 21 2026 additions to the scrubber, and the lines they must not touch.
 *
 * A deletion rule runs on every assistant message on the platform, so the only
 * safe kind is one where the sentence still stands after the cut. Each test
 * below asserts both halves: the tell goes, and ordinary speech that looks a
 * little like it stays.
 *
 * Run: node --test api/server/utils/stripAiTells.additions.nodetest.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { stripAiTells } = require('./stripAiTells');

test('Certainly! goes, and the sentence after it stands', () => {
  assert.strictEqual(stripAiTells('Certainly! The bus leaves at six.'), 'The bus leaves at six.');
  assert.strictEqual(stripAiTells("I'd be happy to help with that: it opens at nine."), 'It opens at nine.');
});

test('the words people actually say are left alone', () => {
  for (const line of [
    'Of course she did. That is exactly her.',
    'Sure, go ahead.',
    'Certainly not, and you know it.',
    'I would be happy to see her again one of these days.',
  ]) {
    assert.strictEqual(stripAiTells(line), line, line);
  }
});

test('the essay connectives go', () => {
  assert.strictEqual(stripAiTells('In conclusion, it was the cat.'), 'It was the cat.');
  assert.strictEqual(stripAiTells("In today's world, everything is a subscription."), 'Everything is a subscription.');
  assert.strictEqual(stripAiTells('To sum up, she is fine.'), 'She is fine.');
});

test('the widened hope-this-helps closer goes, wherever it ends', () => {
  assert.strictEqual(stripAiTells('Two eggs and a pinch of salt. Hope this helps!'), 'Two eggs and a pinch of salt.');
  assert.strictEqual(stripAiTells('Two eggs. I hope that is helpful.'), 'Two eggs.');
  assert.strictEqual(stripAiTells('Two eggs. Hope this gives you a place to start.'), 'Two eggs.');
  /* Mid-message, it is a person talking and it stays. */
  const mid = 'Hope this helps, and tell me how the cake turns out.';
  assert.strictEqual(stripAiTells(mid), mid);
});

test('a scrub never empties a message and never touches code', () => {
  assert.strictEqual(stripAiTells('Certainly!'), 'Certainly!');
  const code = 'Try:\n```\nIn conclusion, print("hi")\n```';
  assert.ok(stripAiTells(code).includes('In conclusion, print("hi")'));
});

/* ── THE ANTI-TELL RULES MUST SURVIVE A REWRITE (Sep 21 2026) ─────────────
 *
 * These exist because the rules did NOT survive one. A rewrite of
 * KADE_STYLE_NOTE on Sep 21 2026 replaced the anti-tell block with a
 * companionship block and took all seven rules with it; a check across both
 * house notes afterwards found none of them anywhere. On the same day the Jev
 * voice-flags lane was reading the reframe tic in 12 of 24 real replies.
 *
 * Both halves matter and neither may eat the other, so both are asserted.
 */
const { KADE_STYLE_NOTE } = require('./stripAiTells');

test('the house note still carries BOTH halves: companionship and the habits to drop', () => {
  assert.ok(/Companionship is a full use/.test(KADE_STYLE_NOTE), 'the conversation half is gone');
  assert.ok(/HABITS TO DROP/.test(KADE_STYLE_NOTE), 'the anti-tell half is gone');
});

test('every anti-tell rule that was silently deleted once is still there', () => {
  const rules = {
    'contrastive pivot': /correction move/i,
    'pivot described': /first saying what something is not/i,
    puffery: /delve.*tapestry|tapestry.*delve/i,
    'as an AI': /do not say you are an AI/i,
    'training cutoff': /training cutoff/i,
    'praise openers': /praising what they said/i,
    'restating the question': /question back to them/i,
    'offer-bait closer': /offering more help/i,
    'tool narration': /narrate choosing a tool/i,
  };
  for (const [name, re] of Object.entries(rules)) {
    assert.ok(re.test(KADE_STYLE_NOTE), `the "${name}" rule is missing from the house note`);
  }
});

test('the pivot rule teaches the repair, not just the ban', () => {
  /* The old ban ran for two months and did not work. It was a prohibition
   * with no replacement, so the model had nowhere to put the thought. The
   * repair is taught by plain example statements, and that is the part a
   * future trim would cut first for being long. */
  const examples = KADE_STYLE_NOTE.match(/Plain statements like these[^]*?(?=When the person)/);
  assert.ok(examples, 'the worked repair is gone');
  const quoted = examples[0].match(/"[^"]+"/g) || [];
  assert.ok(quoted.length >= 3, `only ${quoted.length} plain examples left`);
  assert.ok(/delete the denial/i.test(KADE_STYLE_NOTE), 'the reason the repair works is gone');
});

test('the house note never quotes the construction it bans (Sep 22 2026)', () => {
  /* The first battery run under the restored note found Kiana copying its
   * Before examples nearly word for word. A model reproduces what it is
   * shown, so the note may describe the habit but never demonstrate it. The
   * same detector that counts the tic in replies must find none here. */
  const meter = require('./kadeTellMeter');
  const pivots = meter.tellsIn(KADE_STYLE_NOTE).filter((t) => t.tell === 'pivot');
  assert.deepStrictEqual(pivots, [], 'the house note is demonstrating the pivot again');
  assert.ok(!/Before:/.test(KADE_STYLE_NOTE), 'a Before example of the banned form came back');
});

test('the note that bans literary phrasing is not itself written in it', () => {
  /* A model imitates the VOICE of its instructions. A ban on essay register
   * written in essay register teaches the opposite of what it says. */
  const meter = require('./kadeTellMeter');
  assert.deepStrictEqual(
    meter.essayVoice(KADE_STYLE_NOTE),
    [],
    'the house note picked up the register it forbids',
  );
});
