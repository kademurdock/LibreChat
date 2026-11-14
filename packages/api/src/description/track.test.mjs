/**
 * Follow along (Nov 2026, Tellavision): the track a phone speaks a copy's descriptions from,
 * built from the copy's saved looks, plan and words with no paid call (track.ts `buildTrack`).
 * Run: node --import tsx --test packages/api/src/description/track.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { buildTrack, trackSecondsPerByte, trackSteps, trackWarning } from './track.ts';

const SyncPrint = createRequire(import.meta.url)(
  '../../../../api/server/services/kadeSyncprint/syncprint.js',
);

const settings = {
  voice: 'Voice 1',
  rate: 1.5,
  maxRate: 2.25,
  mode: 'extended',
  detail: 'standard',
  volume: 'balanced',
  notes: '',
};
const empty = { kind: '', setting: '', people: [], speakers: [], recent: [] };
const look = (cues, extra = {}) => ({
  kind: 'other',
  setting: 'A hillside.',
  people: [],
  speakers: [],
  protectedSounds: [],
  cues,
  ...extra,
});
const record = (index, start, end, analysis, continuity = empty) => ({
  index,
  start,
  end,
  analysis,
  placements: [],
  skipped: [],
  outputSeconds: end - start,
  continuity,
});
const plan = (extra = {}) => ({
  version: 2,
  seconds: 60,
  audio: true,
  fps: { num: 30, den: 1 },
  loudness: { program: -20, peak: -2 },
  sections: [
    { start: 0, end: 30 },
    { start: 30, end: 60 },
  ],
  ...extra,
});
/** Spoken words: "Hello there" at 5 s, a stretch of talk from 20 to 24.95 s. */
const words = [
  { start: 5, end: 6, word: 'Hello', speaker: 0 },
  { start: 6.1, end: 6.8, word: 'there.', speaker: 0 },
  ...Array.from({ length: 10 }, (_, i) => ({
    start: 20 + i * 0.5,
    end: 20.45 + i * 0.5,
    word: 'word',
    speaker: 1,
  })),
];
const print = { format: 1, bytes: 6850, sha256: 'a'.repeat(64) };
const cue = (at, until, text, extra = {}) => ({
  at,
  until,
  pauseAt: at,
  text,
  shortText: text.split(' ').slice(0, 3).join(' ') + '.',
  importance: 2,
  ...extra,
});
const input = (records, extra = {}) => ({
  job: 'f'.repeat(32),
  copyVersion: 3,
  title: 'The kite',
  settings,
  plan: plan(),
  words,
  records,
  filmSeconds: 60,
  print,
  credit: {
    start: 'Audio description by Kade-AI.',
    end: 'Described by Kade-AI. More at kademurdock dot com.',
  },
  ...extra,
});
const byId = (track, id) => track.cues.find((item) => item.id === id);

test('the track has the contract fields, in order, with windows in the quiet', () => {
  const track = buildTrack(
    input([
      record(
        0,
        0,
        30,
        look([
          cue(8, 15, 'A red kite rises over the hill.'),
          cue(21, 24, 'The kite dips behind a tree.'),
          cue(26, 29, 'Birds call.', { importance: 1 }),
        ]),
      ),
      record(
        1,
        30,
        60,
        look([cue(5, 12, 'The kite lands softly in the grass.', { importance: 3 })]),
      ),
    ]),
  );
  assert.deepEqual(Object.keys(track), [
    'format',
    'version',
    'job',
    'copyVersion',
    'title',
    'language',
    'filmSeconds',
    'covers',
    'print',
    'plannedAt',
    'credit',
    'cues',
    'quiet',
    'warning',
  ]);
  assert.equal(track.format, 'kade-follow-track');
  assert.equal(track.version, 1);
  assert.equal(track.job, 'f'.repeat(32));
  assert.equal(track.copyVersion, 3);
  assert.equal(track.language, 'en', 'descriptions are always written in English');
  assert.equal(track.filmSeconds, 60);
  assert.deepEqual(track.covers, { startSec: 0, endSec: 60 });
  assert.deepEqual(track.print, print);
  assert.deepEqual(track.plannedAt, { secPerChar: 0.0417, rate: 1.5, maxRate: 2.25 });
  assert.equal(trackSecondsPerByte / settings.rate, 0.041666666666666664);
  assert.equal(track.warning, trackWarning);
  assert.deepEqual(Object.keys(track.cues[0]), [
    'id',
    'startSec',
    'endSec',
    'at',
    'until',
    'text',
    'shortText',
    'importance',
    'reading',
    'fit',
  ]);
  /* In the gap after "Hello there" (6.8 s + 0.22): from its moment until its last sensible one. */
  assert.deepEqual(byId(track, '0:0'), {
    id: '0:0',
    startSec: 8,
    endSec: 15,
    at: 8,
    until: 15,
    text: 'A red kite rises over the hill.',
    shortText: 'A red kite.',
    importance: 2,
    reading: false,
    fit: 'full',
  });
  /* Under the talk from 20 to 25 s there is no quiet at all: kept, with an empty window. */
  const covered = byId(track, '0:1');
  assert.equal(covered.fit, 'none');
  assert.equal(covered.startSec, 21);
  assert.equal(covered.endSec, 21);
  /* Importance 1 stays: the phone decides. The gap ends at the section's guard, 29.75 s. */
  const minor = byId(track, '0:2');
  assert.equal(minor.importance, 1);
  assert.equal(minor.fit, 'full');
  assert.equal(minor.startSec, 26);
  assert.equal(minor.endSec, 29);
  const late = byId(track, '1:0');
  assert.equal(late.startSec, 35);
  assert.equal(late.endSec, 42);
  assert.equal(late.importance, 3);
  /* Every quiet stretch, joined across the section join at 30 s. */
  assert.deepEqual(track.quiet, [
    [0, 4.78],
    [7.02, 19.78],
    [25.17, 60],
  ]);
  for (const item of track.cues)
    if (item.fit !== 'none')
      assert.ok(
        track.quiet.some(([from, to]) => from <= item.startSec && item.endSec <= to),
        `${item.id} is spoken in the quiet`,
      );
  assert.deepEqual(
    track.cues.map((item) => item.id),
    ['0:0', '0:1', '0:2', '1:0'],
    'in time order',
  );
});

test('syncprint’s own planner reads the track as it is', () => {
  const track = buildTrack(
    input([record(0, 0, 30, look([cue(8, 15, 'A red kite rises over the hill.')]))]),
  );
  const opts = { secPerChar: track.plannedAt.secPerChar };
  const now = SyncPrint.planCues(track.cues, { status: 'locked', filmSec: 8.2 }, opts);
  assert.equal(now.action, 'speak');
  assert.equal(now.id, '0:0');
  assert.equal(now.text, 'A red kite rises over the hill.');
  const early = SyncPrint.planCues(track.cues, { status: 'locked', filmSec: 6 }, opts);
  assert.equal(early.action, 'wait');
  assert.equal(early.nextId, '0:0');
  const gone = SyncPrint.planCues(track.cues, { status: 'locked', filmSec: 15.4 }, opts);
  assert.equal(gone.action, 'wait', 'the window has closed');
});

test('a part of a film adds the part’s start to every time; covers says which part', () => {
  const part = buildTrack(
    input(
      [
        record(0, 0, 30, look([cue(8, 15, 'A red kite rises over the hill.')])),
        record(1, 30, 60, look([cue(5, 12, 'The kite lands softly in the grass.')])),
      ],
      { plan: plan({ range: { start: 600, end: 660 } }), filmSeconds: 5400 },
    ),
  );
  assert.equal(part.filmSeconds, 5400);
  assert.deepEqual(part.covers, { startSec: 600, endSec: 660 });
  assert.deepEqual(
    part.cues.map((item) => [item.id, item.startSec, item.endSec, item.at, item.until]),
    [
      ['0:0', 608, 615, 608, 615],
      ['1:0', 635, 642, 635, 642],
    ],
  );
  assert.deepEqual(part.quiet[0], [600, 604.78]);
});

test('a pause-mode copy is planned without pauses: a line that needs a freeze is shortened or marked none', () => {
  /* Talk everywhere but 9.0 to 10.6 s: room for the short text at the fastest speed only. */
  const busy = [
    ...Array.from({ length: 16 }, (_, i) => ({
      start: i * 0.55,
      end: i * 0.55 + 0.5,
      word: 'talk',
    })),
    ...Array.from({ length: 30 }, (_, i) => ({
      start: 10.82 + i * 0.6,
      end: 11.3 + i * 0.6,
      word: 'talk',
    })),
  ];
  const track = buildTrack(
    input(
      [
        record(
          0,
          0,
          30,
          look([
            cue(
              9.1,
              10.4,
              'The tall man in the long grey coat slowly opens the heavy wooden door.',
              {
                shortText: 'He opens the door.',
                importance: 3,
              },
            ),
            cue(9.2, 10.2, 'A small brown dog runs across the wet garden path behind him.', {
              shortText: 'A dog runs.',
              importance: 2,
            }),
          ]),
        ),
      ],
      { words: busy },
    ),
  );
  const door = byId(track, '0:0');
  assert.equal(door.fit, 'short', 'the full text needs a freeze; the short one fits');
  assert.ok(door.startSec >= 9.02 && door.endSec <= 10.6);
  assert.equal(byId(track, '0:1').fit, 'none', 'no room left, and no picture is ever frozen');
  assert.ok(byId(track, '0:1').endSec >= byId(track, '0:1').startSec);
});

test('a lone credit card is read whole or by its first role, and may run 2.5 s past the card', () => {
  const card = 'Text reads, Directed by Jane Doe. Produced by John Roe.';
  const track = buildTrack(
    input([
      record(
        0,
        0,
        30,
        look([cue(8, 9, card, { reading: true, shortText: 'Credits.', importance: 3 })]),
      ),
    ]),
  );
  const read = byId(track, '0:0');
  assert.equal(read.reading, true);
  assert.equal(read.shortText, 'Text reads, Directed by Jane Doe.', 'only the card’s own words');
  assert.equal(read.fit, 'full');
  assert.equal(read.startSec, 8);
  assert.equal(read.endSec, 11.5, 'its card leaves at 9 s; a reading may run 2.5 s on');
});

test('names stay gated: a name the listener has not heard yet is not said', () => {
  const people = [
    { id: 'P1', label: 'a woman in red', name: 'Maria', look: 'red coat', nameFrom: 'said' },
  ];
  const named = [...words, { start: 40, end: 40.6, word: 'Maria!', speaker: 0 }];
  const track = buildTrack(
    input(
      [
        record(
          0,
          0,
          30,
          look([cue(8, 15, 'Maria waves at the kite.', { who: ['P1'] })], { people }),
        ),
        record(
          1,
          30,
          60,
          look([cue(15, 22, 'Maria catches the kite.', { who: ['P1'] })], { people }),
        ),
      ],
      { words: named },
    ),
  );
  assert.doesNotMatch(byId(track, '0:0').text, /Maria/, 'before her name is said at 40 s');
  assert.match(byId(track, '0:0').text, /woman in red/i);
  assert.match(byId(track, '1:0').text, /Maria/, 'after it');
});

test('a failed look still gives its quiet; a preview covers its sections; no credit when left out', () => {
  const track = buildTrack(
    input([record(0, 0, 30, null)], {
      plan: plan(),
      credit: null,
    }),
  );
  assert.deepEqual(track.cues, []);
  assert.deepEqual(track.covers, { startSec: 0, endSec: 30 });
  assert.deepEqual(track.quiet, [
    [0, 4.78],
    [7.02, 19.78],
    [25.17, 30],
  ]);
  assert.equal('credit' in track, false);
  const ends = buildTrack(
    input([record(0, 0, 30, null)], { credit: { start: 'Audio description by Kade-AI.' } }),
  );
  assert.deepEqual(ends.credit, { start: 'Audio description by Kade-AI.' });
});

test('a line at a section join keeps clear of the next section’s start', () => {
  const track = buildTrack(
    input([
      record(0, 0, 30, look([cue(28.5, 30, 'The sun sets.')])),
      record(1, 30, 60, look([cue(0, 3, 'Night falls on the hill.')])),
    ]),
  );
  const sunset = byId(track, '0:0');
  assert.ok(sunset.endSec <= 29.75 + 1e-9, 'the run keeps 0.25 s free before a section ends');
  const night = byId(track, '1:0');
  assert.ok(night.startSec >= 30.25 - 1e-9, 'and after one starts');
  assert.equal(night.fit, 'full');
});

test('built step by step, it pauses between sections and gives the same track', () => {
  const records = [
    record(0, 0, 30, look([cue(8, 15, 'A red kite rises over the hill.')])),
    record(1, 30, 60, look([cue(5, 12, 'The kite lands softly in the grass.')])),
  ];
  const steps = trackSteps(input(records));
  let pauses = 0;
  let step = steps.next();
  while (!step.done) {
    pauses++;
    step = steps.next();
  }
  assert.equal(pauses, 1, 'one pause between the two sections');
  assert.deepEqual(step.value, buildTrack(input(records)));
});
