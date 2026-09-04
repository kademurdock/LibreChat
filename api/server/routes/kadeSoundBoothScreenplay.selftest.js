'use strict';
/* Part 126 (Sep 4 2026) — the screenplay is the thing the person reads; the
 * XML is what the engine reads. Both directions, with the awkward cases. */
const test = require('node:test');
const assert = require('node:assert');
const { screenplayToSpeak, speakToScreenplay, parseScreenplay, isSpeakXml } = require('./kadeSoundBoothScreenplay');

const SP = `VOICE: Male, mid 60s. Deep baritone with gravel.
SEX: male
SCENE: Fireside, night, crickets.
SHOT: wide

[Calm, almost casual. Staring at his hands.]
I used to think I had all the time in the world.

[Voice tightens. Swallows.]
Then one Tuesday morning, the doctor said three words & changed everything.

((Thunder cracks overhead))
Move! I said move!`;

test('screenplay compiles to the XML the engine documents', () => {
  const r = screenplayToSpeak(SP);
  assert.match(r.xml, /^<speak voice="Male, mid 60s\. Deep baritone with gravel\." gender="male" scene="Fireside, night, crickets\." shot="wide">/);
  assert.match(r.xml, /<action>Calm, almost casual\. Staring at his hands\.<\/action>\nI used to think I had all the time in the world\./);
  assert.match(r.xml, /<sound>Thunder cracks overhead<\/sound>\nMove! I said move!/);
  assert.match(r.xml, /three words &amp; changed/, 'ampersand escaped');
  assert.equal(r.words, 28);
  assert.deepEqual(r.notes, []);
});

test('headers left out are filled from the booth settings', () => {
  const r = screenplayToSpeak('[soft]\nHello there.', { voice: 'A warm alto.', gender: 'female', shot: 'closeup' });
  assert.match(r.xml, /voice="A warm alto\." gender="female" shot="closeup"/);
});

test('a sound cue on a close-up shot gets a note, because the engine strips it', () => {
  const r = screenplayToSpeak('((rain))\nHi.', { voice: 'x', gender: 'female' });
  assert.ok(r.notes.some((n) => /strip/.test(n)));
});

test('an unclosed bracket is spoken and said so', () => {
  const r = screenplayToSpeak('[he pauses\nHello.', { voice: 'x' });
  assert.ok(r.notes.some((n) => /missing its closing bracket/.test(n)));
});

test('cues inline with speech keep their order', () => {
  const { blocks } = parseScreenplay('Wait. [beat] No, listen. ((door slams)) Go.');
  assert.deepEqual(blocks.map((b) => b.type), ['speech', 'action', 'speech', 'sound', 'speech']);
});

test('XML from the script desk comes back as a screenplay a screen reader can read', () => {
  const xml = '<speak voice="A woman in her sixties, low and warm." gender="female" scene="a kitchen at dawn" shot="closeup">\n<action>She sets the cup down.</action>\nSit a minute.\n<sound>a kettle ticking</sound>\nI have been meaning to tell you.\n</speak>';
  const sp = speakToScreenplay(xml);
  assert.match(sp, /^VOICE: A woman in her sixties, low and warm\.\nSEX: female\nSCENE: a kitchen at dawn\nSHOT: closeup\n\n\[She sets the cup down\.\]\nSit a minute\.\n\n\(\(a kettle ticking\)\)\nI have been meaning to tell you\.$/);
  assert.equal(isSpeakXml(sp), false);
});

test('round trip: screenplay -> XML -> screenplay is stable', () => {
  const once = screenplayToSpeak(SP).xml;
  const back = speakToScreenplay(once);
  const twice = screenplayToSpeak(back).xml;
  assert.equal(once, twice);
});

test('a raw XML script is recognised and left alone by the compiler path', () => {
  assert.equal(isSpeakXml('<speak voice="x" gender="male">Hi</speak>'), true);
  assert.equal(isSpeakXml('VOICE: x\nHi'), false);
});
