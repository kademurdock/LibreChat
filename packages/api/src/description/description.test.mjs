import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, mkdir, rm, copyFile, stat, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobePath from 'ffprobe-static';
import { AxiosError } from 'axios';
import {
  fitCue,
  gaps,
  arrange,
  pauseCue,
  pausePoint,
  toOutput,
  snapToCuts,
  planSections,
  tempoFilters,
  mergeIntervals,
  outputTimeline,
} from './timing.ts';
import {
  mix,
  level,
  loudness,
  duckCurve,
  duckDepth,
  sampleRate,
  trimSilence,
  pauseProgram,
  shortTermMax,
} from './mix.ts';
import {
  levelsFor,
  steadyPeak,
  freezeFrame,
  describeVideo,
  alignSections,
  outputChapters,
  workingChapters,
  dialogueLoudness,
} from './engine.ts';
import { readAnalysis, nextContinuity, analysisPrompt } from './prompt.ts';
import { command, probe, frameRate, sectionClip, MediaError } from './media.ts';
import { transcriptText, clock } from './transcript.ts';
import { settingsSchema, Halt } from './types.ts';
import { editsSchema, revise, libraryPathSchema } from './revision.ts';
import { youtubeURL } from './youtube.ts';

process.env.FFMPEG_PATH = ffmpegPath;
process.env.FFPROBE_PATH = ffprobePath.path;
process.env.KADE_DESCRIPTION_RETRY_SECONDS = '0';
const root = await mkdtemp(join(tmpdir(), 'described-video-test-'));
const signal = new AbortController().signal;
after(async () => {
  await rm(root, { recursive: true, force: true });
});
const settings = settingsSchema.parse({ voice: 'Voice 1', mode: 'standard' });
const cue = {
  at: 1,
  until: 5,
  pauseAt: 1,
  text: 'A red square moves across the room.',
  shortText: 'The square moves.',
  importance: 3,
};
const sine = (seconds, frequency, amplitude, channels = 1) => {
  const frames = Math.round(seconds * sampleRate);
  const pcm = new Float32Array(frames * channels);
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < channels; c++)
      pcm[i * channels + c] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  return pcm;
};

test('YouTube URL normalization accepts individual video forms and rejects redirects and private addresses', () => {
  const canonical = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
  for (const url of [
    'https://youtu.be/aqz-KE-bpKQ?t=3',
    'https://www.youtube.com/watch?v=aqz-KE-bpKQ&list=abc',
    'https://m.youtube.com/shorts/aqz-KE-bpKQ',
  ])
    assert.equal(youtubeURL(url), canonical);
  for (const url of [
    'file:///etc/passwd',
    'https://youtube.com.evil.test/watch?v=aqz-KE-bpKQ',
    'https://youtube.com@localhost/watch?v=aqz-KE-bpKQ',
    'http://127.0.0.1/',
    'https://youtube.com/redirect?q=https://youtu.be/aqz-KE-bpKQ',
    'https://youtube.com/playlist?list=abc',
    'https://youtube.com:8443/watch?v=aqz-KE-bpKQ',
  ])
    assert.throws(() => youtubeURL(url));
});

test('loudness follows ITU-R BS.1770: a 1 kHz tone reads 3 dB lower on one channel than on two', () => {
  assert.ok(Math.abs(loudness(sine(3, 1000, 0.1), 1) - -23.01) < 0.15);
  assert.ok(Math.abs(loudness(sine(3, 1000, 0.1, 2), 2) - -20) < 0.15);
  assert.equal(loudness(new Float32Array(48000), 1), -Infinity);
  const quiet = level(sine(2, 1000, 0.01), -23);
  assert.ok(Math.abs(loudness(quiet, 1) - -23) < 0.2);
});

test('narration clips lose engine silence at both ends and keep a short natural margin', () => {
  const pcm = new Float32Array(sampleRate * 2);
  pcm.set(sine(1, 440, 0.3), sampleRate / 2);
  const trimmed = trimSilence(pcm);
  assert.ok(trimmed.length > sampleRate && trimmed.length < sampleRate * 1.2);
  assert.equal(trimSilence(new Float32Array(1000)).length, 0);
});

test('ducking eases down before narration, holds, and eases back up afterwards', () => {
  const curve = duckCurve(sampleRate * 4, [{ start: 1, end: 2, gain: 0.4 }]);
  assert.equal(curve[Math.round(0.5 * sampleRate)], 1);
  assert.ok(curve[Math.round(0.85 * sampleRate)] < 1 && curve[Math.round(0.85 * sampleRate)] > 0.4);
  assert.ok(Math.abs(curve[Math.round(1.5 * sampleRate)] - 0.4) < 1e-6);
  assert.ok(curve[Math.round(2.25 * sampleRate)] > 0.4 && curve[Math.round(2.25 * sampleRate)] < 1);
  assert.equal(curve[Math.round(3 * sampleRate)], 1);
});

test('pauses insert silence with soft edges and keep every later sample', () => {
  const program = sine(2, 220, 0.5, 2);
  const out = pauseProgram(program, [{ at: 1, length: 0.5 }], Math.round(2.5 * sampleRate));
  assert.equal(out.length, Math.round(2.5 * sampleRate) * 2);
  const at = (seconds) => Math.abs(out[Math.round(seconds * sampleRate) * 2]);
  let peakInPause = 0;
  for (let i = Math.round(1.01 * sampleRate); i < Math.round(1.49 * sampleRate); i++)
    peakInPause = Math.max(peakInPause, Math.abs(out[i * 2]));
  assert.equal(peakInPause, 0);
  let tail = 0;
  for (let i = Math.round(0.995 * sampleRate); i < sampleRate; i++)
    tail = Math.max(tail, Math.abs(out[i * 2]));
  assert.ok(tail < 0.05, 'fades out before the pause');
  assert.ok(at(2.2) > 0 || at(2.201) > 0, 'resumes after the pause');
  assert.equal(out[out.length - 2], program[program.length - 2]);
});

test('speech intervals are padded, merged and bounded; only actual gaps are available', () => {
  const blocked = mergeIntervals(
    [
      { start: 1, end: 2 },
      { start: 1.9, end: 3 },
      { start: 9, end: 20 },
    ],
    10,
    0.2,
  );
  assert.deepEqual(blocked, [
    { start: 0.8, end: 3.2 },
    { start: 8.8, end: 10 },
  ]);
  assert.deepEqual(gaps(blocked, 10), [
    { start: 0, end: 0.8 },
    { start: 3.2, end: 8.8 },
  ]);
});

test('a measured clip speeds up only within the chosen maximum and after the visual event', () => {
  const placed = fitCue(cue, cue.text, 4, settings, [{ start: 0, end: 3 }], 8);
  assert.ok(placed);
  assert.equal(placed.at, 3);
  assert.ok(placed.rate > 2 && placed.rate <= 2.25);
  assert.ok(placed.at + placed.duration < 5);
  assert.equal(fitCue(cue, cue.text, 6, settings, [{ start: 0, end: 3 }], 8), null);
});

test('pause points prefer the end of a spoken sentence over the middle of a word', () => {
  const words = [
    { start: 0, end: 0.5, word: 'Hello' },
    { start: 0.55, end: 1, word: 'there.' },
    { start: 1.6, end: 2, word: 'How' },
    { start: 2.05, end: 2.5, word: 'are' },
  ];
  const point = pausePoint({ ...cue, at: 0, until: 3, pauseAt: 0.3 }, words, [], 5);
  assert.ok(Math.abs(point - 1.2) < 0.001, `paused at ${point}, inside the breath after "there."`);
  assert.equal(pausePoint({ ...cue, at: 0, until: 3, pauseAt: 1.3 }, words, [], 5), 1.3);
  const nonstop = Array.from({ length: 90 }, (_, i) => ({
    start: i / 10,
    end: (i + 1) / 10,
    word: 'talk',
  }));
  const boundary = pausePoint({ ...cue, at: 2, until: 3, pauseAt: 2.03 }, nonstop, [], 9);
  assert.ok(Math.abs(boundary - 2) < 1e-9, `nonstop speech paused at ${boundary}, not at the end`);
});

test('extended placement narrates into the quiet stretch and freezes only for the rest', () => {
  const extended = { ...settings, mode: 'extended', rate: 1 };
  const partial = pauseCue(cue, cue.text, 3, extended, 2, [{ start: 3.5, end: 6 }]);
  assert.equal(partial.at, 2);
  assert.ok(Math.abs(partial.pauseAt - 3.4) < 1e-9);
  assert.ok(Math.abs(partial.pause - (3 - 1.4 + 0.35)) < 1e-9);
  const full = pauseCue(cue, cue.text, 3, extended, 2, [{ start: 2.1, end: 6 }]);
  assert.equal(full.pauseAt, 2);
  assert.ok(Math.abs(full.pause - 3.35) < 1e-9);
  const timeline = outputTimeline([
    { ...full, at: 5, pauseAt: 5 },
    { ...partial, pause: 1, pauseAt: 3.4 },
    { ...full, at: 1, pauseAt: 1, pause: 0, inserted: false },
  ]);
  assert.deepEqual(
    timeline.map((item) => item.outputAt),
    [1, 2, 6],
  );
  assert.equal(toOutput(4, timeline), 5);
});

test('sections break near every 90 seconds, a quiet stretch going whole to the next section, on whole frames', () => {
  const words = [];
  for (let t = 0; t < 300; t += 0.5)
    if (Math.abs(t - 88) > 1.5 && Math.abs(t - 181) > 2)
      words.push({ start: t, end: t + 0.45, word: 'x' });
  const sections = planSections(300, words);
  assert.ok(Math.abs(sections[0].end - 86.75) < 1e-9, `first break at ${sections[0].end}`);
  assert.ok(Math.abs(sections[1].end - 179.25) < 1e-9, `second break at ${sections[1].end}`);
  assert.equal(sections.at(-1).end, 300);
  const aligned = alignSections(sections, { num: 30000, den: 1001 }, 300);
  for (const section of aligned.slice(1))
    assert.ok(
      Math.abs((section.start * 30000) / 1001 - Math.round((section.start * 30000) / 1001)) < 1e-6,
    );
  assert.equal(
    frameRate({ r_frame_rate: '120/1' }).num / frameRate({ r_frame_rate: '120/1' }).den,
    60,
  );
  assert.deepEqual(frameRate({ r_frame_rate: '24000/1001' }), { num: 24000, den: 1001 });
});

test('model replies are repaired instead of failing the whole job', () => {
  const analysis = readAnalysis(
    '```json\n' +
      JSON.stringify({
        kind: 'film or TV',
        setting: 'a kitchen',
        people: [{ label: 'the cook', name: '', look: 'white hat' }, { bad: true }],
        speakers: [{ speaker: 0, who: 'the cook' }],
        cues: [
          {
            at: 1,
            until: 99,
            pauseAt: 50,
            text: 'The cook (smiling) flips a pancake & catches it.',
            shortText: '',
            importance: 3,
          },
          { at: 30, until: 31, pauseAt: 30, text: 'Too late.', shortText: 'Late.', importance: 2 },
          { at: 2, until: 1, pauseAt: 2, text: '', shortText: '', importance: 1 },
          { at: 3, until: 1, text: 'Reversed times still get a window.', importance: 9 },
        ],
        protectedSounds: [
          { start: 5, end: 99 },
          { start: 8, end: 7 },
        ],
      }) +
      '\n```',
    10,
    'standard',
  );
  assert.equal(analysis.cues.length, 2);
  assert.equal(analysis.cues[0].text, 'The cook smiling flips a pancake and catches it.');
  assert.equal(analysis.cues[0].shortText, analysis.cues[0].text);
  assert.equal(analysis.cues[0].until, 10);
  assert.ok(analysis.cues[0].pauseAt <= 10);
  assert.equal(analysis.cues[1].until, 4.5);
  assert.equal(analysis.cues[1].importance, 2);
  assert.deepEqual(analysis.protectedSounds, [{ start: 5, end: 10 }]);
  assert.equal(analysis.people.length, 1);
  const state = nextContinuity(
    {
      kind: '',
      setting: '',
      people: [{ label: 'The cook', name: 'Rosa', look: '' }],
      speakers: [],
      recent: [],
    },
    analysis,
  );
  assert.equal(state.people[0].name, 'Rosa');
  assert.equal(state.people[0].look, 'white hat');
  assert.equal(state.speakers[0].who, 'the cook');
  assert.throws(() => readAnalysis('not json', 10, 'standard'));
});

test('volume levels even out quiet and loud soundtracks and keep the narrator just above them', () => {
  const plan = (program, peak) => ({ audio: true, loudness: { program, peak } });
  const quiet = levelsFor(plan(-30.6, -3.2), 'balanced');
  assert.ok(Math.abs(quiet.gain - 8.2) < 1e-9);
  assert.ok(Math.abs(quiet.narration - (-30.6 + 8.2 + 2)) < 1e-9);
  const loud = levelsFor(plan(-10, 0), 'louder');
  assert.equal(loud.gain, -10);
  assert.equal(loud.narration, -15);
  assert.equal(
    levelsFor({ audio: false, loudness: { program: -70, peak: -70 } }, 'softer').narration,
    -18,
  );
});

test('rate settings reject inverted limits and preserve pitch with chained time-stretch filters', () => {
  assert.equal(settingsSchema.safeParse({ ...settings, rate: 3, maxRate: 2 }).success, false);
  assert.equal(tempoFilters(3), 'atempo=2,atempo=1.500000');
  assert.throws(() => tempoFilters(NaN));
  assert.equal(clock(3723.4), '1:02:03');
});

test('script edits reject duplicate IDs and empty speech, preserve timing, and allow omissions', () => {
  const edit = { id: '0:0', text: 'Pat holds a folder.', shortText: 'Pat holds it.', omit: false };
  assert.equal(editsSchema.safeParse([edit, edit]).success, false);
  assert.equal(editsSchema.safeParse([{ ...edit, text: '' }]).success, false);
  const analysis = {
    kind: 'other',
    setting: '',
    people: [],
    speakers: [],
    cues: [cue],
    protectedSounds: [],
  };
  const updated = revise(analysis, 0, [edit]);
  assert.equal(updated.cues[0].at, cue.at);
  assert.equal(updated.cues[0].until, cue.until);
  assert.equal(updated.cues[0].text, edit.text);
  assert.equal(revise(analysis, 0, [{ ...edit, omit: true }]).cues.length, 0);
  assert.equal(analysis.cues.length, 1, 'the original script remains intact');
  assert.equal(libraryPathSchema.parse(' Audio\\Commercials\\1996 '), 'Audio/Commercials/1996');
  for (const path of ['', '/', 'Audio/../Other', 'Audio//Other', 'Audio/\nOther'])
    assert.equal(libraryPathSchema.safeParse(path).success, false);
});

test('a description takes a slightly later gap when it can be spoken near the usual speed there', () => {
  const later = fitCue(
    { ...cue, at: 1, until: 9 },
    cue.text,
    5.5,
    settings,
    [
      { start: 3.6, end: 4 },
      { start: 9, end: 10 },
    ],
    10,
  );
  assert.equal(later.at, 4);
  assert.equal(later.rate, 1.5);
  const tooFar = fitCue(
    { ...cue, at: 1, until: 9.5 },
    cue.text,
    5.5,
    settings,
    [{ start: 3.6, end: 4.5 }],
    10,
  );
  assert.equal(tooFar.at, 1, 'not more than 3 seconds after the first place it fits');
  assert.ok(tooFar.rate > 2);
});

test('descriptions are spoken in the order their events happen', () => {
  const cues = [
    {
      at: 2,
      until: 9,
      text: 'A man in a raincoat steps inside.',
      shortText: 'A man steps in.',
      importance: 3,
    },
    { at: 1, until: 9, text: 'The door swings open.', shortText: 'The door opens.', importance: 2 },
  ];
  const { placed, left } = arrange({
    cues,
    length: (_index, variant) => (variant === 'full' ? 3 : 1.5),
    settings,
    blocked: [],
    hard: [],
    words: [],
    seconds: 10,
  });
  assert.equal(left.length, 0);
  const ordered = [...placed].sort((a, b) => a.placement.at - b.placement.at);
  assert.deepEqual(
    ordered.map((item) => item.index),
    [1, 0],
  );
  assert.ok(
    ordered[1].placement.at >=
      ordered[0].placement.at + ordered[0].placement.duration + 0.35 - 1e-9,
  );
});

test('a minor description gives way to a later, more important one', () => {
  const minor = {
    at: 1,
    until: 9,
    text: 'Rain streaks the window.',
    shortText: 'It rains.',
    importance: 1,
  };
  const key = {
    at: 3,
    until: 5.5,
    text: 'A price reads 9.99.',
    shortText: 'It costs 9.99.',
    importance: 3,
  };
  const shortened = arrange({
    cues: [minor, key],
    length: (index, variant) => (index === 0 ? (variant === 'full' ? 6 : 2) : 1.5),
    settings,
    blocked: [{ start: 5.6, end: 10 }],
    hard: [],
    words: [],
    seconds: 10,
  });
  assert.equal(shortened.left.length, 0);
  assert.equal(shortened.placed.find((item) => item.index === 0).variant, 'short');
  assert.equal(shortened.placed.find((item) => item.index === 0).placement.shortened, true);
  const crowded = arrange({
    cues: [minor, { ...key, at: 1.2, until: 2.5 }],
    length: (index, variant) => (index === 0 ? (variant === 'full' ? 6 : 2) : 1.5),
    settings,
    blocked: [{ start: 5.6, end: 10 }],
    hard: [],
    words: [],
    seconds: 10,
  });
  assert.deepEqual(crowded.left, [{ index: 0, reason: 'priority' }]);
  assert.equal(crowded.placed[0].index, 1);
});

test('the short text wins over the full text squeezed toward the fastest speed', () => {
  const run = (full, short) =>
    arrange({
      cues: [{ ...cue, at: 1, until: 9 }],
      length: (_index, variant) => (variant === 'full' ? full : short),
      settings,
      blocked: [{ start: 4, end: 10 }],
      hard: [],
      words: [],
      seconds: 10,
    }).placed[0];
  assert.equal(run(2.5, 1).variant, 'full', 'full text at the usual speed');
  const short = run(5.5, 3);
  assert.equal(short.variant, 'short');
  assert.ok(short.placement.rate <= 1.8 + 1e-9);
  const fast = run(6, 5.4);
  assert.equal(
    fast.variant,
    'full',
    'full text at up to the fastest speed when the short one is no better',
  );
  assert.ok(fast.placement.rate > 1.8);
});

test('extended mode pauses for important descriptions and leaves minor ones out', () => {
  const words = Array.from({ length: 100 }, (_, i) => ({
    start: i / 10,
    end: (i + 1) / 10,
    word: 'w',
  }));
  const { placed, left } = arrange({
    cues: [
      { ...cue, at: 2, until: 3, importance: 2 },
      { ...cue, at: 5, until: 6, importance: 1 },
    ],
    length: () => 3,
    settings: { ...settings, mode: 'extended' },
    blocked: mergeIntervals(words, 10, 0.22),
    hard: [],
    words,
    seconds: 10,
  });
  assert.equal(placed.length, 1);
  assert.ok(placed[0].placement.pause > 0);
  assert.deepEqual(left, [{ index: 1, reason: 'minor' }]);
});

test('a pause near the section end freezes the last frame instead of running past the end', () => {
  const extended = { ...settings, mode: 'extended', rate: 1 };
  const placed = pauseCue(cue, cue.text, 3, extended, 7.3, [], 9);
  assert.ok(placed.inserted);
  assert.ok(
    placed.pauseAt <= 9 - 0.05 + 1e-9,
    `narration over the soundtrack stops at ${placed.pauseAt}`,
  );
  assert.ok(Math.abs(placed.pause - (3 - (placed.pauseAt - 7.3) + 0.35)) < 1e-9);
  const open = pauseCue(cue, cue.text, 3, extended, 2, []);
  assert.equal(open.pause, 0, 'without a section length nothing changes');
});

test('freeze points sit inside the breath and prefer a nearby scene cut', () => {
  const words = [
    { start: 0, end: 1, word: 'a' },
    { start: 1.3, end: 2, word: 'b' },
    { start: 2.4, end: 3, word: 'c' },
    { start: 6, end: 7, word: 'd' },
  ];
  const at = (pauseAt, cuts) =>
    pausePoint({ ...cue, at: 0, until: 6, pauseAt }, words, [], 8, cuts);
  assert.ok(Math.abs(at(3.05) - 3.1) < 1e-9, 'moved 0.1 s clear of the word before');
  assert.ok(Math.abs(at(5.95) - 5.9) < 1e-9, 'and 0.1 s clear of the word after');
  assert.equal(at(4.5), 4.5, 'kept when well inside a long quiet stretch');
  assert.equal(at(4.5, [4.8]), 4.8, 'moved onto a scene cut close by');
  assert.ok(Math.abs(at(1.5) - 3.2) < 1e-9, 'inside a word: the best breath nearby, 0.2 s in');
  assert.equal(at(1.5, [2.1]), 2.1, 'or a scene cut between words');
  assert.equal(
    freezeFrame(
      2.125,
      [
        { start: 1.35, end: 2, word: 'there.' },
        { start: 2.25, end: 2.6, word: 'Now' },
      ],
      { num: 30, den: 1 },
      300,
    ),
    64,
  );
});

test('descriptions move forward onto a scene cut, never back', () => {
  const at = (cuts) => snapToCuts([{ ...cue, at: 1, until: 5, pauseAt: 1 }], cuts)[0];
  assert.equal(at([0.5, 1.6, 2.5]).at, 1.6);
  assert.equal(at([0.5, 1.6, 2.5]).pauseAt, 1.6);
  assert.equal(at([0.5]).at, 1);
  assert.equal(at([1.9]).at, 1);
});

test('sections end at a sentence, keep quiet stretches whole, and prefer scene cuts and chapters', () => {
  const words = [];
  let t = 0;
  while (t < 300) {
    if (t > 86 && t < 88) t = 92;
    for (let i = 0; i < 8; i++) {
      words.push({ start: t, end: t + 0.45, word: i === 7 ? 'end.' : 'x' });
      t += 0.5;
    }
    t += 0.6;
  }
  const sections = planSections(300, words);
  for (const section of sections.slice(0, -1)) {
    const before = words.filter((word) => word.end <= section.end).at(-1);
    assert.equal(before.word, 'end.', `cut after "${before.word}" at ${section.end}`);
    assert.ok(section.end < 86 || section.end > 92, 'the quiet stretch stays whole');
  }
  const flat = Array.from({ length: 600 }, (_, i) => ({
    start: i * 0.5,
    end: i * 0.5 + 0.15,
    word: 'x',
  }));
  const cut = planSections(300, flat, 90, 60, 120, { cuts: [97.2] });
  assert.equal(cut[0].end, 97.2);
  const chapter = planSections(300, flat, 90, 60, 120, { chapters: [104] });
  assert.ok(Math.abs(chapter[0].end - 104) < 0.5, `chapter cut at ${chapter[0].end}`);
});

test('ducking ramps fit inside the section, and each line has its own depth and release', () => {
  const frames = sampleRate * 3;
  const curve = duckCurve(frames, [
    { start: 0.05, end: 0.5, gain: 0.25 },
    { start: 2.6, end: 2.9, gain: 0.5 },
  ]);
  assert.equal(curve[0], 1, 'a line at the very start still begins at full level');
  assert.ok(Math.abs(curve[Math.round(0.3 * sampleRate)] - 0.25) < 1e-6);
  assert.ok(curve[frames - 1] > 0.99, 'and the section ends at full level');
  assert.ok(Math.abs(curve[Math.round(2.7 * sampleRate)] - 0.5) < 1e-6);
  const quick = duckCurve(frames, [{ start: 1, end: 1.5, gain: 0.25, release: 0.2 }]);
  assert.equal(quick[Math.round(1.71 * sampleRate)], 1);
  const both = duckCurve(frames, [
    { start: 1, end: 1.5, gain: 0.5 },
    { start: 1.2, end: 1.4, gain: 0.25 },
  ]);
  assert.ok(
    Math.abs(both[Math.round(1.3 * sampleRate)] - 0.25) < 1e-6,
    'overlaps take the deeper dip',
  );
});

test('the dip under a line follows how loud the soundtrack is there (EBU TR 084)', () => {
  const tone = sine(5, 1000, 0.1, 2);
  for (let i = sampleRate; i < sampleRate * 4.5; i++) {
    tone[i * 2] *= 3;
    tone[i * 2 + 1] *= 3;
  }
  assert.ok(Math.abs(shortTermMax(tone, 0, 5) - (-20 + 20 * Math.log10(3))) < 0.3);
  assert.ok(Math.abs(shortTermMax(tone, 0, 0.9) - -20) < 0.2, 'short lines use their own loudness');
  assert.equal(duckDepth(-50, -18), 0);
  assert.equal(duckDepth(-35, -18), -3);
  assert.equal(duckDepth(-25, -18), -9);
  assert.equal(duckDepth(-15, -18), -19);
  assert.equal(duckDepth(-5, -18), -23, 'deep enough to keep the narrator 10 LU above');
  assert.equal(duckDepth(-2, -18, 1.3), -24, 'never more than 24 dB');
  assert.ok(Math.abs(duckDepth(-25, -18, 0.7) - -6.3) < 1e-9);
  assert.equal(duckDepth(-32, -30), -8);
  assert.equal(duckDepth(-Infinity, -18), 0);
});

test('pauses fade only inside the breath, and a section without pauses is mixed in place', () => {
  const program = sine(2, 220, 0.5, 2);
  const out = pauseProgram(
    program,
    [{ at: 1, length: 0.5, fadeOut: 0.01, fadeIn: 0.02 }],
    sampleRate * 2.5,
  );
  let before = 0;
  for (let i = Math.round(0.97 * sampleRate); i < Math.round(0.985 * sampleRate); i++)
    before = Math.max(before, Math.abs(out[i * 2]));
  assert.ok(before > 0.45, 'full level until 10 ms before the freeze');
  assert.equal(pauseProgram(program, [], sampleRate * 2), program);
  const mixed = mix(program, 0.5, [], [{ at: 1, pcm: new Float32Array(10).fill(0.25) }]);
  assert.equal(mixed, program);
  assert.ok(Math.abs(mixed[sampleRate * 2] - 0.25) < 1e-6);
});

test('the narrator is set against the dialogue, with fallbacks for older plans', () => {
  const plan = (loudness) => ({ audio: true, loudness });
  const dialogue = plan({ program: -24, peak: -6, dialogue: -22 });
  assert.equal(levelsFor(dialogue, 'balanced').gain, 4);
  assert.equal(levelsFor(dialogue, 'balanced').narration, -17);
  assert.equal(levelsFor(dialogue, 'softer').narration, -20);
  assert.equal(levelsFor(dialogue, 'louder').narration, -14);
  const wide = levelsFor(plan({ program: -24, peak: -6, lra: 11 }), 'balanced');
  assert.ok(Math.abs(wide.narration - (-24 - 1.9 + 1 + 4)) < 1e-9);
  const blocks = [];
  for (let i = 0; i < 600; i++)
    blocks.push({ time: i / 10, lufs: i >= 100 && i < 400 ? -20 : -35 });
  const words = Array.from({ length: 30 }, (_, i) => ({ start: 10 + i, end: 10.9 + i, word: 'x' }));
  assert.ok(Math.abs(dialogueLoudness(blocks, words, 60) - -20) < 0.2);
  assert.equal(dialogueLoudness(blocks, words.slice(0, 2), 60), undefined, 'too little speech');
});

test('one click no longer decides how loud the whole copy is', () => {
  const quiet = [];
  for (let i = 0; i < 3000; i++) quiet.push({ time: i / 10, lufs: -32 + 8 * Math.sin(i / 50) });
  const clean = { audio: true, loudness: { program: -32, peak: steadyPeak(-12, quiet) } };
  const clicked = { audio: true, loudness: { program: -32, peak: steadyPeak(-0.5, quiet) } };
  assert.equal(levelsFor(clean, 'balanced').gain, 12);
  assert.equal(levelsFor(clicked, 'balanced').gain, 12);
  const loud = [];
  for (let i = 0; i < 3000; i++) loud.push({ time: i / 10, lufs: i % 100 < 30 ? -10 : -30 });
  assert.equal(steadyPeak(-0.5, loud), -0.5, 'real loud passages still limit the gain');
  assert.equal(steadyPeak(-3), -3);
});

test('chapters follow the part being described and the pauses added to it', () => {
  const chapters = [
    { start: 0, title: 'A' },
    { start: 90, title: 'B' },
    { start: 150, title: 'C' },
    { start: 250, title: 'D' },
  ];
  assert.deepEqual(workingChapters(chapters, { start: 100, end: 200 }, 100), [
    { start: 0, title: 'B' },
    { start: 50, title: 'C' },
  ]);
  assert.deepEqual(
    workingChapters(chapters, undefined, 200).map((item) => item.title),
    ['A', 'B', 'C'],
  );
  const records = [
    { index: 0, start: 0, end: 60, outputSeconds: 62, placements: [{ pauseAt: 10, pause: 2 }] },
    { index: 1, start: 60, end: 120, outputSeconds: 60, placements: [] },
  ];
  assert.deepEqual(
    outputChapters(
      [
        { start: 5, title: 'X' },
        { start: 30, title: 'Y' },
        { start: 90, title: 'Z' },
        { start: 130, title: 'Later' },
      ],
      records,
    ),
    [
      { start: 5, title: 'X' },
      { start: 32, title: 'Y' },
      { start: 92, title: 'Z' },
    ],
  );
});

test('close look slows the entire clip and maps descriptions back onto the original timeline', async () => {
  const f = await fixture('close-look');
  const slowed = await sectionClip(f.file, f.dir, 0, 9, signal, true);
  const inspected = await probe(slowed, signal);
  assert.ok(
    inspected.seconds > 35 && inspected.seconds < 37,
    `slowed duration ${inspected.seconds}`,
  );
  const result = await run(
    f,
    [],
    (look) => {
      assert.equal(look.brief.slowed, true);
      assert.ok(look.seconds > 35);
      return [{ ...cue, at: 4, until: 24, pauseAt: 4 }];
    },
    { settings: { ...settings, closeLook: true } },
  );
  assert.ok(result.report.descriptions[0].at >= 1 && result.report.descriptions[0].at < 2);
  assert.ok(Math.abs(result.report.outputSeconds - 9) < 0.2);
});

test('whole-film first look checkpoints, resumes, and finishes before any narration', async () => {
  const f = await fixture('first-look', 130);
  const state = { kind: '', setting: '', people: [], speakers: [], recent: [] };
  const keeper = {
    saved: {
      plan: {
        version: 2,
        seconds: 130,
        audio: true,
        fps: { num: 30, den: 1 },
        loudness: { program: -20, peak: -2 },
        sections: [
          { start: 0, end: 65 },
          { start: 65, end: 130 },
        ],
      },
      words: [],
      records: [],
    },
    keepPlan: async () => {},
    keepSection: async () => {},
    keepFirstLook: async (value) => {
      keeper.saved.firstLook = value;
    },
    restore: async () => {
      throw Error('No stored render');
    },
  };
  let surveys = 0,
    fail = true,
    voiced = 0;
  const backend = providers(f.voice, [], [cue]);
  const analyze = backend.analyze;
  backend.analyze = async (look) => {
    if (look.brief.survey) {
      surveys++;
      assert.equal(voiced, 0);
      if (fail && surveys === 2) throw new Halt('Test interruption');
      return {
        ...state,
        cues: [],
        protectedSounds: [],
        people: [{ label: 'the host', name: 'Pat', look: 'blue shirt' }],
      };
    }
    assert.equal(keeper.saved.firstLook.through, 2);
    assert.equal(look.brief.orientation[0].name, 'Pat');
    assert.equal(
      look.state?.people.some((person) => person.name === 'Pat') || false,
      false,
      'future names are not seeded into current continuity',
    );
    const prompt = analysisPrompt(look.seconds, look.brief, look.state, look.lines, look.before);
    assert.match(prompt, /Do not speak any name from this reference until/);
    return analyze(look);
  };
  const synthesize = backend.synthesize;
  backend.synthesize = async (...args) => {
    voiced++;
    return synthesize(...args);
  };
  await assert.rejects(
    run(f, [], [], { settings: { ...settings, firstLook: true }, keeper, providers: backend }),
    /Test interruption/,
  );
  assert.equal(keeper.saved.firstLook.through, 1);
  fail = false;
  const result = await run(f, [], [], {
    settings: { ...settings, firstLook: true },
    keeper,
    providers: backend,
  });
  assert.equal(surveys, 3, 'the first completed survey section was not repeated');
  assert.ok(result.report.descriptions.length > 0);
});

async function fixture(name, seconds = 9, audio = true, sound = '') {
  const dir = join(root, name);
  await mkdir(dir);
  const file = join(dir, 'source.mp4');
  const args = [
    '-nostdin',
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=160x120:rate=30:duration=${seconds}`,
  ];
  if (audio)
    args.push(
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=220:sample_rate=48000:duration=${seconds}${sound ? ',' + sound : ''}`,
    );
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac', '-b:a', '192k');
  args.push(file);
  await command(ffmpegPath, args, signal);
  const voice = join(dir, 'voice.wav');
  await command(
    ffmpegPath,
    [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=660:sample_rate=24000:duration=3',
      voice,
    ],
    signal,
  );
  return { dir, file, voice, work: join(dir, 'work') };
}
const meter = async (_kind, _reserve, action) => {
  await action();
};
const progress = async () => {};
function providers(voice, words, cues) {
  const calls = { analyze: 0, synthesize: 0 };
  return {
    calls,
    transcribe: async () => words,
    analyze: async (look) => {
      calls.analyze++;
      return {
        kind: 'other',
        setting: 'A test pattern.',
        people: [],
        speakers: [],
        protectedSounds: [],
        cues: typeof cues === 'function' ? cues(look) : cues,
      };
    },
    synthesize: async (_text, _voice, _session, file) => {
      calls.synthesize++;
      await copyFile(voice, file);
    },
  };
}
async function run(f, words, cues, overrides = {}) {
  await mkdir(f.work, { recursive: true });
  const backend = overrides.providers || providers(f.voice, words, cues);
  const result = await describeVideo({
    source: overrides.source || f.file,
    directory: f.work,
    title: 'Test pattern',
    about: '',
    settings: overrides.settings || settings,
    session: 'synthetic-test',
    signal,
    meter,
    progress: overrides.progress || progress,
    providers: backend,
    keeper: overrides.keeper,
    stopAfter: overrides.stopAfter,
    chapters: overrides.chapters,
    sectionNotes: overrides.sectionNotes,
    log: overrides.log ? (line) => overrides.log.push(line) : undefined,
  });
  return { ...result, backend };
}
/** An HTTP error shaped the way axios reports one. */
const httpError = (status) =>
  new AxiosError(
    `Request failed with status code ${status}`,
    'ERR_BAD_RESPONSE',
    undefined,
    undefined,
    {
      status,
      statusText: '',
      headers: {},
      config: { headers: {} },
      data: {},
    },
  );
/** A plan as a keeper would hand it back, cut at the given whole-frame times. */
function savedPlan(seconds, cuts, extra = {}) {
  const points = [0, ...cuts, seconds];
  return {
    version: 2,
    seconds,
    audio: true,
    fps: { num: 30, den: 1 },
    loudness: { program: -20, peak: -2 },
    sections: points.slice(0, -1).map((start, i) => ({ start, end: points[i + 1] })),
    ...extra,
  };
}
/** A keeper that remembers everything the engine hands it. */
function keeperFor(plan, words = [], saved = {}) {
  const kept = { plans: [], records: [], files: new Map(), looks: [] };
  const keeper = {
    saved: { plan, words, records: [], ...saved },
    keepPlan: async (value) => {
      kept.plans.push(value);
    },
    keepLook: async (index, look) => {
      kept.looks.push({ index, look });
    },
    keepSection: async (record, files) => {
      kept.records.push(record);
      kept.files.set(record.index, files);
    },
    restore: async (index) => kept.files.get(index),
  };
  return { keeper, kept };
}
/** A fake voice whose clips last as long as a real one would: 1/16 s per byte at 1x. */
function measuredVoice() {
  const texts = [];
  return {
    texts,
    synthesize: async (text, _voice, _session, file, speed) => {
      texts.push(text);
      const seconds = (Buffer.byteLength(text, 'utf8') * 0.0625) / speed;
      await command(
        ffmpegPath,
        [
          '-nostdin',
          '-v',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          `sine=frequency=660:sample_rate=24000:duration=${seconds.toFixed(3)}`,
          file,
        ],
        signal,
      );
    },
  };
}
/** The whole soundtrack of a file as 48 kHz mono samples. */
async function decode(file) {
  const raw = await command(
    ffmpegPath,
    [
      '-nostdin',
      '-v',
      'error',
      '-i',
      file,
      '-map',
      '0:a:0',
      '-ar',
      '48000',
      '-ac',
      '1',
      '-f',
      'f32le',
      'pipe:1',
    ],
    signal,
    undefined,
    256 * 1024 ** 2,
  );
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
}
/** Amplitude of one frequency in a short window of decoded samples. */
function tone(pcm, start, length, frequency = 220) {
  const a = Math.round(start * 48000);
  const b = Math.round((start + length) * 48000);
  let re = 0,
    im = 0;
  for (let i = a; i < b; i++) {
    const phase = (2 * Math.PI * frequency * i) / 48000;
    re += pcm[i] * Math.cos(phase);
    im += pcm[i] * Math.sin(phase);
  }
  return Math.hypot(re, im) / (b - a);
}
const dB = (value, reference) => 20 * Math.log10(value / reference);
async function amplitude(file, at, frequency) {
  const pcm = await command(
    ffmpegPath,
    [
      '-nostdin',
      '-v',
      'error',
      '-ss',
      String(at),
      '-i',
      file,
      '-t',
      '0.25',
      '-vn',
      '-ar',
      '48000',
      '-ac',
      '1',
      '-f',
      's16le',
      'pipe:1',
    ],
    signal,
  );
  let re = 0,
    im = 0;
  for (let i = 0; i < pcm.length / 2; i++) {
    const value = pcm.readInt16LE(i * 2) / 32768;
    const phase = (2 * Math.PI * frequency * i) / 48000;
    re += value * Math.cos(phase);
    im += value * Math.sin(phase);
  }
  return Math.hypot(re, im) / (pcm.length / 2);
}
const videoHash = async (file) =>
  (
    await command(
      ffmpegPath,
      ['-nostdin', '-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'md5', '-'],
      signal,
    )
  )
    .toString()
    .trim();

test('standard mode keeps the original picture untouched, the runtime, and the soundtrack around a ducked narration', async () => {
  const f = await fixture('standard');
  const result = await run(
    f,
    [
      { start: 0, end: 2, word: 'dialogue' },
      { start: 6, end: 8.8, word: 'dialogue' },
    ],
    [{ ...cue, at: 2, until: 6 }],
  );
  assert.equal(await videoHash(result.video), await videoHash(f.file));
  assert.ok(Math.abs(result.report.outputSeconds - 9) < 0.05);
  assert.equal(result.report.descriptions.length, 1);
  assert.equal(result.report.skipped.length, 0);
  const narration = result.report.descriptions[0];
  assert.ok(narration.at >= 2.2 && narration.at + narration.duration <= 6);
  assert.ok((await amplitude(result.audio, 0.5, 220)) > 0.02);
  assert.ok((await amplitude(result.audio, 0.5, 660)) < 0.002);
  assert.ok((await amplitude(result.audio, narration.at + 0.8, 660)) > 0.02);
  const ducked = await amplitude(result.audio, narration.at + 0.8, 220);
  assert.ok(
    ducked > 0.003 && ducked < (await amplitude(result.audio, 0.5, 220)) * 0.6,
    'soundtrack ducks under narration',
  );
  assert.ok((await amplitude(result.audio, 7.5, 660)) < 0.002);
  const text = await readFile(result.files.transcript, 'utf8');
  assert.match(text, /Description: A red square moves across the room\./);
  assert.match(text, /Speaker: dialogue/);
  assert.match(await readFile(result.files.descriptions, 'utf8'), /^WEBVTT/);
});

test('extended mode pauses picture and sound, and the frozen picture lines up with the narration', async () => {
  const f = await fixture('extended');
  const words = Array.from({ length: 90 }, (_, i) => ({
    start: i / 10,
    end: (i + 1) / 10,
    word: 'speech',
  }));
  const result = await run(f, words, [{ ...cue, at: 2, until: 3, pauseAt: 2 }], {
    settings: { ...settings, mode: 'extended' },
  });
  const placed = result.report.descriptions[0];
  assert.ok(placed.inserted);
  const media = await probe(result.video, signal);
  assert.ok(Math.abs(media.seconds - result.report.outputSeconds) < 0.1);
  assert.ok(Math.abs(result.report.outputSeconds - (9 + placed.pause)) < 0.05);
  assert.ok((await amplitude(result.audio, placed.outputAt + 0.5, 660)) > 0.02);
  assert.ok((await amplitude(result.audio, placed.outputAt + 0.5, 220)) < 0.003);
  assert.ok((await amplitude(result.audio, result.report.outputSeconds - 0.7, 220)) > 0.02);
  const frames = Number(
    (
      await command(
        ffprobePath.path,
        [
          '-v',
          'error',
          '-count_frames',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=nb_read_frames',
          '-of',
          'csv=p=0',
          result.video,
        ],
        signal,
      )
    ).toString(),
  );
  assert.equal(frames, Math.round(result.report.outputSeconds * 30));
});

test('minor details are left out rather than stopping the video, and omissions are reported', async () => {
  const f = await fixture('omitted');
  const result = await run(
    f,
    [{ start: 0, end: 9, word: 'speech' }],
    [cue, { ...cue, importance: 1, text: 'A minor detail.' }],
  );
  assert.equal(result.report.descriptions.length, 0);
  assert.equal(result.report.skipped.length, 2);
  const extended = await run(
    await fixture('omitted-extended'),
    [{ start: 0, end: 9, word: 'speech' }],
    [cue, { ...cue, importance: 1, text: 'A minor detail.' }],
    { settings: { ...settings, mode: 'extended' } },
  );
  assert.equal(extended.report.descriptions.length, 1);
  assert.match(extended.report.skipped[0].reason, /minor detail/);
});

test('several extended pauses in a section stay aligned through the whole copy', async () => {
  const f = await fixture('many-pauses', 20);
  const words = Array.from({ length: 200 }, (_, i) => ({
    start: i / 10,
    end: (i + 1) / 10,
    word: 'speech',
  }));
  const cues = Array.from({ length: 6 }, (_, i) => ({
    ...cue,
    at: 1.17 + i * 3.1,
    until: 1.8 + i * 3.1,
    pauseAt: 1.17 + i * 3.1,
    text: `Description ${i}.`,
    shortText: `Cue ${i}.`,
  }));
  const result = await run(f, words, cues, { settings: { ...settings, mode: 'extended' } });
  assert.equal(result.report.descriptions.length, 6);
  for (const placed of result.report.descriptions) {
    assert.ok(placed.inserted);
    assert.ok(
      (await amplitude(result.audio, placed.outputAt + 0.3, 220)) < 0.003,
      `soundtrack intrudes at ${placed.outputAt}`,
    );
    assert.ok((await amplitude(result.audio, placed.outputAt + 0.5, 660)) > 0.02);
  }
  const media = await probe(result.video, signal);
  assert.ok(Math.abs(media.seconds - result.report.outputSeconds) < 0.1);
});

test('a silent video gets narration and a soundtrack stream', async () => {
  const f = await fixture('silent', 9, false);
  const result = await run(f, [], [cue]);
  assert.equal((await probe(result.video, signal)).audio, true);
  assert.equal(result.report.descriptions.length, 1);
  assert.ok(
    (await amplitude(result.audio, result.report.descriptions[0].outputAt + 0.5, 660)) > 0.02,
  );
});

test('long videos: continuity, a section that failed on a passing error is tried again at the end, resume, and re-voicing', async () => {
  const f = await fixture('sections', 20);
  const seen = [];
  const backend = providers(f.voice, [], []);
  backend.analyze = async (look) => {
    seen.push(look);
    if (seen.length === 2) throw httpError(503);
    return {
      kind: 'other',
      setting: 'A test pattern.',
      people: [{ label: 'the square', name: '', look: 'red' }],
      speakers: [],
      protectedSounds: [],
      cues: [{ ...cue, at: 1, until: 5 }],
    };
  };
  const { keeper, kept } = keeperFor(savedPlan(20, [6.5, 13]));
  const log = [];
  const first = await run(f, [], [], { providers: backend, keeper, log });
  assert.equal(seen.length, 4, 'the failed section was looked at once more at the end');
  assert.deepEqual(
    seen.map((look) => look.brief.position.index),
    [0, 1, 2, 1],
  );
  assert.equal(seen[3].state.people[0].label, 'the square', 'the retry keeps its continuity');
  assert.equal(first.report.failedSections.length, 0);
  assert.equal(first.report.descriptions.length, 3);
  assert.deepEqual(
    [...kept.records]
      .sort((a, b) => a.index - b.index)
      .flatMap((record) => record.placements.map((item) => item.id)),
    ['0:0', '1:0', '2:0'],
    'each spoken description names its cue in the script',
  );
  assert.deepEqual(
    kept.records.map((record) => record.index),
    [0, 2, 1],
  );
  assert.deepEqual(
    kept.looks.map((look) => look.index).sort(),
    [0, 1, 2],
    'every paid look is kept, the look ahead included',
  );
  assert.ok(log.some((line) => /trying again after a passing provider error/.test(line)));
  assert.ok(log.some((line) => /Section 2 of 3 could not be described \(transient\)/.test(line)));
  assert.ok(!log.some((line) => line.includes(root)), 'no temporary paths in the log');
  assert.ok(Math.abs(first.report.outputSeconds - 20) < 0.1);

  const resumed = providers(f.voice, [], [{ ...cue, at: 1, until: 5 }]);
  const again = await run(f, [], [], {
    providers: resumed,
    keeper: {
      ...keeper,
      saved: { plan: keeper.saved.plan, words: [], records: kept.records.slice(0, 2) },
    },
  });
  assert.equal(resumed.calls.analyze, 1, 'only the unfinished section is watched again');
  assert.equal(again.report.descriptions.length, 3);
  assert.ok(Math.abs(again.report.outputSeconds - first.report.outputSeconds) < 0.05);

  const revoiced = providers(f.voice, [], []);
  const voiced = await run(f, [], [], {
    providers: revoiced,
    settings: { ...settings, rate: 2, maxRate: 3 },
    keeper: {
      ...keeper,
      saved: {
        plan: keeper.saved.plan,
        words: [],
        records: [],
        analyses: [...kept.records]
          .sort((a, b) => a.index - b.index)
          .map((record) => record.analysis),
      },
    },
  });
  assert.equal(revoiced.calls.analyze, 0, 're-voicing reuses the saved descriptions');
  assert.equal(voiced.report.descriptions.length, 3);
  assert.ok(voiced.report.descriptions.every((item) => item.rate >= 2));
});

test('a dropped voice clip gets one more try at the end of its section', async () => {
  const f = await fixture('voice-failure');
  const backend = providers(f.voice, [], [cue, { ...cue, at: 5, until: 8.5, text: 'Second.' }]);
  let calls = 0;
  backend.synthesize = async (_text, _voice, _session, file) => {
    if (++calls === 1) throw new Error('The selected voice did not return playable audio.');
    await copyFile(f.voice, file);
  };
  const result = await run(f, [], [], { providers: backend });
  assert.equal(result.report.descriptions.length, 2);
  assert.equal(result.report.skipped.length, 0);
  assert.equal(calls, 3);
});

test('a description whose voice fails twice is reported, not fatal', async () => {
  const f = await fixture('voice-failure-twice');
  const backend = providers(f.voice, [], [cue, { ...cue, at: 5, until: 8.5, text: 'Second.' }]);
  const attempts = [];
  backend.synthesize = async (text, _voice, _session, file) => {
    attempts.push(text);
    if (text === 'Second.') throw new Error('The selected voice did not return playable audio.');
    await copyFile(f.voice, file);
  };
  const result = await run(f, [], [], { providers: backend });
  assert.equal(result.report.descriptions.length, 1);
  assert.equal(result.report.skipped.length, 1);
  assert.match(result.report.skipped[0].reason, /voice service/);
  assert.equal(attempts.filter((text) => text === 'Second.').length, 2);
  assert.ok((await stat(result.video)).size > 1000);
});

test('pauses in every section of a 29.97 fps film keep picture and sound the same length', async () => {
  const dir = join(root, 'drift');
  await mkdir(dir);
  const file = join(dir, 'source.mp4');
  await command(
    ffmpegPath,
    [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x120:rate=30000/1001:duration=200',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:sample_rate=44100:duration=200',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      file,
    ],
    signal,
  );
  const voice = join(dir, 'voice.wav');
  await command(
    ffmpegPath,
    [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=660:sample_rate=24000:duration=2',
      voice,
    ],
    signal,
  );
  const words = Array.from({ length: 2000 }, (_, i) => ({
    start: i / 10,
    end: (i + 1) / 10,
    word: 'speech',
  }));
  const result = await run(
    { dir, file, voice, work: join(dir, 'work') },
    words,
    (look) => [
      { ...cue, at: 3, until: 4, pauseAt: 3.02 },
      { ...cue, at: look.seconds - 10, until: look.seconds - 9, pauseAt: look.seconds - 10 },
    ],
    { settings: { ...settings, mode: 'extended' } },
  );
  assert.ok(result.report.descriptions.length >= 4);
  const streams = JSON.parse(
    (
      await command(
        ffprobePath.path,
        [
          '-v',
          'error',
          '-count_frames',
          '-show_entries',
          'stream=codec_type,nb_read_frames,duration',
          '-of',
          'json',
          result.video,
        ],
        signal,
      )
    ).toString(),
  ).streams;
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const expected = Math.round((result.report.outputSeconds * 30000) / 1001);
  assert.ok(
    Math.abs(Number(video.nb_read_frames) - expected) <= 1,
    `${video.nb_read_frames} frames, expected ${expected}`,
  );
  assert.ok(
    Math.abs(Number(audio.duration) - Number(video.duration)) < 0.06,
    `audio ${audio.duration} vs video ${video.duration}`,
  );
  const last = result.report.descriptions.at(-1);
  assert.ok(
    (await amplitude(result.audio, last.outputAt + 0.4, 660)) > 0.02,
    'last narration is where the report says',
  );
  assert.ok(
    (await amplitude(result.audio, last.outputAt + 0.4, 220)) < 0.003,
    'and the soundtrack is paused under it',
  );
});

test('pause mode keeps the word before a freeze and the word after it at full level', async () => {
  const f = await fixture('pause-edges', 8);
  const words = [
    { word: 'Look', start: 1.0, end: 1.3 },
    { word: 'there.', start: 1.35, end: 2.0 },
    { word: 'Now', start: 2.25, end: 2.6 },
    { word: 'go', start: 2.65, end: 3.0 },
  ];
  const result = await run(f, words, [{ ...cue, at: 1.2, until: 2.4, pauseAt: 1.2 }], {
    settings: { ...settings, mode: 'extended' },
  });
  const placed = result.report.descriptions[0];
  assert.ok(placed.inserted);
  assert.ok(placed.pauseAt >= 2.02 && placed.pauseAt <= 2.22, `froze at ${placed.pauseAt}`);
  const pcm = await decode(result.audio);
  const reference = tone(pcm, 0.4, 0.1);
  for (const back of [0.1, 0.08, 0.06, 0.04, 0.02]) {
    const heard = dB(tone(pcm, 2.0 - back, 0.02), reference);
    assert.ok(heard > -1.5, `${back} s before the word ends: ${heard.toFixed(1)} dB`);
  }
  const resumed = 2.25 + placed.pause;
  const next = dB(tone(pcm, resumed, 0.05), reference);
  assert.ok(next > -1.5, `the next word starts at ${next.toFixed(1)} dB`);
});

test('a description near the end of a section in pause mode is never cut off', async () => {
  const f = await fixture('section-end', 9);
  const words = [];
  for (let t = 3; t < 5.8; t += 0.4) words.push({ word: 'w', start: t, end: t + 0.3 });
  const result = await run(
    f,
    words,
    [{ ...cue, at: 7.3, until: 8.8, pauseAt: 7.3, text: 'The station logo spins into view.' }],
    { settings: { ...settings, mode: 'extended' } },
  );
  const placed = result.report.descriptions[0];
  const end = placed.outputAt + placed.duration;
  assert.ok(
    end <= result.report.outputSeconds + 1e-6,
    `ends ${end} of ${result.report.outputSeconds}`,
  );
  const pcm = await decode(result.audio);
  assert.ok(pcm.length / 48000 >= end - 0.05, 'the file holds the whole narration');
  assert.ok(tone(pcm, end - 0.25, 0.1, 660) > 0.01, 'the last words are still there');
  const vtt = await readFile(result.files.descriptions, 'utf8');
  const [, h, m, s] = /--> (\d\d):(\d\d):(\d\d\.\d+)/.exec(vtt);
  assert.ok(Number(h) * 3600 + Number(m) * 60 + Number(s) <= result.report.outputSeconds + 0.001);
});

test('section joins keep the soundtrack level and space the descriptions apart', async () => {
  const f = await fixture('join', 20);
  const { keeper } = keeperFor(savedPlan(20, [10]));
  const result = await run(
    f,
    [],
    (look) =>
      look.brief.position.index === 0
        ? [{ ...cue, at: 7, until: 9.99, pauseAt: 7 }]
        : [{ ...cue, at: 0, until: 5, pauseAt: 0 }],
    { keeper },
  );
  const [a, b] = result.report.descriptions;
  assert.ok(a.outputAt + a.duration <= 10 - 0.25 + 1e-6, 'room for the soundtrack to come back up');
  assert.ok(b.outputAt >= 10.1 - 1e-6);
  assert.ok(b.outputAt - (a.outputAt + a.duration) >= 0.35 - 1e-6);
  const pcm = await decode(result.audio);
  const reference = tone(pcm, 3, 0.1);
  const before = dB(tone(pcm, 9.98, 0.02), reference);
  const after = dB(tone(pcm, 10.0, 0.02), reference);
  assert.ok(
    before > -1.5 && after > -1.5,
    `join: ${before.toFixed(1)} dB then ${after.toFixed(1)} dB`,
  );
});

test('each line is ducked by how loud the soundtrack is under it, and the dip is saved', async () => {
  const f = await fixture('per-line', 12, true, "volume='if(lt(t,6),0.02,1)':eval=frame");
  const result = await run(
    f,
    [],
    [
      { ...cue, at: 1, until: 5.5 },
      { ...cue, at: 7, until: 11.5 },
    ],
  );
  const [quiet, loud] = result.report.descriptions;
  assert.equal(quiet.dip, 0, 'nothing to duck under a near-silent bed');
  assert.ok(loud.dip <= -8, `loud bed dipped ${loud.dip} dB`);
  const pcm = await decode(result.audio);
  const bed = dB(tone(pcm, quiet.outputAt + 1, 0.1), tone(pcm, 0.4, 0.1));
  assert.ok(Math.abs(bed) < 1, `quiet bed under narration: ${bed.toFixed(1)} dB`);
});

test('the duck releases before the next line of dialogue', async () => {
  const f = await fixture('release', 9);
  const words = [
    { word: 'Wait.', start: 0, end: 1.5 },
    { word: 'Hello.', start: 4.95, end: 5.5 },
  ];
  const result = await run(f, words, [{ ...cue, at: 1.5, until: 4.9 }]);
  const placed = result.report.descriptions[0];
  const end = placed.outputAt + placed.duration;
  assert.ok(4.95 - end < 0.5, `narration ends ${(4.95 - end).toFixed(2)} s before the line`);
  const pcm = await decode(result.audio);
  const line = dB(tone(pcm, 4.95, 0.02), tone(pcm, 7, 0.1));
  assert.ok(line > -1, `the line starts at ${line.toFixed(1)} dB`);
});

test('only the text that will be heard is voiced, and the measured speed is kept in the plan', async () => {
  const f = await fixture('spend', 9);
  const voice = measuredVoice();
  const backend = providers(f.voice, [], []);
  backend.transcribe = async () => [
    { word: 'Talk', start: 0, end: 1 },
    { word: 'more.', start: 3.9, end: 9 },
  ];
  backend.synthesize = voice.synthesize;
  const short = 'A woman walks to the diner.';
  const minor = 'A minor detail: raindrops run down the diner window in thin silver lines.';
  backend.analyze = async () => ({
    kind: 'other',
    setting: '',
    people: [],
    speakers: [],
    protectedSounds: [],
    cues: [
      {
        at: 1,
        until: 3.8,
        text: 'A tall woman in a long red coat walks slowly across the wet, empty parking lot to the diner.',
        shortText: short,
        importance: 3,
      },
      { at: 1.5, until: 3.8, text: minor, shortText: minor, importance: 1 },
    ],
  });
  const { keeper, kept } = keeperFor(undefined);
  const result = await run(f, [], [], {
    providers: backend,
    keeper,
    settings: { ...settings, mode: 'extended' },
  });
  assert.deepEqual(voice.texts, [short], 'the long text and the minor detail were never paid for');
  assert.equal(result.report.descriptions[0].shortened, true);
  assert.match(result.report.skipped[0].reason, /minor detail/);
  const measured = kept.plans.at(-1).secondsPerByte;
  assert.ok(Math.abs(measured - 0.0625) < 0.005, `measured ${measured} s per byte`);
});

test('a longer voice than expected switches to the short text, and a lost short voice is the reason given', async () => {
  const f = await fixture('switch', 9);
  const short = 'The square moves.';
  const full = 'A red square slides across the room fast.';
  const backend = providers(f.voice, [], []);
  backend.transcribe = async () => [
    { word: 'a', start: 0, end: 1 },
    { word: 'b', start: 3.02, end: 9 },
  ];
  backend.analyze = async () => ({
    kind: 'other',
    setting: '',
    people: [],
    speakers: [],
    protectedSounds: [],
    cues: [{ at: 1, until: 2.9, text: full, shortText: short, importance: 3 }],
  });
  const tried = [];
  const slow = measuredVoice();
  backend.synthesize = async (text, voice, session, file, speed, ...rest) => {
    tried.push(text);
    if (text === short) throw new Error('The selected voice did not return playable audio.');
    return slow.synthesize(
      text + ' '.repeat(Buffer.byteLength(text) / 2),
      voice,
      session,
      file,
      speed,
      ...rest,
    );
  };
  const result = await run(f, [], [], { providers: backend });
  assert.deepEqual(tried, [full, short, short]);
  assert.equal(result.report.descriptions.length, 0);
  assert.match(result.report.skipped[0].reason, /voice service/);
});

test('the plan measures the dialogue on its own and sets the narrator against it', async () => {
  const f = await fixture(
    'dialogue-level',
    20,
    true,
    "volume='if(between(t,5,15),0.3,1)':eval=frame",
  );
  const words = Array.from({ length: 19 }, (_, i) => ({
    word: 'talk',
    start: 5.3 + i * 0.5,
    end: 5.7 + i * 0.5,
  }));
  const { keeper, kept } = keeperFor(undefined);
  const result = await run(f, words, [], { keeper });
  const { loudness } = kept.plans[0];
  const music = -21.7;
  const expected = music + 20 * Math.log10(0.3);
  assert.ok(Math.abs(loudness.dialogue - expected) < 1.5, `dialogue ${loudness.dialogue} LUFS`);
  assert.ok(loudness.dialogue < loudness.program - 5, 'the music does not set the narrator level');
  assert.ok(Number.isFinite(loudness.lra));
  const { gain, narration } = result.report.loudness;
  assert.ok(Math.abs(narration - Math.max(-26, loudness.dialogue + gain + 1)) < 1e-9);
});

test('a capture with sound on one side only is heard in both ears', async () => {
  const f = await fixture('one-sided', 9, true, 'pan=stereo|c0=c0|c1=0*c0');
  const { keeper } = keeperFor({ ...savedPlan(9, []), oneSided: 'left' });
  const result = await run(f, [], [], { keeper });
  const right = await command(
    ffmpegPath,
    [
      '-nostdin',
      '-v',
      'error',
      '-i',
      result.audio,
      '-af',
      'pan=mono|c0=c1',
      '-ar',
      '48000',
      '-f',
      'f32le',
      'pipe:1',
    ],
    signal,
    undefined,
    64 * 1024 ** 2,
  );
  const pcm = new Float32Array(
    right.buffer.slice(right.byteOffset, right.byteOffset + right.byteLength),
  );
  assert.ok(tone(pcm, 4, 0.5) > 0.01, 'the live left channel is copied to the right');
});

test('a preview renders the first sections only, and finishing reuses them', async () => {
  const f = await fixture('preview', 20);
  const plan = savedPlan(20, [6.5, 13]);
  const { keeper, kept } = keeperFor(plan);
  const backend = providers(f.voice, [], [{ ...cue, at: 1, until: 5 }]);
  const preview = await run(f, [], [], { providers: backend, keeper, stopAfter: 10 });
  assert.equal(preview.partial, true);
  assert.equal(preview.report.preview, true);
  assert.equal(backend.calls.analyze, 2);
  assert.ok(Math.abs(preview.report.outputSeconds - 13) < 0.05);
  const finish = providers(f.voice, [], [{ ...cue, at: 1, until: 5 }]);
  const whole = await run(f, [], [], {
    providers: finish,
    keeper: { ...keeper, saved: { plan, words: [], records: [...kept.records] } },
  });
  assert.equal(finish.calls.analyze, 1, 'only the rest was looked at');
  assert.equal(whole.partial, false);
  assert.ok(!whole.report.preview);
  assert.equal(whole.report.descriptions.length, 3);
  assert.ok(Math.abs(whole.report.outputSeconds - 20) < 0.05);
});

test('part of a video is described from a working copy, and the big temporary files go early', async () => {
  const f = await fixture('range', 20);
  await mkdir(f.work, { recursive: true });
  const downloaded = join(f.work, 'source');
  await copyFile(f.file, downloaded);
  const transcribed = [];
  const backend = providers(f.voice, [], [{ ...cue, at: 1, until: 5 }]);
  backend.transcribe = async (_file, seconds) => {
    transcribed.push(seconds);
    return [];
  };
  const { keeper, kept } = keeperFor(undefined);
  const part = { start: 5, end: 12 };
  const result = await run(f, [], [], {
    providers: backend,
    keeper,
    source: downloaded,
    settings: { ...settings, mode: 'extended', range: part },
  });
  assert.deepEqual(result.report.range, part);
  assert.deepEqual(kept.plans[0].range, part);
  assert.ok(Math.abs(result.report.sourceSeconds - 7) < 0.1);
  assert.ok(Math.abs(transcribed[0] - 7) < 0.1);
  await assert.rejects(stat(downloaded), 'the download is removed once the working copy exists');
  assert.deepEqual(
    (await readdir(f.work)).filter((name) => name.endsWith('.mkv')),
    [],
    'the working copy is removed before the join when the picture was re-encoded',
  );
  await copyFile(f.file, downloaded);
  const other = await run(f, [], [], {
    providers: backend,
    keeper: { ...keeper, saved: { plan: kept.plans[0], words: [], records: [...kept.records] } },
    source: downloaded,
    settings: { ...settings, mode: 'extended', range: { start: 0, end: 7 } },
  });
  assert.equal(transcribed.length, 2, 'a plan for another part is not reused');
  assert.equal(backend.calls.analyze, 2, 'nor are its sections');
  assert.deepEqual(other.report.range, { start: 0, end: 7 });
});

test('the first look is skipped for videos of two minutes or less', async () => {
  const f = await fixture('short-first-look');
  const backend = providers(f.voice, [], [cue]);
  const analyze = backend.analyze;
  let surveys = 0;
  backend.analyze = async (look) => {
    if (look.brief.survey) surveys++;
    return analyze(look);
  };
  const result = await run(f, [], [], {
    providers: backend,
    settings: { ...settings, firstLook: true },
  });
  assert.equal(surveys, 0);
  assert.equal(result.report.descriptions.length, 1);
});

test('names the listener has not heard yet are replaced before anything is voiced', async () => {
  const f = await fixture('names');
  const said = [];
  const backend = providers(f.voice, [{ word: 'Pat.', start: 6, end: 6.4, speaker: 0 }], []);
  backend.analyze = async () => ({
    kind: 'other',
    setting: '',
    people: [{ label: 'the host', name: 'Pat', look: 'blue shirt' }],
    speakers: [],
    protectedSounds: [],
    cues: [{ ...cue, at: 1, until: 5, text: 'Pat waves at the camera.', shortText: 'Pat waves.' }],
  });
  const synthesize = backend.synthesize;
  backend.synthesize = async (text, ...rest) => {
    said.push(text);
    return synthesize(text, ...rest);
  };
  await run(f, [], [], { providers: backend });
  assert.ok(said.length > 0);
  assert.ok(
    said.every((text) => !/\bPat\b/.test(text)),
    said.join(' | '),
  );
  assert.ok(
    said.some((text) => /^The host waves/.test(text)),
    said.join(' | '),
  );
});

test('continuity records what was actually heard and what was left out', async () => {
  const f = await fixture('heard', 20);
  const { keeper, kept } = keeperFor(savedPlan(20, [10]), [{ word: 'Talk.', start: 4.2, end: 10 }]);
  const voice = measuredVoice();
  const backend = providers(f.voice, [], []);
  backend.synthesize = voice.synthesize;
  const shortText = 'The square moves.';
  const left =
    'A blue circle spins and bounces from one corner of the screen to the other, then back again.';
  backend.analyze = async (look) => ({
    kind: 'other',
    setting: 'A test pattern.',
    people: [],
    speakers: [],
    protectedSounds: [],
    cues:
      look.brief.position.index === 0
        ? [
            {
              at: 1,
              until: 4,
              text: 'A red square moves slowly and steadily across the whole of the room, from the left wall all the way to the right.',
              shortText,
              importance: 3,
            },
            { at: 1.5, until: 3.9, text: left, shortText: left, importance: 3 },
          ]
        : [],
  });
  await run(f, [], [], { providers: backend, keeper });
  const first = kept.records.find((record) => record.index === 0);
  assert.deepEqual(first.continuity.recent, [shortText]);
  assert.deepEqual(first.continuity.left, [left]);
});

test('a description left out at a section end is carried into the next section', async () => {
  const f = await fixture('carry', 20);
  const words = Array.from({ length: 12 }, (_, i) => ({
    word: 'talk',
    start: 4 + i * 0.5,
    end: 4.45 + i * 0.5,
  }));
  const { keeper, kept } = keeperFor(savedPlan(20, [10]), words);
  const result = await run(
    f,
    [],
    (look) => (look.brief.position.index === 0 ? [{ ...cue, at: 5, until: 12.5 }] : []),
    { keeper },
  );
  assert.equal(result.report.skipped.length, 0);
  assert.equal(result.report.descriptions.length, 1);
  assert.ok(Math.abs(result.report.descriptions[0].at - 10.1) < 0.01);
  const next = kept.records.find((record) => record.index === 1);
  assert.equal(next.placements[0].id, '0:0', 'it keeps its place in the script');
});

test('a still picture spanning several sections is looked at once', async () => {
  const f = await fixture('stills', 20);
  const { keeper } = keeperFor(savedPlan(20, [6.5, 13], { stills: [{ start: 0, end: 20 }] }));
  const backend = providers(f.voice, [], [{ ...cue, at: 1, until: 5 }]);
  const log = [];
  const result = await run(f, [], [], { providers: backend, keeper, log });
  assert.equal(backend.calls.analyze, 1);
  assert.equal(result.report.descriptions.length, 1);
  assert.ok(log.some((line) => /same still picture/.test(line)));
  const late = await fixture('stills-late', 20);
  const second = keeperFor(savedPlan(20, [6.5, 13], { stills: [{ start: 8, end: 20 }] }));
  const lateBackend = providers(late.voice, [], []);
  await run(late, [], [], { providers: lateBackend, keeper: second.keeper });
  assert.equal(
    lateBackend.calls.analyze,
    2,
    'a section that is mostly moving picture is still looked at',
  );
});

test('each look is told where it sits, the chapters, scene cuts, language and a note for it', async () => {
  const f = await fixture('brief', 20);
  const { keeper } = keeperFor(savedPlan(20, [10], { cuts: [2, 12.5], language: 'es' }));
  const seen = [];
  const backend = providers(f.voice, [], (look) =>
    look.brief.position.index === 1 ? [{ ...cue, at: 2, until: 6, pauseAt: 2 }] : [],
  );
  const analyze = backend.analyze;
  backend.analyze = async (look) => {
    seen.push(look);
    return analyze(look);
  };
  const log = [];
  const result = await run(f, [], [], {
    providers: backend,
    keeper,
    log,
    chapters: [
      { start: 0, title: 'Intro' },
      { start: 11, title: 'Ad' },
    ],
    sectionNotes: { 1: 'The man in the hat is Uncle Bob.' },
  });
  assert.deepEqual(seen[1].brief.position, { index: 1, count: 2, start: 10, end: 20, total: 20 });
  assert.deepEqual(seen[1].brief.chapters, [
    { start: 0, title: 'Intro' },
    { start: 11, title: 'Ad' },
  ]);
  assert.deepEqual(seen[0].brief.cuts, [2]);
  assert.deepEqual(seen[1].brief.cuts, [2.5]);
  assert.equal(seen[1].brief.language, 'es');
  assert.equal(seen[1].brief.sectionNote, 'The man in the hat is Uncle Bob.');
  assert.equal(seen[0].brief.sectionNote, undefined);
  assert.ok(seen[0].brief.secondsPerByte > 0);
  assert.equal(result.report.descriptions[0].at, 12.5, 'moved forward onto the scene cut');
  assert.ok(log.includes('Section 2 of 2 (0:10 to 0:20) started.'));
});

test('speech recognition gets key terms and reports the dialogue language', async () => {
  const f = await fixture('language');
  let hints;
  const backend = providers(f.voice, [], [cue]);
  backend.transcribe = async (_file, _seconds, _signal, _meter, given) => {
    hints = given;
    given.onLanguage('es');
    return [];
  };
  const { keeper, kept } = keeperFor(undefined);
  const result = await run(f, [], [], { providers: backend, keeper });
  assert.ok(Array.isArray(hints.keyterms));
  assert.equal(kept.plans[0].language, 'es');
  assert.equal(result.report.language, 'es');
});

test('close look keeps a usable window for descriptions in original seconds', async () => {
  const f = await fixture('close-window');
  const { keeper, kept } = keeperFor(undefined);
  await run(f, [], [{ ...cue, at: 8, until: 8, pauseAt: 8 }], {
    keeper,
    settings: { ...settings, closeLook: true },
  });
  const [look] = kept.looks;
  assert.equal(look.look.analysis.cues[0].at, 2);
  assert.equal(look.look.analysis.cues[0].until, 3.5);
});

test('a section still failing after its retry is kept as failed, marked as a passing error', async () => {
  const f = await fixture('retry-fails', 20);
  const { keeper, kept } = keeperFor(savedPlan(20, [6.5, 13]));
  const backend = providers(f.voice, [], [{ ...cue, at: 1, until: 5 }]);
  const analyze = backend.analyze;
  let tries = 0;
  backend.analyze = async (look) => {
    if (look.brief.position.index !== 1) return analyze(look);
    tries++;
    throw httpError(503);
  };
  const values = [];
  const result = await run(f, [], [], {
    providers: backend,
    keeper,
    progress: async (_stage, value) => {
      values.push(value);
    },
  });
  assert.ok(
    values.every((value, i) => i === 0 || value >= values[i - 1]),
    `progress never goes back: ${values.map((value) => Math.round(value)).join(', ')}`,
  );
  assert.equal(tries, 2);
  assert.equal(result.report.failedSections.length, 1);
  assert.equal(kept.records.find((record) => record.index === 1).failureClass, 'transient');
  assert.match(
    await readFile(result.files.transcript, 'utf8'),
    /Parts that could not be described/,
  );
});

test('three sections in a row failing stops the job without saving them as finished', async () => {
  const f = await fixture('three-down', 20);
  const { keeper, kept } = keeperFor(savedPlan(20, [6.5, 13]));
  const backend = providers(f.voice, [], []);
  backend.analyze = async () => {
    throw httpError(503);
  };
  await assert.rejects(
    run(f, [], [], { providers: backend, keeper }),
    /Three sections in a row could not be described/,
  );
  assert.equal(kept.records.length, 0, 'Continue will look at them again');
});

test('a section the tools cannot read fails at once with a plain reason, without a retry', async () => {
  const f = await fixture('unreadable', 20);
  const { keeper, kept } = keeperFor(savedPlan(20, [6.5, 13]));
  const backend = providers(f.voice, [], [{ ...cue, at: 1, until: 5 }]);
  const analyze = backend.analyze;
  let tries = 0;
  backend.analyze = async (look) => {
    if (look.brief.position.index !== 1) return analyze(look);
    tries++;
    throw new MediaError('This part of the video could not be read.', '/tmp/secret/section-1 log');
  };
  const result = await run(f, [], [], { providers: backend, keeper });
  assert.equal(tries, 1);
  assert.equal(result.report.failedSections[0].reason, 'This part of the video could not be read.');
  assert.equal(kept.records.find((record) => record.index === 1).failureClass, 'input');
});

test('an account problem with the video model stops the job at once', async () => {
  const f = await fixture('account', 20);
  const { keeper, kept } = keeperFor(savedPlan(20, [6.5, 13]));
  const backend = providers(f.voice, [], []);
  backend.analyze = async () => {
    throw httpError(402);
  };
  await assert.rejects(run(f, [], [], { providers: backend, keeper }));
  assert.equal(kept.records.length, 0);
});

test('saved looks are reused instead of paying again', async () => {
  const f = await fixture('saved-looks', 20);
  const analysis = {
    kind: 'other',
    setting: '',
    people: [],
    speakers: [],
    protectedSounds: [],
    cues: [{ ...cue, at: 1, until: 5 }],
  };
  const { keeper } = keeperFor(savedPlan(20, [10]), [], { looks: [{ analysis }] });
  const backend = providers(f.voice, [], [{ ...cue, at: 1, until: 5 }]);
  const result = await run(f, [], [], { providers: backend, keeper });
  assert.equal(backend.calls.analyze, 1);
  assert.equal(result.report.descriptions.length, 2);
});
