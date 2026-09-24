import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, mkdir, rm, copyFile, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobePath from 'ffprobe-static';
import {
  fitCue,
  gaps,
  pauseCue,
  pausePoint,
  toOutput,
  planSections,
  tempoFilters,
  mergeIntervals,
  outputTimeline,
} from './timing.ts';
import { duckCurve, level, loudness, pauseProgram, sampleRate, trimSilence } from './mix.ts';
import { describeVideo, levelsFor, alignSections } from './engine.ts';
import { readAnalysis, nextContinuity } from './prompt.ts';
import { command, probe, frameRate } from './media.ts';
import { transcriptText, clock } from './transcript.ts';
import { settingsSchema } from './types.ts';
import { youtubeURL } from './youtube.ts';

process.env.FFMPEG_PATH = ffmpegPath;
process.env.FFPROBE_PATH = ffprobePath.path;
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
  const curve = duckCurve(sampleRate * 4, [{ start: 1, end: 2 }], 0.4);
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
  assert.ok(Math.abs(point - 1.04) < 0.001, `paused at ${point}`);
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
  assert.ok(Math.abs(partial.pause - (3 - 1.4 + 0.16)) < 1e-9);
  const full = pauseCue(cue, cue.text, 3, extended, 2, [{ start: 2.1, end: 6 }]);
  assert.equal(full.pauseAt, 2);
  assert.ok(Math.abs(full.pause - 3.16) < 1e-9);
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

test('sections break in quiet moments near every 90 seconds and snap to whole frames', () => {
  const words = [];
  for (let t = 0; t < 300; t += 0.5)
    if (Math.abs(t - 88) > 1.5 && Math.abs(t - 181) > 2)
      words.push({ start: t, end: t + 0.45, word: 'x' });
  const sections = planSections(300, words);
  assert.ok(Math.abs(sections[0].end - 88) < 1.6, `first break at ${sections[0].end}`);
  assert.ok(Math.abs(sections[1].end - 181) < 2.1, `second break at ${sections[1].end}`);
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
    source: f.file,
    directory: f.work,
    title: 'Test pattern',
    about: '',
    settings: overrides.settings || settings,
    session: 'synthetic-test',
    signal,
    meter,
    progress,
    providers: backend,
    keeper: overrides.keeper,
  });
  return { ...result, backend };
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

test('long videos: continuity, a failed section that does not sink the job, resume, and re-voicing', async () => {
  const f = await fixture('sections', 250);
  const seen = [];
  const backend = providers(f.voice, [], []);
  backend.analyze = async (look) => {
    seen.push(look);
    if (seen.length === 2) throw new SyntaxError('The visual description came back incomplete.');
    return {
      kind: 'other',
      setting: 'A test pattern.',
      people: [{ label: 'the square', name: '', look: 'red' }],
      speakers: [],
      protectedSounds: [],
      cues: [{ ...cue, at: 1, until: 5 }],
    };
  };
  const kept = { plan: undefined, words: undefined, records: [], files: new Map() };
  const keeper = {
    saved: { records: [] },
    keepPlan: async (plan, words) => {
      kept.plan = plan;
      kept.words = words;
    },
    keepSection: async (record, files) => {
      kept.records.push(record);
      kept.files.set(record.index, files);
    },
    restore: async (index) => kept.files.get(index),
  };
  const first = await run(f, [], [], { providers: backend, keeper });
  assert.equal(seen.length, 3);
  assert.equal(seen[1].state.people[0].label, 'the square');
  assert.equal(first.report.failedSections.length, 1);
  assert.equal(first.report.descriptions.length, 2);
  assert.ok(first.report.descriptions[1].at >= first.report.descriptions[0].at + 60);
  assert.ok(Math.abs(first.report.outputSeconds - 250) < 0.1);
  assert.match(await readFile(first.files.transcript, 'utf8'), /Parts that could not be described/);

  const resumed = providers(f.voice, [], [{ ...cue, at: 1, until: 5 }]);
  const again = await run(f, [], [], {
    providers: resumed,
    keeper: {
      ...keeper,
      saved: { plan: kept.plan, words: kept.words, records: kept.records.slice(0, 2) },
    },
  });
  assert.equal(resumed.calls.analyze, 1, 'only the unfinished section is watched again');
  assert.equal(again.report.descriptions.length, 2);
  assert.ok(Math.abs(again.report.outputSeconds - first.report.outputSeconds) < 0.05);

  const revoiced = providers(f.voice, [], []);
  const voiced = await run(f, [], [], {
    providers: revoiced,
    settings: { ...settings, rate: 2, maxRate: 3 },
    keeper: {
      ...keeper,
      saved: {
        plan: kept.plan,
        words: kept.words,
        records: [],
        analyses: kept.records.map((record) => record.analysis),
      },
    },
  });
  assert.equal(revoiced.calls.analyze, 0, 're-voicing reuses the saved descriptions');
  assert.equal(voiced.report.descriptions.length, 2);
  assert.ok(voiced.report.descriptions.every((item) => item.rate >= 2));
});

test('a description the voice service drops is reported, not fatal', async () => {
  const f = await fixture('voice-failure');
  const backend = providers(f.voice, [], [cue, { ...cue, at: 5, until: 8, text: 'Second.' }]);
  let calls = 0;
  backend.synthesize = async (_text, _voice, _session, file) => {
    if (++calls === 1) throw new Error('The selected voice did not return playable audio.');
    await copyFile(f.voice, file);
  };
  const result = await run(f, [], [], { providers: backend });
  assert.equal(result.report.descriptions.length, 1);
  assert.equal(result.report.skipped.length, 1);
  assert.match(result.report.skipped[0].reason, /voice service/);
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
