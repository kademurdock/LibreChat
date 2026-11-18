import assert from 'node:assert/strict';
import test from 'node:test';
import {
  alignTracks,
  closeness,
  compareRate,
  copyRun,
  guardFor,
  mergeWindows,
  narratorScore,
  notesFrom,
  objectsIn,
  offsetAt,
  quietGaps,
  referenceProviders,
  scoreStep,
  tooClose,
} from './reference.ts';

/** A made-up film soundtrack: noise under a slowly changing loudness, the same on every run. */
function film(seconds) {
  const out = new Int16Array(seconds * compareRate);
  let seed = 7;
  /* mulberry32: no short cycle, so no stretch of the film repeats another. */
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
  let smooth = 0;
  for (let i = 0; i < out.length; i++) {
    smooth = 0.7 * smooth + 0.3 * random();
    const loud = 0.4 + 0.6 * Math.abs(Math.sin((i / compareRate) * 0.37));
    out[i] = Math.round(smooth * loud * 9000);
  }
  return out;
}
/** The same film 2.5 s late, slipping to 3.1 s late at 62 s, with a narrator tone at `voices`. */
function described(plain, voices) {
  const out = new Int16Array(plain.length + 4 * compareRate);
  for (let i = 0; i < out.length; i++) {
    const t = i / compareRate;
    const late = t < 62 ? 2.5 : 3.1;
    const j = Math.round((t - late) * compareRate);
    let value = j >= 0 && j < plain.length ? plain[j] : 0;
    if (voices.some(([a, b]) => t >= a && t < b))
      value += Math.round(7000 * Math.sin(2 * Math.PI * 440 * t) + 4000 * Math.sin(2 * Math.PI * 1250 * t));
    out[i] = Math.max(-32768, Math.min(32767, value));
  }
  return out;
}

test('the two soundtracks line up in stretches, and the narrator shows where they differ', () => {
  const plain = film(120);
  const voices = [
    [20, 23],
    [80, 84],
  ];
  const copy = described(plain, voices);
  const segments = alignTracks(plain, copy);
  assert.ok(Math.abs(offsetAt(segments, 30) + 2.5) < 0.01, JSON.stringify(segments));
  assert.ok(Math.abs(offsetAt(segments, 100) + 3.1) < 0.01, JSON.stringify(segments));
  const score = narratorScore(plain, copy, segments);
  const mean = (a, b) => {
    let sum = 0;
    for (let f = Math.round(a / scoreStep); f < Math.round(b / scoreStep); f++) sum += score[f];
    return sum / Math.round((b - a) / scoreStep);
  };
  assert.ok(mean(20.5, 22.5) > 0.4, `narrator heard: ${mean(20.5, 22.5)}`);
  assert.ok(mean(81, 83.5) > 0.4, `narrator heard: ${mean(81, 83.5)}`);
  assert.ok(mean(40, 50) < 0.2, `film alone is quiet: ${mean(40, 50)}`);
  /* A "narrator" line with no added voice under it is a character MiMo mislabelled. */
  const notes = notesFrom(
    [
      { start: 19.6, end: 23.4, who: 'narrator', text: 'Kyle walks to the bus.' },
      { start: 45, end: 47, who: 'narrator', text: 'Let us go find him.' },
      { start: 80.5, end: 84.5, who: 'narrator', text: 'Aliens wave hay from the trees.' },
    ],
    score,
    segments,
  );
  assert.deepEqual(
    notes.map((note) => note.text),
    ['Kyle walks to the bus.', 'Aliens wave hay from the trees.'],
  );
  /* Notes are on the plain clock: the voice at 20 s of the described copy is at 17.5 s. */
  assert.ok(Math.abs(notes[0].start - 17.5) < 0.4, String(notes[0].start));
  assert.ok(Math.abs(notes[1].start - 76.9) < 0.4, String(notes[1].start));
});

test('a soundtrack from another video is refused before anything is paid', () => {
  const plain = film(60);
  const other = new Int16Array(70 * compareRate).map((_, i) => Math.round(8000 * Math.sin(i * 0.37) * Math.sin(i * 0.0011)));
  assert.throws(() => alignTracks(plain, other), /does not match/);
});

test('copying is measured on words, with names folded and five-word runs refused', () => {
  const notes = [
    { id: 0, start: 10, end: 12, text: 'Kyle kicks Ike through a row of mailboxes.' },
    { id: 1, start: 20, end: 22, text: 'Cartman shuffles toward the bus.' },
  ];
  const guard = guardFor(notes);
  assert.equal(closeness(['a', 'b', 'c', 'd'], ['a', 'b', 'x', 'd']), 0.75);
  assert.equal(copyRun(guard, 'Stan kicks Ike through a row of fences.'), 'kicks N through a row');
  assert.equal(copyRun(guard, 'Ike flies past the mailboxes after a kick from Kyle.'), '');
  const line = (id, text) => ({ id, text, shortText: text.split(' ').slice(0, 3).join(' '), importance: 2, reading: false });
  assert.match(tooClose(guard, notes, line(1, 'Cartman shuffles toward the bus slowly.')), /too closely|copies/);
  assert.equal(tooClose(guard, notes, line(1, 'Cartman drags his feet to it.')), '');
  /* A line longer than the note it came from would not fit the note's pause. */
  assert.match(tooClose(guard, notes, line(1, 'The big yellow bus waits while Cartman slowly drags his feet.')), /at most 5 to fit/);
  assert.equal(tooClose(guard, notes, { ...line(0, 'Text reads, Kyle kicks Ike through a row of mailboxes.'), reading: true }), '');
  assert.equal(tooClose(guard, notes, undefined), 'missing');
  assert.deepEqual(
    objectsIn('junk {"id": 3, "text": "a"} more {"id": 4, broken} {"id": 5, "text": "b"}').map((o) => o.id),
    [3, 5],
  );
});

test('overlapping windows join into one list, and short character-like narrator lines become dialogue', () => {
  const lines = mergeWindows(
    [
      {
        start: 0,
        length: 40,
        lines: [
          { start: 1, end: 3, who: 'narrator', text: 'A bus rolls along a road.' },
          { start: 36, end: 40, who: 'narrator', text: 'Kyle runs to' },
        ],
      },
      {
        start: 30,
        length: 40,
        lines: [
          { start: 6, end: 9, who: 'narrator', text: 'Kyle runs to his seat.' },
          { start: 12, end: 13, who: 'narrator', text: 'Let us go!' },
          { start: 14, end: 16, who: 'narrator', text: 'Audio description by DVS.' },
        ],
      },
    ],
    70,
  );
  assert.deepEqual(
    lines.map((line) => [line.start, line.who, line.text]),
    [
      [1, 'narrator', 'A bus rolls along a road.'],
      [36, 'narrator', 'Kyle runs to his seat.'],
      [42, 'dialogue', 'Let us go!'],
      [44, 'credit', 'Audio description by DVS.'],
    ],
  );
});

test('a section takes its own lines from the reference and looks only at quiet stretches with none', async () => {
  assert.deepEqual(
    quietGaps(30, [{ start: 0, end: 5, text: 'Hi' }, { start: 6, end: 20, text: 'Talk' }], [{ start: 21, end: 23 }]),
    [{ start: 23.3, end: 29.7 }],
  );
  const reference = {
    version: 1,
    book: 'b'.repeat(24),
    track: 0,
    segments: [{ from: 0, offset: -2 }],
    spoken: [{ start: 105, end: 108 }],
    cues: [
      { at: 95, until: 97, text: 'Before this section.', shortText: 'Before.', importance: 2 },
      { at: 105, until: 108, text: 'Kyle swats Cartman with Ike.', shortText: 'Kyle swats Cartman.', importance: 3 },
    ],
    notes: 2,
    left: 0,
    costUSD: 0.01,
  };
  let asked = 0;
  const providers = referenceProviders(
    { analyze: async () => assert.fail('the full look is never asked'), transcribe: async () => [], synthesize: async () => {} },
    reference,
    'Pilot',
  );
  const analysis = await providers.analyze(
    { file: 'unused.mp4', seconds: 20, start: 100, lines: [{ start: 0, end: 4.5, text: 'Hi' }, { start: 8.5, end: 20, text: 'Talk' }], before: [], brief: {}, state: null },
    new AbortController().signal,
    async () => {
      asked++;
    },
  );
  assert.equal(asked, 0, 'no quiet stretch was left, so nothing was paid');
  assert.deepEqual(
    analysis.cues.map((cue) => [cue.at, cue.until, cue.text]),
    [[5, 8, 'Kyle swats Cartman with Ike.']],
  );
  assert.equal(analysis.vision.length, 0);
});
