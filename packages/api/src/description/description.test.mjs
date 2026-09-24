import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, mkdir, rm, copyFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobePath from 'ffprobe-static';
import {
  fitCue,
  gaps,
  mergeIntervals,
  insertionPoint,
  outputTimeline,
  tempoFilters,
} from './timing.ts';
import { settingsSchema } from './types.ts';
import { describeVideo } from './engine.ts';
import { command, probe } from './media.ts';
import { youtubeURL } from './youtube.ts';

process.env.FFMPEG_PATH = ffmpegPath;
process.env.FFPROBE_PATH = ffprobePath.path;
const root = await mkdtemp(join(tmpdir(), 'described-video-test-'));
const signal = new AbortController().signal;
after(async () => {
  await rm(root, { recursive: true, force: true });
});
const settings = { voice: 'Voice 1', rate: 1.5, maxRate: 2.25, mode: 'standard' };
const cue = {
  at: 1,
  until: 5,
  text: 'A red square moves across the room.',
  shortText: 'The square moves.',
  importance: 3,
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
test('a measured clip accelerates only within the chosen maximum and after the visual event', () => {
  const placed = fitCue(cue, 4, settings, [{ start: 0, end: 3 }], 8);
  assert.ok(placed);
  assert.equal(placed.at, 3);
  assert.ok(placed.rate > 2 && placed.rate <= 2.25);
  assert.ok(placed.at + placed.duration < 5);
  assert.equal(fitCue(cue, 6, settings, [{ start: 0, end: 3 }], 8), null);
});
test('extended insertions shift later narration; same-time inserts do not overlap', () => {
  const base = {
    at: 2,
    outputAt: 2,
    duration: 1,
    rate: 1.5,
    text: 'One.',
    inserted: true,
    shortened: false,
  };
  const timeline = outputTimeline([
    base,
    { ...base, text: 'Two.' },
    { ...base, at: 5, inserted: false },
  ]);
  assert.equal(timeline[0].outputAt, 2);
  assert.equal(timeline[1].outputAt, 3.16);
  assert.equal(timeline[2].outputAt, 7.32);
  assert.equal(
    insertionPoint(
      2.1,
      [
        { start: 2, end: 2.3 },
        { start: 2.31, end: 2.6 },
      ],
      10,
    ),
    2.3,
  );
});
test('rate settings reject inverted limits and preserve pitch with chained time-stretch filters', () => {
  assert.equal(settingsSchema.safeParse({ ...settings, rate: 3, maxRate: 2 }).success, false);
  assert.equal(tempoFilters(3), 'atempo=2,atempo=1.500000');
  assert.throws(() => tempoFilters(NaN));
});

async function fixture(name, seconds = 9, audio = true) {
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
    args.push('-f', 'lavfi', '-i', `sine=frequency=220:sample_rate=48000:duration=${seconds}`);
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac');
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
      'sine=frequency=660:sample_rate=48000:duration=3',
      voice,
    ],
    signal,
  );
  return { dir, file, voice };
}
const meter = async (_kind, _reserve, action) => {
  await action();
};
const progress = async () => {};
function providers(voice, words, cues) {
  return {
    transcribe: async () => words,
    analyze: async () => ({ context: 'Synthetic test pattern.', protectedSounds: [], cues }),
    synthesize: async (_text, _voice, _session, file) => {
      await copyFile(voice, file);
    },
  };
}
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
test('actual MP4 and M4A render keeps runtime and original sound, with narration only in its gap', async () => {
  const f = await fixture('standard');
  const result = await describeVideo(
    f.file,
    f.dir,
    settings,
    'synthetic-test',
    signal,
    meter,
    progress,
    providers(
      f.voice,
      [
        { start: 0, end: 2, word: 'dialogue' },
        { start: 6, end: 8.8, word: 'dialogue' },
      ],
      [{ ...cue, at: 2, until: 6 }],
    ),
  );
  assert.ok((await stat(result.video)).size > 1000);
  assert.ok((await stat(result.audio)).size > 1000);
  assert.ok(Math.abs(result.report.outputSeconds - 9) < 0.15);
  assert.equal(result.report.descriptions.length, 1);
  assert.equal(result.report.skipped.length, 0);
  assert.ok((await amplitude(result.audio, 0.5, 220)) > 0.02);
  assert.ok((await amplitude(result.audio, 0.5, 660)) < 0.002);
  assert.ok((await amplitude(result.audio, 3, 660)) > 0.015);
  assert.ok((await amplitude(result.audio, 3, 220)) > 0.005);
  assert.ok((await amplitude(result.audio, 7, 660)) < 0.002);
});
test('extended mode inserts narration and pauses the original audio without dropping later source material', async () => {
  const f = await fixture('extended');
  const words = Array.from({ length: 90 }, (_, i) => ({
    start: i / 10,
    end: (i + 1) / 10,
    word: 'speech',
  }));
  const result = await describeVideo(
    f.file,
    f.dir,
    { ...settings, mode: 'extended' },
    'synthetic-test',
    signal,
    meter,
    progress,
    providers(f.voice, words, [{ ...cue, at: 2, until: 3 }]),
  );
  const placed = result.report.descriptions[0];
  assert.ok(placed.inserted);
  assert.ok(result.report.outputSeconds > 10.8);
  assert.ok(Math.abs(result.report.outputSeconds - (9 + placed.duration + 0.16)) < 0.15);
  assert.ok((await amplitude(result.audio, placed.outputAt + 0.5, 660)) > 0.015);
  assert.ok((await amplitude(result.audio, placed.outputAt + 0.5, 220)) < 0.003);
  assert.ok((await amplitude(result.audio, result.report.outputSeconds - 0.7, 220)) > 0.02);
});
test('standard mode reports an omitted cue instead of silently talking over dialogue', async () => {
  const f = await fixture('omitted');
  const result = await describeVideo(
    f.file,
    f.dir,
    settings,
    'synthetic-test',
    signal,
    meter,
    progress,
    providers(f.voice, [{ start: 0, end: 9, word: 'speech' }], [cue]),
  );
  assert.equal(result.report.descriptions.length, 0);
  assert.equal(result.report.skipped.length, 1);
  assert.ok(Math.abs((await probe(result.video, signal)).seconds - 9) < 0.15);
});

test('several extended pauses stay aligned with narration throughout a section', async () => {
  const f = await fixture('many-pauses', 20);
  const words = Array.from({ length: 200 }, (_, i) => ({
    start: i / 10,
    end: (i + 1) / 10,
    word: 'speech',
  }));
  const cues = Array.from({ length: 10 }, (_, i) => ({
    ...cue,
    at: 1.17 + i * 1.71,
    until: 1.8 + i * 1.71,
    text: `Description ${i}.`,
    shortText: `Cue ${i}.`,
  }));
  const result = await describeVideo(
    f.file,
    f.dir,
    { ...settings, mode: 'extended' },
    'synthetic-test',
    signal,
    meter,
    progress,
    providers(f.voice, words, cues),
  );
  assert.equal(result.report.descriptions.length, 10);
  for (const placed of result.report.descriptions) {
    assert.ok(placed.inserted);
    assert.ok(
      (await amplitude(result.audio, placed.outputAt + 0.15, 220)) < 0.003,
      `Original audio intrudes into pause at ${placed.outputAt}`,
    );
    assert.ok((await amplitude(result.audio, placed.outputAt + 0.5, 660)) > 0.015);
  }
});
test('silent video renders with narration and no source audio stream', async () => {
  const f = await fixture('silent', 9, false);
  const result = await describeVideo(
    f.file,
    f.dir,
    settings,
    'synthetic-test',
    signal,
    meter,
    progress,
    providers(f.voice, [], [cue]),
  );
  assert.equal((await probe(result.video, signal)).audio, true);
  assert.equal(result.report.descriptions.length, 1);
});
test('multiple sections preserve continuity and offset the exported description timeline', async () => {
  const f = await fixture('sections', 94);
  const seen = [];
  const backend = providers(f.voice, [], [cue]);
  backend.analyze = async (_file, seconds, context) => {
    seen.push({ seconds, context });
    return {
      context: 'The same character.',
      protectedSounds: [],
      cues: [{ ...cue, at: 1, until: Math.min(seconds, 5) }],
    };
  };
  const result = await describeVideo(
    f.file,
    f.dir,
    settings,
    'synthetic-test',
    signal,
    meter,
    progress,
    backend,
  );
  assert.equal(seen.length, 2);
  assert.equal(seen[1].context, 'The same character.');
  assert.ok(result.report.descriptions[1].at >= 91);
  assert.ok(result.report.descriptions[1].outputAt >= 91);
  assert.ok(Math.abs(result.report.outputSeconds - 94) < 0.2);
});
