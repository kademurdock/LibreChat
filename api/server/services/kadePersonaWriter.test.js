/**
 * The description box's brain. Two things are worth a test here and they are
 * not the obvious one:
 *
 *  1. THE PARSER MUST NEVER LOSE A DRAFT. A model that ignores the output
 *     format still did the expensive part of the work; handing the person an
 *     error instead of their persona is the worst possible failure, so the
 *     parser degrades to "the whole reply is the persona" rather than throwing.
 *  2. THE CARVE-OUT ANCHORS ARE A CONTRACT WITH ANOTHER REPO. reframe-proxy's
 *     machines.js keeps this lane out of appendReminder by matching the exact
 *     header and tail personaUserContent emits (law 19 — an appended style
 *     reminder would be written INTO the generated persona). If somebody
 *     rewords either one here, this file goes red before the lane goes quiet.
 */
const test = require('node:test');
const assert = require('node:assert');
const W = require('./kadePersonaWriter.js');

const WELL_FORMED = `===PERSONA===
1 WHO YOU ARE.
You are Marguerite, and you have kept the same porch swing for thirty years.

2 YOUR VOICE.
"Sit down before you tell me the rest of that."
===QUESTIONS===
1. What does she sound like when she disagrees with you?
2. Who taught her to cook?
3. What does she refuse to talk about?
===NOTES===
I guessed at the porch and the cooking; change anything.`;

test('a well-formed reply splits into persona, questions and notes', () => {
  const out = W.parsePersonaOutput(WELL_FORMED);
  assert.match(out.instructions, /^1 WHO YOU ARE\./);
  assert.ok(!out.instructions.includes('==='));
  assert.equal(out.questions.length, 3);
  assert.equal(out.questions[0], 'What does she sound like when she disagrees with you?');
  assert.match(out.notes, /^I guessed at the porch/);
});

test('NONE means no questions, not a question that says NONE', () => {
  const out = W.parsePersonaOutput(`===PERSONA===\nYou are Rook.\n===QUESTIONS===\nNONE\n===NOTES===\nDone.`);
  assert.deepStrictEqual(out.questions, []);
});

test('at most three questions survive, however many the model writes', () => {
  const out = W.parsePersonaOutput(
    `===PERSONA===\nYou are Rook.\n===QUESTIONS===\n1. a?\n2. b?\n3. c?\n4. d?\n5. e?\n===NOTES===\nx`,
  );
  assert.equal(out.questions.length, 3);
});

test('a model that ignores the format still hands back its draft', () => {
  const raw = 'You are Marguerite. You have kept the same porch swing for thirty years.';
  const out = W.parsePersonaOutput(raw);
  assert.equal(out.instructions, raw);
  assert.deepStrictEqual(out.questions, []);
});

test('code fences are stripped off an unformatted draft', () => {
  const out = W.parsePersonaOutput('```markdown\nYou are Rook.\n```');
  assert.equal(out.instructions, 'You are Rook.');
});

test('empty in, empty out — never a throw', () => {
  const out = W.parsePersonaOutput('');
  assert.equal(out.instructions, '');
  assert.deepStrictEqual(out.questions, []);
});

/* ── the cross-repo contract ─────────────────────────────────────────────── */

test('the reframe carve-out anchors are present, in the right places', () => {
  const body = W.personaUserContent({
    description: 'an ACT-based therapist that also borrows from other modalities',
    round: 1,
  });
  /* These two literals are duplicated in reframe-proxy/machines.js as
   * PERSONA_BLOCK_RE and PERSONA_TAIL_RE. They must not drift. */
  assert.ok(body.includes('CHARACTER BRIEF (from the person building them):'));
  assert.ok(/Write the character's system prompt now\.\s*$/.test(body));
});

test('the improve door carries the existing prompt and the answers', () => {
  const body = W.personaUserContent({
    description: 'deepen her',
    existingInstructions: 'You are Marguerite.',
    answers: [{ q: 'What does she refuse to talk about?', a: 'Her first marriage.' }],
    round: 2,
    name: 'Marguerite',
  });
  assert.ok(body.includes('THE PROMPT THEY ALREADY HAVE'));
  assert.ok(body.includes('You are Marguerite.'));
  assert.ok(body.includes('Her first marriage.'));
  assert.ok(body.includes('ROUND: 2'));
  assert.ok(/Write the character's system prompt now\.\s*$/.test(body));
});

test('the craft brief forbids writing anti-slop rules into the persona', () => {
  /* Not a style check — a system-design check. The global style reminder
   * arrives on every turn in a louder position than the persona, so a
   * duplicate inside the persona can only fight it. */
  assert.match(W.PERSONA_CRAFT, /NEVER write anti-slop or style rules into the persona/);
  assert.match(W.PERSONA_CRAFT, /EXAMPLE LINES ARE THE HIGHEST-LEVERAGE THING/);
  assert.match(W.PERSONA_CRAFT, /ONE GOVERNING METAPHOR/);
});
