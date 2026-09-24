import assert from 'node:assert/strict';
import test from 'node:test';
import { gateCues, near, notedNames, readings, speakerAt, spokenReveals } from './ledger.ts';

const words = (text, start = 0, step = 0.5, speaker = 0) =>
  text.split(' ').map((word, i) => ({
    word,
    start: start + i * step,
    end: start + i * step + step * 0.8,
    speaker,
  }));
const cue = (at, text, shortText = text, extra = {}) => ({
  at,
  until: at + 4,
  pauseAt: at,
  text,
  shortText,
  importance: 2,
  ...extra,
});
const squirrel = { id: 'P1', label: 'the flying squirrel', name: 'Frank', look: 'brown fur' };

test('ledger: a name is revealed the first time it is spoken, allowing one misspelling in longer names', () => {
  const said = [
    ...words('Look at him.', 4),
    ...words('Leave him alone, Frank.', 14.3),
    ...words('Thanks Uncle Bob and Mr. Jonathon.', 30),
  ];
  const reveals = spokenReveals(said, ['Frank', 'Uncle Bob', 'Jonathan', 'Holly', 'Grandma']);
  assert.equal(reveals.frank, 14.3 + 1.5);
  assert.equal(reveals['uncle bob'], 30.5);
  assert.equal(reveals.jonathan, 32.5, 'one edit is forgiven in a name of five or more letters');
  assert.equal(reveals.holly, undefined);
  assert.equal(near('frank', 'franc'), true);
  assert.equal(near('holly', 'hollie'), false);
  assert.equal(near('bob', 'rob'), false, 'short names must match exactly');
});

test('ledger: a family title alone never reveals a name, and ordinary lowercase words do not either', () => {
  const said = [...words('my uncle said to be frank it was fine', 0), ...words('Bob!', 20)];
  const reveals = spokenReveals(said, ['Uncle Bob', 'Frank']);
  assert.equal(reveals['uncle bob'], 20);
  assert.equal(reveals.frank, undefined, 'lowercase "frank" is an adjective, not the name');
  assert.deepEqual(notedNames('Uncle Bob is the man in the red cap', ['Uncle Bob', 'Frank']), [
    'Uncle Bob',
  ]);
});

test('ledger: the gate swaps unrevealed names for the label and joins label and name on first use', () => {
  const said = words('Leave him alone, Frank.', 14);
  const { cues, reveals } = gateCues({
    cues: [
      cue(3, 'Frank snarls at the rabbit.', "Frank's teeth show."),
      cue(20, 'Frank darts across the grass.', 'Frank darts off.'),
      cue(30, 'Frank lands on a branch.'),
    ],
    people: [squirrel],
    state: null,
    words: said,
    notes: '',
    sectionStart: 0,
  });
  assert.equal(cues[0].text, 'The flying squirrel snarls at the rabbit.');
  assert.equal(cues[0].shortText, "The flying squirrel's teeth show.");
  assert.equal(cues[1].text, 'The flying squirrel, Frank, darts across the grass.');
  assert.equal(cues[1].shortText, 'The flying squirrel, Frank, darts off.');
  assert.equal(cues[2].text, 'Frank lands on a branch.', 'the name stands alone after the join');
  assert.equal(reveals.frank, 15.5);
});

test('ledger: a model that joins an unrevealed name to its label keeps only the label', () => {
  const { cues } = gateCues({
    cues: [
      cue(1, 'Frank, the flying squirrel, snarls.'),
      cue(2, 'A rabbit sees the flying squirrel, Frank, above him.'),
    ],
    people: [squirrel],
    state: null,
    words: [],
    notes: '',
    sectionStart: 0,
  });
  assert.equal(cues[0].text, 'The flying squirrel snarls.');
  assert.equal(cues[1].text, 'A rabbit sees the flying squirrel above him.');
});

test('ledger: names read from the screen stay word for word and count as revealed', () => {
  const anchor = { id: 'P2', label: 'the anchor', name: 'Mary Smith', look: 'red blazer' };
  const { cues, reveals } = gateCues({
    cues: [
      cue(2, 'Mary Smith sits at a news desk.'),
      cue(5, 'A caption reads Mary Smith, KY3 News.'),
      cue(9, 'Mary Smith turns to a map.'),
    ],
    people: [anchor],
    state: null,
    words: [],
    notes: '',
    sectionStart: 100,
  });
  assert.equal(cues[0].text, 'The anchor sits at a news desk.');
  assert.equal(cues[1].text, 'A caption reads Mary Smith, KY3 News.');
  assert.equal(cues[2].text, 'The anchor, Mary Smith, turns to a map.');
  assert.equal(reveals['mary smith'], 105);
  assert.deepEqual(readings('A sign reads Grand Opening. A man waves.'), [[13, 27]]);
});

test('ledger: names in her notes are known from the start, and a known link is not repeated', () => {
  const state = {
    kind: '',
    setting: '',
    people: [{ id: 'P1', label: 'the man in the red cap', name: 'Uncle Bob', look: '' }],
    speakers: [],
    recent: [],
    heard: { labels: ['the man in the red cap'], names: { 'uncle bob': 'the man in the red cap' } },
  };
  const { cues } = gateCues({
    cues: [cue(1, 'Uncle Bob lifts the cake.')],
    people: [],
    state,
    words: [],
    notes: 'Uncle Bob wears a red cap.',
    sectionStart: 0,
  });
  assert.equal(cues[0].text, 'Uncle Bob lifts the cake.');
});

test('ledger: the first cue about a person the listener has not met becomes essential', () => {
  const { cues } = gateCues({
    cues: [
      cue(1, 'A gray-haired man wipes the counter.', 'A man wipes.', { who: ['P3'] }),
      cue(4, 'The gray-haired man pours coffee.', 'He pours.', { who: ['P3'] }),
    ],
    people: [{ id: 'P3', label: 'the gray-haired man', name: '', look: 'green apron' }],
    state: null,
    words: [],
    notes: '',
    sectionStart: 0,
  });
  assert.equal(cues[0].importance, 3);
  assert.equal(cues[1].importance, 2);
});

test('ledger: a speaker is printed by name only once the name is revealed, else by label, else Speaker N', () => {
  const continuity = {
    kind: '',
    setting: '',
    people: [squirrel, { id: 'P2', label: 'the chubby rodent', name: '', look: '' }],
    speakers: [
      { speaker: 0, who: 'P1' },
      { speaker: 1, who: 'the chubby rodent' },
    ],
    recent: [],
    reveals: { frank: 14.3 },
  };
  assert.equal(speakerAt(continuity, 0, 4), 'The flying squirrel');
  assert.equal(speakerAt(continuity, 0, 14.3), 'Frank');
  assert.equal(speakerAt(continuity, 1, 20), 'The chubby rodent');
  assert.equal(speakerAt(continuity, 2, 20), 'Speaker 3');
});
