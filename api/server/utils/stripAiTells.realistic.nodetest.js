/* Synthetic answers exercise the real saved-text, transmit and stream transforms.
 * Metadata decoys check that these transforms insert no facts; they cannot prevent
 * a model from borrowing facts before the transform receives its draft. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { stripAiTells, scrubMessageForTransmit, createStreamScrubber } = require('./stripAiTells');

const fixtures = [
  [
    'warmth with a useful detail',
    'I love that you gave me the long version. The deadline changes my answer.',
  ],
  [
    'specific feeling with a complete schedule',
    'I love how clear the schedule is: doors at 6:30, music at 7, last entry at 9. Keep the ticket handy.',
  ],
  [
    'curly-apostrophe correction with corrected time',
    'You\u2019re right: the meeting is Tuesday at 2:15. I swapped the dates.',
  ],
  [
    'correction with comma and two necessary facts',
    "You're right, I swapped the platforms: platform four, not platform two. The train still leaves at 6:40.",
  ],
  [
    'diplomatic disagreement and concrete costs',
    "You're right about the upfront price, but I don't think it's the cheaper choice. Ink is $30 a refill, and the other printer includes two refills.",
  ],
  [
    'honest uncertainty after a correction',
    "You're right to question that time. The notice says 6:40, but I can't tell whether there are delays today.",
  ],
  [
    'right-handed is substantive content',
    "You're right-handed, so put the lamp on your left. That keeps your writing hand from casting a shadow across the page.",
  ],
  [
    'right next to is a location with supporting facts',
    "You're right next to the exit on this seating map: row B, seat 4. The aisle is on your left.",
  ],
  [
    'specific taste retains quoted color and dimensions',
    "I love that 'midnight blue' finish. The small case is 18 inches wide; the large one is 24.",
  ],
  [
    'specific musical opinion with casual bite',
    'I love how the quiet track gives the loud one room to land. Keep that order; the abrupt change works.',
  ],
  [
    'complete fictional weather answer with casual relief',
    "You're right about Friday cooling off. Today is 90, feels like 88, and cloudy. Thursday is 85 with a 50% chance of rain and wind up to 18. Friday is 70, low 59, with a 71% chance of drizzle. Saturday is cloudy at 75, low 56, with little rain. Sunday is cloudy at 83. Monday is mostly clear at 77. Tuesday is partly cloudy at 75, low 48. Some relief from this shit, finally.",
  ],
  [
    'substantive directions retain failure recovery',
    "You're right about needing the longer explanation. Save a copy first, change one setting, then reopen the file. If it fails, restore the copy before trying anything else.",
  ],
];

const DECOY = 'SYNTHETIC_REFERENCE_ONLY: Juniper Goods, SABLE-83, eleven business days';

function streamText(text, chunkSize, arrayContent) {
  const scrubber = createStreamScrubber();
  let shown = '';
  const append = (events) => {
    for (const event of events) {
      const content = event.delta.content;
      shown += typeof content === 'string' ? content : content[0].text;
      assert.deepEqual(event.metadata, { decoy: DECOY });
    }
  };
  for (let start = 0; start < text.length; start += chunkSize) {
    const chunk = text.slice(start, start + chunkSize);
    const event = {
      id: 'synthetic-realistic',
      delta: { content: arrayContent ? [{ type: 'text', text: chunk }] : chunk },
      metadata: { decoy: DECOY },
    };
    const before = JSON.stringify(event);
    append(scrubber.transform(event));
    assert.equal(JSON.stringify(event), before, 'stream input must not mutate');
  }
  append(scrubber.flushAll());
  return shown;
}

for (const [name, text] of fixtures) {
  test(`all text paths preserve ${name} without inserting metadata facts`, () => {
    assert.equal(stripAiTells(text), text);
    const message = {
      text,
      content: [{ type: 'text', text }, { type: 'metadata', decoy: DECOY }],
    };
    const before = JSON.stringify(message);
    const transmitted = scrubMessageForTransmit(message);
    assert.equal(transmitted.text, text);
    assert.equal(transmitted.content[0].text, text);
    assert.deepEqual(transmitted.content[1], message.content[1]);
    assert.equal(JSON.stringify(message), before, 'transmit input must not mutate');
    assert.equal(transmitted.text.includes('SABLE-83'), false);
    for (const size of [1, 5, 17, text.length]) {
      for (const arrayContent of [false, true]) {
        const shown = streamText(text, size, arrayContent);
        assert.equal(shown, text, `chunk size ${size}, array content ${arrayContent}`);
        assert.equal(shown.includes('SABLE-83'), false);
      }
    }
  });
}
