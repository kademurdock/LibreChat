/**
 * Synthetic media matrix: small generated files for the kinds of source in Kade's archive (VHS and
 * DVD captures, over-the-air TS, Xvid AVIs, old FLVs, phone HDR, multi-track rips) checked through
 * the real media functions. Every sync fixture has a white flash and a 2 kHz burst at the same
 * picture time. Probing uses ffprobe-static 4.0.2 while ffmpeg-static is 6.1.1; production runs a
 * matched pair.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, readFile, stat, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobePath from 'ffprobe-static';
import * as media from './media.ts';

process.env.FFMPEG_PATH = ffmpegPath;
process.env.FFPROBE_PATH = ffprobePath.path;
const signal = new AbortController().signal;
/** Everything the media module logs during this run, whichever test triggers it. */
const logged = [];
const log = (line) => logged.push(line);
const root = await mkdtemp(join(tmpdir(), 'kade-media-'));
after(() => rm(root, { recursive: true, force: true }));

const events = [1.5, 6.5];
const on = (shift = 0) =>
  events.map((t) => `between(t,${(t - shift).toFixed(3)},${(t - shift + 0.2).toFixed(3)})`).join('+');
const picture = (size, rate, seconds, shift = 0) =>
  `testsrc2=s=${size}:r=${rate}:d=${seconds},drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='${on(shift)}'`;
const sound = (seconds, shift = 0, bed = 220, right = true) => {
  const channel = `0.1*sin(2*PI*${bed}*t)+0.5*sin(2*PI*2000*t)*(${on(shift)})`;
  return `aevalsrc='${channel}|${right ? channel : '0'}':s=48000:d=${seconds}`;
};
const lavfi = (graph) => ['-f', 'lavfi', '-i', graph];
const h264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '30'];

const made = new Map();
/** Generates a fixture once per run, so tests can share it in any order. */
function make(name, args) {
  if (!made.has(name))
    made.set(
      name,
      media
        .command(ffmpegPath, ['-nostdin', '-v', 'error', '-y', ...args, join(root, name)], signal)
        .then(() => join(root, name)),
    );
  return made.get(name);
}
/**
 * Picture and sound made separately, each with its events moved earlier by its own delay, then
 * joined with that delay, so the events line up in the joined file's timeline.
 */
async function joined(name, { seconds = 10, videoDelay = 0, audioDelay = 0, soundFilter = [], codecs }) {
  const video = await make(`${name}.video.mkv`, [
    ...lavfi(picture('320x240', 30, seconds - videoDelay, videoDelay)),
    '-c:v',
    'ffv1',
  ]);
  const audio = await make(`${name}.audio.mka`, [
    ...lavfi(sound(seconds - audioDelay, audioDelay)),
    ...soundFilter,
    '-c:a',
    'pcm_s16le',
  ]);
  const delay = (value) => (value ? ['-itsoffset', String(value)] : []);
  return make(name, [
    ...delay(videoDelay),
    '-i',
    video,
    ...delay(audioDelay),
    '-i',
    audio,
    '-map',
    '0:v',
    '-map',
    '1:a',
    ...codecs,
  ]);
}
const xvidFixture = () =>
  make('xvid.avi', [
    ...lavfi(picture('320x240', 30, 4)),
    ...lavfi(sound(4)),
    ...['-c:v', 'mpeg4', '-vtag', 'XVID', '-bf', '2', '-q:v', '4', '-g', '300', '-c:a', 'libmp3lame'],
  ]);
const lateTs = () => joined('late.ts', { audioDelay: 0.8, codecs: [...h264, '-c:a', 'aac', '-f', 'mpegts'] });
/**
 * An over-the-air style TS in three 4 s parts joined by stream copy: 5.1 AC-3 at 720x480, then
 * stereo AC-3 at 44.1 kHz and 1280x720, then 5.1 again. Each part has a burst 1 s in; the first
 * part turns blue from 2 s to 3 s, so it has scene cuts before any switch.
 */
async function switching() {
  const parts = [
    { size: '720x480', layout: '5.1', rate: 48000, blue: true },
    { size: '1280x720', layout: 'stereo', rate: 44100 },
    { size: '720x480', layout: '5.1', rate: 48000 },
  ];
  const files = [];
  for (const [i, part] of parts.entries()) {
    const blue = part.blue ? ",drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='between(t,2,3)'" : '';
    files.push(
      await make(`switch-${i}.ts`, [
        ...lavfi(`testsrc2=s=${part.size}:r=30:d=4${blue}`),
        ...lavfi(`aevalsrc='0.1*sin(2*PI*220*t)+0.5*sin(2*PI*2000*t)*between(t,1,1.2)':c=${part.layout}:s=${part.rate}:d=4`),
        ...['-c:v', 'mpeg2video', '-b:v', '3M', '-g', '15', '-c:a', 'ac3', '-f', 'mpegts'],
      ]),
    );
  }
  const list = join(root, 'switch.txt');
  await writeFile(list, files.map((file) => `file '${file.replace(/\\/g, '/')}'`).join('\n'));
  return make('switch.ts', ['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-f', 'mpegts']);
}
async function distinctFrames(file, count) {
  const out = await media.command(
    ffmpegPath,
    ['-nostdin', '-v', 'error', '-i', file, '-map', '0:v:0', '-frames:v', String(count), '-f', 'framemd5', '-'],
    signal,
  );
  const lines = out.toString().split('\n').filter((line) => line && !line.startsWith('#'));
  return new Set(lines.map((line) => line.split(',').pop().trim())).size;
}
/**
 * Comb energy of the luma: how much each line differs from the average of its neighbours, against
 * how much the neighbours differ. Woven fields of moving video score about 2; progressive about 0.8.
 */
async function combing(file) {
  const { width, height } = await geometry(file);
  const count = 10;
  const raw = await media.command(
    ffmpegPath,
    ['-nostdin', '-v', 'error', '-i', file, '-map', '0:v:0', '-vf', 'extractplanes=y', '-frames:v', String(count), '-f', 'rawvideo', 'pipe:1'],
    signal,
    undefined,
    64 * 1024 ** 2,
  );
  let across = 0;
  let between = 0;
  for (let frame = 2; frame < count; frame++)
    for (let row = 1; row < height - 1; row++)
      for (let column = 0; column < width; column++) {
        const i = (frame * height + row) * width + column;
        across += Math.abs(2 * raw[i] - raw[i - width] - raw[i + width]);
        between += Math.abs(raw[i + width] - raw[i - width]);
      }
  return across / between;
}
async function folder(name) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  return dir;
}
async function probeJson(file, entries, extra = []) {
  const raw = await media.command(
    ffprobePath.path,
    ['-v', 'error', ...extra, '-show_entries', entries, '-of', 'json', file],
    signal,
  );
  return JSON.parse(raw.toString());
}
const floats = (buffer) =>
  new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
/** Samples as a speech service would read them: one plain run, container offsets ignored. */
const plainPcm = async (file) =>
  floats(
    await media.command(
      ffmpegPath,
      ['-nostdin', '-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'],
      signal,
      undefined,
      256 * 1024 ** 2,
    ),
  );
/** Samples placed by their timestamps, as a player would; `raw` keeps the container's own clock. */
const timedPcm = async (file, raw = false) =>
  floats(
    await media.command(
      ffmpegPath,
      [
        '-nostdin',
        '-v',
        'error',
        ...(raw ? ['-copyts'] : []),
        '-i',
        file,
        '-map',
        '0:a:0',
        '-af',
        'aresample=48000:async=1:first_pts=0',
        '-ac',
        '1',
        '-f',
        'f32le',
        'pipe:1',
      ],
      signal,
      undefined,
      256 * 1024 ** 2,
    ),
  );
function level(x, from, n, frequency) {
  let re = 0;
  let im = 0;
  for (let i = 0; i < n && from + i < x.length; i++) {
    const phase = (2 * Math.PI * frequency * i) / 48000;
    re += x[from + i] * Math.cos(phase);
    im += x[from + i] * Math.sin(phase);
  }
  return (2 * Math.hypot(re, im)) / n;
}
function bursts(x, frequency = 2000, threshold = 0.12) {
  const found = [];
  let previous = false;
  for (let i = 0; i + 240 <= x.length; i += 48) {
    const hit = level(x, i, 240, frequency) > threshold;
    if (hit && !previous) found.push(i / 48000);
    previous = hit;
  }
  return found;
}
const bedAt = (x, at, frequency = 220) => level(x, Math.round(at * 48000), 4800, frequency);
const mono = (stereo) => {
  const out = new Float32Array(stereo.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = (stereo[2 * i] + stereo[2 * i + 1]) / 2;
  return out;
};
async function frames(file, raw = false) {
  const { log } = await media.execute(
    ffmpegPath,
    ['-nostdin', '-hide_banner', '-v', 'info', ...(raw ? ['-copyts'] : []), '-i', file, '-map', '0:v:0', '-vf', 'scale=16:16,format=gray,showinfo', '-f', 'null', '-'],
    signal,
    undefined,
    1024 ** 2,
    { logBytes: 8 * 1024 ** 2 },
  );
  return [...log.matchAll(/pts_time:\s*([-\d.e]+).*?mean:\[(\d+)/g)].map((m) => ({
    time: Number(m[1]),
    luma: Number(m[2]),
  }));
}
const flashes = (list) =>
  list.filter((f, i) => f.luma > 200 && (i === 0 || list[i - 1].luma <= 200)).map((f) => f.time);
const near = (actual, expected, tolerance, label) =>
  assert.ok(
    actual.length === expected.length && actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance),
    `${label}: got ${JSON.stringify(actual.map((v) => +v.toFixed(3)))}, expected ${JSON.stringify(expected)}`,
  );

/**
 * Where a player presents each flash and burst, measured from the first picture: the ground truth
 * every read must reproduce, whatever the container's offsets.
 */
async function presented(file, info) {
  return {
    flashes: flashes(await frames(file, true)).map((t) => t - info.videoStart),
    bursts: bursts(await timedPcm(file, true)).map((t) => t - info.videoStart),
  };
}

async function geometry(file) {
  const data = await probeJson(
    file,
    'stream=codec_type,width,height,sample_aspect_ratio,pix_fmt,profile,color_transfer',
  );
  return data.streams.find((s) => s.codec_type === 'video');
}

test('sound and picture share the picture clock in every container, from any start', async () => {
  const late = (name, codecs) => joined(name, { audioDelay: 0.8, codecs });
  const fixtures = {
    'late.mp4': await late('late.mp4', [...h264, '-c:a', 'aac']),
    'late.mkv': await late('late.mkv', [...h264, '-c:a', 'aac']),
    'late.ts': await lateTs(),
    'late.mpg': await late('late.mpg', ['-c:v', 'mpeg2video', '-b:v', '2M', '-c:a', 'mp2', '-f', 'vob']),
    'early.ts': await joined('early.ts', {
      videoDelay: 0.5,
      codecs: ['-c:v', 'mpeg2video', '-b:v', '2M', '-c:a', 'ac3', '-f', 'mpegts'],
    }),
    'hole.mkv': await joined('hole.mkv', {
      soundFilter: ['-af', "aselect='not(between(t,3,4))'"],
      codecs: [...h264, '-c:a', 'flac'],
    }),
  };
  for (const [name, file] of Object.entries(fixtures)) {
    const info = await media.probe(file, signal);
    const truth = await presented(file, info);
    assert.deepEqual(truth.flashes.map((t) => Math.round(t * 10) / 10), truth.bursts.map((t) => Math.round(t * 10) / 10), `${name} fixture is in sync`);
    for (const start of [0, 5]) {
      const expected = truth.flashes.filter((t) => t >= start && t < start + 4).map((t) => t - start);
      const heard = truth.bursts.filter((t) => t >= start && t < start + 4).map((t) => t - start);
      const dir = await folder(`sync-${name}-${start}`);
      const count = Math.round((4 * info.fps.num) / info.fps.den);
      const part = await media.sectionPicture(file, dir, 0, start, count, info.fps, [], signal, info);
      near(flashes(await frames(part)), expected, 0.05, `${name} picture at ${start}`);
      const pcm = await media.sectionSound(file, dir, start, 4 * 48000, true, signal, info);
      near(bursts(mono(pcm)), heard, 0.03, `${name} sound at ${start}`);
      const clip = await media.sectionClip(file, dir, start, 4, signal, false, info);
      near(bursts(await plainPcm(clip)), heard, 0.03, `${name} analysis sound at ${start}`);
      near(flashes(await frames(clip)), expected, 0.15, `${name} analysis picture at ${start}`);
    }
    const dir = await folder(`sync-${name}-whole`);
    const whole = await media.soundtrack(file, dir, signal, info);
    near(bursts(await plainPcm(whole.dialogue)), truth.bursts, 0.03, `${name} dialogue copy`);
  }
  const dir = await folder('sync-legacy');
  const pcm = await media.sectionSound(fixtures['late.ts'], dir, 5, 4 * 48000, true, signal);
  near(bursts(mono(pcm)), [1.5], 0.03, 'a read without media finds the clock itself');
});

test('AVI and FLV openings keep their first second of picture and sound', async () => {
  const D = 4;
  const base = [...lavfi(picture('320x240', 30, D)), ...lavfi(sound(D))];
  const files = {
    'xvid.avi': await xvidFixture(),
    'h264.avi': await make('h264.avi', [...base, '-c:v', 'libx264', '-preset', 'fast', '-bf', '3', '-pix_fmt', 'yuv420p', '-c:a', 'libmp3lame']),
    'old.flv': await make('old.flv', [...base, '-c:v', 'flv', '-b:v', '800k', '-c:a', 'libmp3lame', '-ar', '44100']),
  };
  for (const [name, file] of Object.entries(files)) {
    const info = await media.probe(file, signal);
    const dir = await folder(`opening-${name}`);
    const count = Math.round((3 * info.fps.num) / info.fps.den);
    const truth = await presented(file, info);
    const list = await frames(await media.sectionPicture(file, dir, 0, 0, count, info.fps, [], signal, info));
    near(flashes(list), truth.flashes.filter((t) => t < 3), 0.05, `${name} flash`);
    assert.ok((await distinctFrames(join(dir, 'part-0.mp4'), 30)) > 25, `${name} opening is not frozen`);
    const pcm = mono(await media.sectionSound(file, dir, 0, 3 * 48000, true, signal, info));
    assert.ok(bedAt(pcm, 0.2) > 0.05, `${name} has sound in its first second`);
  }
});

test('normalize makes a working copy, and cuts a part accurately when asked', async () => {
  const dir = await folder('normalize');
  const xvid = await xvidFixture();
  const working = await media.normalize(xvid, dir, signal);
  assert.match(working.file, /working\.mkv$/);
  assert.match(working.media.format, /matroska/);
  const count = Math.round((3 * working.media.fps.num) / working.media.fps.den);
  const part = await media.sectionPicture(working.file, dir, 0, 0, count, working.media.fps, [], signal, working.media);
  near(flashes(await frames(part)), [1.5], 0.05, 'remuxed Xvid flash');

  const sparse = await joined('sparse.ts', {
    audioDelay: 0.8,
    codecs: ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mpegts'],
  });
  const sparseDir = await folder('normalize-sparse');
  const remuxed = await media.normalize(sparse, sparseDir, signal);
  const later = await media.sectionPicture(remuxed.file, sparseDir, 0, 5, 120, remuxed.media.fps, [], signal, remuxed.media);
  near(flashes(await frames(later)), [1.5], 0.05, 'a TS with one keyframe, read mid-file after the remux');
  const laterSound = await media.sectionSound(remuxed.file, sparseDir, 5, 4 * 48000, true, signal, remuxed.media);
  near(bursts(mono(laterSound)), [1.5], 0.03, 'its sound');

  const partDir = await folder('normalize-range');
  const ts = await lateTs();
  const cut = await media.normalize(ts, partDir, signal, { start: 5, end: 9 });
  assert.ok(Math.abs(cut.media.seconds - 4) < 0.1, `part length ${cut.media.seconds}`);
  assert.equal(media.copyable(cut.media), true);
  assert.equal(cut.media.videoStart, 0);
  const pcm = await media.sectionSound(cut.file, partDir, 0, 4 * 48000, true, signal, cut.media);
  near(bursts(mono(pcm)), [1.5], 0.03, 'cut sound');
  const cutCount = Math.round((4 * cut.media.fps.num) / cut.media.fps.den);
  const cutPart = await media.sectionPicture(cut.file, partDir, 0, 0, cutCount, cut.media.fps, [], signal, cut.media);
  near(flashes(await frames(cutPart)), [1.5], 0.05, 'cut picture');

  const landscape = await make('landscape.mp4', [...lavfi(picture('320x240', 30, 2)), ...lavfi(sound(2)), ...h264, '-c:a', 'aac']);
  const rotated = join(root, 'rotated.mp4');
  await media.command(ffmpegPath, ['-nostdin', '-v', 'error', '-y', '-display_rotation', '90', '-i', landscape, '-c', 'copy', rotated], signal);
  const phoneDir = await folder('normalize-rotated');
  const phone = await media.normalize(rotated, phoneDir, signal);
  assert.match(phone.file, /working\.mp4$/, 'rotated video keeps its rotation in an MP4 working copy');
  const upright = await media.sectionPicture(phone.file, phoneDir, 0, 0, 30, phone.media.fps, [], signal, phone.media);
  const shape = await geometry(upright);
  assert.deepEqual([shape.width, shape.height], [240, 320]);

  await assert.rejects(
    media.normalize(ts, await folder('normalize-outside'), signal, { start: 20, end: 30 }),
    (error) => error instanceof media.MediaError && error.message === 'The part to describe is outside the video.',
  );

  const lpcm = await make('lpcm.vob', [...lavfi(picture('320x240', 30, 3)), ...lavfi(sound(3)), '-c:v', 'mpeg2video', '-c:a', 'pcm_dvd', '-f', 'vob']);
  const dvdDir = await folder('normalize-lpcm');
  const dvd = await media.normalize(lpcm, dvdDir, signal, undefined, log);
  assert.match(dvd.file, /working\.mkv$/, 'DVD LPCM sound, which MKV cannot hold, is converted to FLAC');
  const dvdSound = mono(await media.sectionSound(dvd.file, dvdDir, 0, 2 * 48000, true, signal, dvd.media));
  near(bursts(dvdSound), [1.5], 0.03, 'DVD sound after conversion');
  assert.equal(logged.some((line) => /original file/.test(line)), false);

  const silent = await make('silent.mp4', [...lavfi(picture('320x240', 30, 2)), ...h264]);
  const quiet = await media.normalize(silent, await folder('normalize-silent'), signal);
  assert.equal(quiet.media.audio, false);
  assert.equal(quiet.media.audioIndex, null);
});

test('a picture size or sound format change mid-file keeps every read on the picture clock', async () => {
  const file = await switching();
  const dir = await folder('switching');
  const working = await media.normalize(file, dir, signal);
  assert.ok(Math.abs(working.media.seconds - 12) < 0.1, `length ${working.media.seconds}`);
  const whole = await media.soundtrack(working.file, dir, signal, working.media);
  const dialogue = await plainPcm(whole.dialogue);
  const heard = dialogue.length / 48000;
  assert.ok(Math.abs(heard - working.media.seconds) < 0.1, `dialogue copy is ${heard} s`);
  near(bursts(dialogue), [1, 5, 9], 0.05, 'dialogue copy across the switches');
  assert.ok(whole.momentary[0].lufs > -70, `first momentary block ${whole.momentary[0].lufs}`);
  assert.ok(whole.cuts.some((t) => Math.abs(t - 2) < 0.1), `cut before the first switch: ${whole.cuts}`);
  const pcm = mono(await media.sectionSound(working.file, dir, 2, 8 * 48000, true, signal, working.media));
  near(bursts(pcm), [3, 7], 0.03, 'section sound across the switches');
  const clip = await plainPcm(await media.sectionClip(working.file, dir, 2, 8, signal, false, working.media));
  assert.ok(Math.abs(clip.length / 48000 - 8) < 0.1, `analysis clip sound is ${clip.length / 48000} s`);
  near(bursts(clip), [3, 7], 0.05, 'analysis clip sound');
});

test('odd, anamorphic, interlaced, 4:2:2 and HDR sources become square 8-bit pictures', async () => {
  const tools = await media.capabilities();
  const sources = [
    {
      name: 'vhs43.mpg',
      args: [...lavfi('testsrc2=s=720x480:r=60000/1001:d=2'), '-vf', 'tinterlace=mode=interleave_top,setsar=8/9', '-c:v', 'mpeg2video', '-b:v', '6M', '-flags', '+ilme+ildct', '-top', '1', '-f', 'vob'],
      dar: 4 / 3,
      interlaced: true,
    },
    {
      name: 'dvd169.mpg',
      args: [...lavfi('testsrc2=s=720x480:r=30000/1001:d=1'), '-vf', 'setsar=32/27', '-c:v', 'mpeg2video', '-b:v', '6M', '-f', 'vob'],
      dar: 16 / 9,
    },
    {
      name: 'pal.mpg',
      args: [...lavfi('testsrc2=s=720x576:r=25:d=1'), '-vf', 'setsar=64/45', '-c:v', 'mpeg2video', '-b:v', '6M', '-f', 'vob'],
      dar: 16 / 9,
    },
    {
      name: 'capture.avi',
      args: [...lavfi('testsrc2=s=720x480:r=60000/1001:d=2'), '-vf', 'tinterlace=mode=interleave_top,setsar=8/9', '-c:v', 'mjpeg', '-pix_fmt', 'yuvj422p', '-q:v', '3'],
      dar: 4 / 3,
      interlaced: true,
    },
    {
      name: 'odd.mkv',
      args: [...lavfi('testsrc2=s=853x481:r=30:d=1'), '-c:v', 'ffv1', '-pix_fmt', 'yuv420p'],
      dar: 853 / 481,
    },
    {
      name: 'mjpeg422.avi',
      args: [...lavfi('mandelbrot=s=640x480:r=30'), '-t', '1', '-c:v', 'mjpeg', '-pix_fmt', 'yuvj422p', '-q:v', '3'],
      dar: 4 / 3,
    },
    {
      name: 'hdr.mov',
      args: [...lavfi('testsrc2=s=640x360:r=30:d=1'), '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', '-tag:v', 'hvc1', '-x265-params', 'log-level=error'],
      dar: 16 / 9,
      hdr: true,
    },
  ];
  for (const source of sources) {
    const file = await make(source.name, source.args);
    const info = await media.probe(file, signal);
    assert.equal(info.interlaced, !!source.interlaced, `${source.name} interlace`);
    assert.equal(info.hdr, !!source.hdr, `${source.name} HDR`);
    const dir = await folder(`shape-${source.name}`);
    const clip = await geometry(await media.sectionClip(file, dir, 0, 1, signal, false, info));
    const part = await geometry(await media.sectionPicture(file, dir, 0, 0, 20, info.fps, [], signal, info));
    for (const [label, out] of [['clip', clip], ['picture', part]]) {
      assert.equal(out.width % 2, 0, `${source.name} ${label} even width`);
      assert.equal(out.height % 2, 0, `${source.name} ${label} even height`);
      assert.equal(out.pix_fmt, 'yuv420p', `${source.name} ${label} 8-bit 4:2:0`);
      assert.ok(Math.abs(out.width / out.height / source.dar - 1) < 0.01, `${source.name} ${label} shape ${out.width}x${out.height}`);
      if (source.hdr && tools.zscale) assert.equal(out.color_transfer, 'bt709', `${source.name} ${label} tone-mapped`);
    }
    assert.equal(clip.profile, 'High', `${source.name} analysis profile`);
    if (!source.interlaced) continue;
    assert.equal(info.parity, 'tff');
    assert.ok((await combing(file)) > 1.8, `${source.name} is combed`);
    const after = await combing(join(dir, 'part-0.mp4'));
    assert.ok(after < 1.2, `${source.name} deinterlaced (comb ${after.toFixed(2)})`);
  }
});

test('the free check refuses what cannot be described, in plain words', async () => {
  const cover = await make('cover.png', [...lavfi('color=c=red:s=64x64'), '-frames:v', '1']);
  const song = await make('song.wav', [...lavfi('sine=f=440:d=2')]);
  const art = await make('art.m4a', ['-i', song, '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'aac', '-c:v', 'png', '-disposition:v:0', 'attached_pic']);
  const script = join(root, 'source');
  await writeFile(script, `ffconcat version 1.0\nfile ${join(root, 'late.mp4').replace(/\\/g, '/')}\n`);
  const whole = await make('whole.mp4', [...lavfi(picture('320x240', 30, 4)), ...lavfi(sound(4)), ...h264, '-c:a', 'aac']);
  const broken = join(root, 'broken.mp4');
  await writeFile(broken, await readFile(whole));
  await truncate(broken, Math.floor((await stat(broken)).size / 2));
  const text = join(root, 'notes.mp4');
  await writeFile(text, 'These are my notes, not a video.\n');
  const blink = await make('blink.mp4', [...lavfi('testsrc2=s=160x120:r=30:d=0.1'), ...h264]);
  const cases = [
    [art, 'cover-art'],
    [song, 'no-video'],
    [script, 'format'],
    [broken, 'damaged'],
    [text, 'damaged'],
    [blink, 'too-short'],
  ];
  for (const [file, kind] of cases) {
    await assert.rejects(media.probe(file, signal), (error) => {
      assert.ok(error instanceof media.MediaError, `${file} gives a MediaError`);
      assert.equal(error.kind, kind, `${file}: ${error.detail}`);
      assert.doesNotMatch(error.message, /[\\/]|@ 0x|\.mp4|exit/, 'no paths or tool text in the message');
      return true;
    });
  }
  const installed = process.env.FFPROBE_PATH;
  process.env.FFPROBE_PATH = join(root, 'nowhere', 'ffprobe.exe');
  try {
    await assert.rejects(media.probe(whole, signal), (error) => {
      assert.ok(error instanceof media.MediaError);
      assert.equal(error.kind, 'tools', `a missing ffprobe is not blamed on the file: ${error.detail}`);
      assert.equal(error.message, 'The video tools could not process part of this video.');
      return true;
    });
  } finally {
    process.env.FFPROBE_PATH = installed;
  }
  const short =await make('short.mp4', [...lavfi('testsrc2=s=160x120:r=30:d=0.3'), ...h264]);
  assert.ok((await media.probe(short, signal)).seconds < 0.5, 'a 0.3 s bumper is accepted');
  const piped = join(root, 'piped.webm');
  const webm = await media.command(
    ffmpegPath,
    ['-nostdin', '-v', 'error', ...lavfi('testsrc2=s=160x120:r=30:d=2'), '-c:v', 'libvpx', '-deadline', 'realtime', '-f', 'webm', 'pipe:1'],
    signal,
  );
  await writeFile(piped, webm);
  const measured = await media.probe(piped, signal);
  assert.ok(Math.abs(measured.seconds - 2) < 0.2, `a WebM with no duration is measured: ${measured.seconds}`);
});

test('the main audio track is chosen and a described track is noticed', async () => {
  const file = await make('tracks.mkv', [
    ...lavfi(picture('320x240', 30, 4)),
    ...lavfi(sound(4, 0, 440)),
    ...lavfi(sound(4, 0, 880)),
    ...lavfi(sound(4, 0, 660)),
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:a',
    ...h264,
    '-c:a', 'aac',
    '-metadata:s:a:0', 'language=spa', '-metadata:s:a:0', 'title=Commentary',
    '-metadata:s:a:1', 'language=eng',
    '-metadata:s:a:2', 'language=eng', '-metadata:s:a:2', 'title=Audio Description',
    '-disposition:a:0', '0', '-disposition:a:1', 'default', '-disposition:a:2', 'visual_impaired',
  ]);
  const info = await media.probe(file, signal);
  assert.equal(info.audioIndex, 1);
  assert.equal(info.audioTracks, 3);
  assert.equal(info.describedAudio, true);
  const dir = await folder('tracks');
  const pcm = mono(await media.sectionSound(file, dir, 0, 3 * 48000, true, signal, info));
  assert.ok(bedAt(pcm, 1, 880) > 0.05, 'the English track is heard');
  assert.ok(bedAt(pcm, 1, 440) < 0.01, 'the commentary is not');
  const working = await media.normalize(file, dir, signal);
  assert.equal(working.media.audioTracks, 1);
  assert.equal(working.media.describedAudio, true);
  const kept = mono(await media.sectionSound(working.file, dir, 0, 3 * 48000, true, signal, working.media));
  assert.ok(bedAt(kept, 1, 880) > 0.05, 'the working copy keeps the chosen track');

  const track = (position, extra = {}) => ({ codec_type: 'audio', channels: 2, ...extra, position });
  assert.deepEqual(
    media.chooseAudio([
      track(0, { tags: { language: 'fra' }, channels: 6 }),
      track(1, { tags: { language: 'eng' } }),
    ]),
    { index: 1, described: false },
    'English wins when no track is default',
  );
  assert.deepEqual(
    media.chooseAudio([track(0, { tags: { language: 'eng' } }), track(1, { tags: { language: 'eng' }, channels: 6 })]),
    { index: 1, described: false },
    'then more channels',
  );
  assert.deepEqual(
    media.chooseAudio([track(0, { disposition: { visual_impaired: 1 } })]),
    { index: 0, described: true },
    'a lone described track is still used',
  );
  assert.deepEqual(media.chooseAudio([{ codec_type: 'video' }]), { index: null, described: false });
});

test('speech recognition hears the centre channel of surround sound', async () => {
  const bed = '0.1*sin(2*PI*220*t)';
  const beep = `0.5*sin(2*PI*2000*t)*(${on()})`;
  const file = await make('surround.mkv', [
    ...lavfi(picture('320x240', 30, 8)),
    ...lavfi(`aevalsrc='${bed}|${bed}|${beep}|0|${bed}|${bed}':c=5.1:s=48000:d=8`),
    ...h264,
    '-c:a',
    'ac3',
    '-b:a',
    '384k',
  ]);
  const info = await media.probe(file, signal);
  assert.equal(info.centre, true);
  const whole = await media.soundtrack(file, await folder('surround'), signal, info);
  const pcm = await plainPcm(whole.dialogue);
  near(bursts(pcm), events, 0.03, 'surround dialogue');
  assert.ok(level(pcm, Math.round(1.55 * 48000), 4800, 2000) > 0.4, 'dialogue kept at full level');
});

test('a capture with one dead channel is noticed and measured on its live channel', async () => {
  const both = await make('both.mkv', [...lavfi(picture('320x240', 30, 8)), ...lavfi(sound(8)), ...h264, '-c:a', 'flac']);
  const left = await make('left.mkv', [...lavfi(picture('320x240', 30, 8)), ...lavfi(sound(8, 0, 220, false)), ...h264, '-c:a', 'flac']);
  const reference = await media.soundtrack(both, await folder('sided-both'), signal);
  assert.equal(reference.oneSided, undefined);
  const info = await media.probe(left, signal);
  const measured = await media.soundtrack(left, await folder('sided-left'), signal, info);
  assert.equal(measured.oneSided, 'left');
  assert.ok(Math.abs(measured.program - reference.program) < 0.5, `${measured.program} vs ${reference.program}`);
  const pcm = await plainPcm(measured.dialogue);
  assert.ok(level(pcm, Math.round(1.55 * 48000), 4800, 2000) > 0.4, 'dialogue copy not halved');
  const stereo = await media.sectionSound(left, await folder('sided-sound'), 0, 48000, true, signal, { ...info, oneSided: 'left' });
  assert.ok(Math.abs(stereo[48000 + 1] - stereo[48000]) < 1e-6, 'the live channel is copied to both sides');
  assert.equal(media.liveChannel([-20, Number.NEGATIVE_INFINITY]), 'left');
  assert.equal(media.liveChannel([-80, -20]), 'right');
  assert.equal(media.liveChannel([-20, -25]), undefined);
  assert.equal(media.liveChannel([-90, Number.NEGATIVE_INFINITY]), undefined, 'silence is not one-sided');
  assert.deepEqual(
    media.channelLevels('[Parsed_astats_2 @ 1] Channel: 1\n[Parsed_astats_2 @ 1] RMS level dB: -13.5\n[Parsed_astats_2 @ 1] Channel: 2\n[Parsed_astats_2 @ 1] RMS level dB: -inf\n'),
    [-13.5, Number.NEGATIVE_INFINITY],
  );
});

test('the soundtrack pass also finds cuts, still pictures, momentary loudness and range', async () => {
  const file = await make('scenes.mp4', [
    ...lavfi("testsrc2=s=320x240:r=30:d=12,drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='between(t,4,10)'"),
    ...lavfi("aevalsrc='if(lt(t,6),0.5,0.1)*sin(2*PI*440*t)':s=48000:d=12"),
    ...h264,
    '-c:a',
    'aac',
  ]);
  const info = await media.probe(file, signal);
  const result = await media.soundtrack(file, await folder('scenes'), signal, info);
  assert.ok(result.cuts.some((t) => Math.abs(t - 4) < 0.1), `cut at 4: ${result.cuts}`);
  assert.ok(result.cuts.some((t) => Math.abs(t - 10) < 0.1), `cut at 10: ${result.cuts}`);
  assert.equal(result.stills.length, 1);
  assert.ok(Math.abs(result.stills[0].start - 4) < 0.1 && Math.abs(result.stills[0].end - 10) < 0.1, JSON.stringify(result.stills));
  assert.ok(Math.abs(result.momentary.length - 117) <= 3, `momentary blocks: ${result.momentary.length}`);
  assert.ok(result.momentary.every((block, i, all) => i === 0 || block.time > all[i - 1].time));
  const loudAt = (t) => result.momentary.find((block) => block.time >= t).lufs;
  assert.ok(loudAt(3) - loudAt(9) > 12, 'momentary follows the level');
  assert.ok(Number.isFinite(result.lra) && result.lra > 5, `LRA ${result.lra}`);

  process.env.KADE_DESCRIPTION_SCAN_TIMEOUT_MS = '1';
  try {
    const hurried = await media.soundtrack(file, await folder('scenes-hurried'), signal, info);
    assert.equal(hurried.cuts, undefined, 'a picture scan that runs out of time finds no cuts');
    assert.equal(hurried.stills, undefined);
    assert.ok(Math.abs(hurried.program - result.program) < 0.1, `loudness still measured: ${hurried.program}`);
    assert.ok(Math.abs(hurried.momentary.length - result.momentary.length) <= 1);
    near(bursts(await plainPcm(hurried.dialogue)), bursts(await plainPcm(result.dialogue)), 0.01, 'dialogue copy still made');
  } finally {
    delete process.env.KADE_DESCRIPTION_SCAN_TIMEOUT_MS;
  }

  assert.deepEqual(
    media.momentaryBlocks('frame:0    pts:0       pts_time:0\nlavfi.r128.M=-120.691\nframe:5    pts:24000   pts_time:0.5\nlavfi.r128.M=-23.456\n'),
    [{ time: 0.4, lufs: -23.46 }],
    'a block not yet 400 ms long is left out',
  );
  assert.deepEqual(
    media.pictureEvents(
      'frame:120  pts:61440   pts_time:4\nlavfi.scd.time=4\nframe:0    pts:0 pts_time:4.2\nlavfi.freezedetect.freeze_start=4.2\nframe:1 pts:1 pts_time:20\nlavfi.freezedetect.freeze_start=20\nframe:9 pts:9 pts_time:9.2\nlavfi.freezedetect.freeze_end=9.2\n',
      30,
    ),
    { cuts: [4], stills: [{ start: 4.2, end: 9.2 }, { start: 20, end: 30 }] },
    'a still running to the end closes at the end',
  );
});

test('analysis clips: more frames for short clips, close look slowed, and a size ceiling', async () => {
  const file = await make('clips.mp4', [...lavfi(picture('320x240', 30, 26)), ...lavfi(sound(26)), ...h264, '-c:a', 'aac']);
  const info = await media.probe(file, signal);
  const count = async (clip) => {
    const data = await probeJson(clip, 'stream=codec_type,nb_read_packets', ['-count_packets']);
    return Number(data.streams.find((s) => s.codec_type === 'video').nb_read_packets);
  };
  const dir = await folder('clips');
  assert.ok(Math.abs((await count(await media.sectionClip(file, dir, 0, 5, signal, false, info))) - 40) <= 1, 'ident clips at 8 fps');
  assert.ok(Math.abs((await count(await media.sectionClip(file, dir, 0, 25, signal, false, info))) - 75) <= 1, 'longer sections at 3 fps');
  const slowed = await media.sectionClip(file, dir, 0, 4, signal, true, info);
  const length = Number((await probeJson(slowed, 'format=duration')).format.duration);
  assert.ok(Math.abs(length - 16) < 0.2, `close look plays four times longer: ${length}`);
  assert.equal(media.lookRate(20), 8);
  assert.equal(media.lookRate(21), 3);
  assert.equal(media.videoCeiling(60), 600000);
  assert.ok(media.videoCeiling(600) < 600000 && media.videoCeiling(600) > 400000);
  assert.equal(media.videoCeiling(100000), 100000);
  const bytes = (seconds) => ((media.videoCeiling(seconds) + 48000) * seconds) / 8;
  for (const seconds of [480, 600, 2000])
    assert.ok(bytes(seconds) < 40 * 1024 ** 2, `a ${seconds} s clip fits under 40 MB at its ceiling`);
});

/** The text a time strip's drawtext prints at time `t`, with its expansions worked out here. */
function stripPrints(filters, t) {
  const quoted = /:text='((?:[^'\\]|\\.)*)'/.exec(filters[1]);
  assert.ok(quoted, 'the strip text is quoted for the filter graph');
  const text = quoted[1].replace(/\\(.)/g, '$1');
  const mod = (a, b) => a - b * Math.floor(a / b);
  return text.replace(/%\{eif:([^:}]+):d(?::(\d+))?\}/g, (_match, expression, pad) => {
    const value = Function('t', 'floor', 'mod', `return ${expression};`)(t, Math.floor, mod);
    return String(Math.trunc(value)).padStart(Number(pad || 0), '0');
  });
}

test('time strip: a padded band under the picture prints the real film time and the clip time', () => {
  const strip = media.timeStrip({ font: 'C:/Windows/Fonts/consola.ttf', film: 80.75, scale: 4, seconds: 77.5, width: 1280, height: 720 });
  assert.equal(strip.length, 2);
  const band = Number(/^pad=w=iw:h=ih\+(\d+):x=0:y=0:color=black$/.exec(strip[0])?.[1]);
  assert.ok(band >= 24 && band % 2 === 0, `an even band is added below the picture: ${strip[0]}`);
  assert.ok(strip[1].startsWith("drawtext=fontfile='C\\:/Windows/Fonts/consola.ttf':text='film %{eif\\:"), strip[1]);
  assert.match(strip[1], /:fontcolor=white:/);
  const y = /:y=h-(\d+)\+(\d+)$/.exec(strip[1]);
  assert.ok(y && Number(y[1]) === band, 'the lettering sits inside the band, never on the picture');
  const size = Number(/:fontsize=(\d+):/.exec(strip[1])[1]);
  assert.ok(Number(y[2]) + size <= band, 'the lettering fits the band');
  assert.ok(!/[,;[\]]/.test(strip[1].replace(/'[^']*'/g, '')), 'commas in the expressions stay inside the quotes');
  assert.equal(stripPrints(strip, 0), 'film 1:20.8   clip 0.0');
  assert.equal(stripPrints(strip, 22.75), 'film 1:43.5   clip 91.0', 'close look: clip time runs four times faster than film time');
  assert.equal(stripPrints(strip, 76.25), 'film 2:37.0   clip 305.0');
  const plain = media.timeStrip({ font: '/usr/share/fonts/dejavu/DejaVuSansMono.ttf', film: 12, scale: 1, seconds: 60, width: 960, height: 540 });
  assert.equal(stripPrints(plain, 1 / 3), 'film 0:12.3   clip 0.3', 'a normal look prints the same second twice over');
  assert.ok(plain[1].startsWith("drawtext=fontfile='/usr/share/fonts/dejavu/DejaVuSansMono.ttf':"));
  const late = media.timeStrip({ font: '/f.ttf', film: 3597.25, scale: 4, seconds: 8, width: 960, height: 540 });
  assert.equal(stripPrints(late, 5), 'film 1:00:02.3   clip 20.0', 'past an hour the clock shows hours');
  const tall = media.timeStrip({ font: '/f.ttf', film: 0, scale: 4, seconds: 60, width: 406, height: 720 });
  const tallSize = Number(/:fontsize=(\d+):/.exec(tall[1])[1]);
  assert.ok(tallSize * 0.62 * 28 <= 406, `a narrow portrait picture gets lettering that fits its width: ${tallSize}`);
});

test('look clips: the time strip is added under the picture, and with no font the clip is made without it', async () => {
  const file = await make('clips.mp4', [...lavfi(picture('320x240', 30, 26)), ...lavfi(sound(26)), ...h264, '-c:a', 'aac']);
  const info = await media.probe(file, signal);
  const dir = await folder('strip');
  const bare = await media.lookClip(file, dir, 2, 4, signal, true, info);
  assert.equal(bare.stamped, false, 'no film time asked for, no strip');
  const plain = await geometry(bare.file);
  const gray = async (clip, width, height) => {
    const raw = await media.command(ffmpegPath, ['-nostdin', '-v', 'error', '-i', clip, '-frames:v', '1', '-vf', `scale=${width}:${height}:flags=neighbor,format=gray`, '-f', 'rawvideo', '-'], signal);
    return raw;
  };
  const before = await gray(bare.file, plain.width, plain.height);
  const font = await media.stripFont();
  const stamped = await media.lookClip(file, dir, 2, 4, signal, true, info, 82);
  assert.equal(stamped.stamped, font !== null && (await media.capabilities()).drawtext);
  const shaped = await geometry(stamped.file);
  assert.equal(shaped.width, plain.width);
  if (stamped.stamped) {
    const band = shaped.height - plain.height;
    assert.ok(band >= 24, `the strip adds a band below the picture: ${band}`);
    const after = await gray(stamped.file, shaped.width, shaped.height);
    let diff = 0;
    for (let i = 0; i < plain.width * plain.height; i++) diff += Math.abs(after[i] - before[i]);
    assert.ok(diff / (plain.width * plain.height) < 6, 'the picture above the strip is not covered');
    const strip = after.subarray(plain.width * plain.height);
    const dark = strip.filter((value) => value < 40).length / strip.length;
    const lit = strip.filter((value) => value > 200).length;
    assert.ok(dark > 0.6 && lit > 50, `the band is black with white lettering: ${dark}, ${lit}`);
    const length = Number((await probeJson(stamped.file, 'format=duration')).format.duration);
    assert.ok(Math.abs(length - 16) < 0.2, `still slowed four times: ${length}`);
  } else assert.equal(shaped.height, plain.height);
  const own = join(dir, 'own-font.ttf');
  await writeFile(own, 'any file');
  process.env.KADE_DESCRIPTION_FONT = own.replace(/\//g, '\\');
  try {
    assert.equal(await media.stripFont(), own.replace(/\\/g, '/'), 'a font named in the setting comes first');
    if ((await media.capabilities()).drawtext) {
      // A file that is not a font: ffmpeg either finds another through fontconfig and letters the
      // band, or fails, and the look is made without the strip. Never a blank band called a strip.
      const clean = await geometry(await media.sectionClip(file, dir, 2, 4, signal, false, info));
      const broken = await media.lookClip(file, dir, 2, 4, signal, false, info, 82);
      const shape = await geometry(broken.file);
      if (broken.stamped) {
        const frame = await gray(broken.file, shape.width, shape.height);
        const lit = frame.subarray(clean.width * clean.height).filter((value) => value > 100).length;
        assert.ok(shape.height > clean.height && lit > 50, `a strip that is claimed carries lettering: ${lit}`);
      } else assert.equal(shape.height, clean.height, 'no band, nothing burned in');
    }
    process.env.KADE_DESCRIPTION_FONT = join(dir, 'missing.ttf');
    assert.equal(await media.stripFont(), font, 'a named font that is not there falls back to the installed ones');
    process.env.KADE_DESCRIPTION_FONT = 'off';
    assert.equal(await media.stripFont(), null);
    const fallback = await media.lookClip(file, dir, 2, 4, signal, false, info, 82);
    assert.equal(fallback.stamped, false, 'with no font the clip is made without the strip');
    const fallbackHeight = (await geometry(fallback.file)).height;
    assert.equal(fallbackHeight, (await geometry(await media.sectionClip(file, dir, 2, 4, signal, false, info))).height);
  } finally {
    delete process.env.KADE_DESCRIPTION_FONT;
  }
  assert.equal(await media.stripFont(), font, 'the installed font comes back once the setting is gone');
});

test('assemble adds text tracks, chapters and a whole title, and keeps a late picture in step', async () => {
  const D = 8;
  const file = await joined('late-picture.mkv', { seconds: D, videoDelay: 0.5, codecs: [...h264, '-c:a', 'aac'] });
  const info = await media.probe(file, signal);
  assert.ok(info.videoStart - (info.formatStart ?? 0) > 0.4, 'the picture starts after the sound');
  const dir = await folder('assemble');
  const length = Math.floor((D - 0.6) * 48000);
  const flac = join(dir, 'sound.flac');
  await media.saveSound(await media.sectionSound(file, dir, 0, length, true, signal, info), flac, signal);
  const captions = join(dir, 'captions.vtt');
  await writeFile(captions, 'WEBVTT\n\n00:00.500 --> 00:02.000\nHello there.\n');
  const descriptions = join(dir, 'descriptions.vtt');
  await writeFile(descriptions, 'WEBVTT\n\n00:01.000 --> 00:03.000\nA white flash.\n');
  const title = `${'x'.repeat(195)}😀😀 (described)`;
  const output = await media.assemble(dir, [flac], null, file, title, signal, {
    media: info,
    subtitles: [
      { file: captions, language: 'en', title: 'Captions' },
      { file: descriptions, language: 'en-US', title: 'Audio descriptions (text)' },
    ],
    chapters: [
      { start: 3, title: 'Ad = one; two #1' },
      { start: 0, title: 'Opening' },
      { start: 100, title: 'Past the end' },
    ],
  });
  near(bursts(await timedPcm(output.video)), flashes(await frames(output.video)), 0.05, 'copied picture and new sound');
  const streams = (await probeJson(output.video, 'stream=codec_type,codec_name:stream_tags=language,handler_name')).streams;
  const texts = streams.filter((s) => s.codec_type === 'subtitle');
  assert.deepEqual(texts.map((s) => s.codec_name), ['mov_text', 'mov_text']);
  assert.deepEqual(texts.map((s) => s.tags.language), ['eng', 'eng']);
  assert.deepEqual(texts.map((s) => s.tags.handler_name), ['Captions', 'Audio descriptions (text)']);
  const shown = (await probeJson(output.video, 'stream=codec_type:stream_disposition=default')).streams;
  assert.deepEqual(
    shown.map((s) => [s.codec_type, s.disposition.default]), // the chapter track (data) was never on
    [['video', 1], ['audio', 1], ['subtitle', 0], ['subtitle', 0], ['data', 0]],
    'no text track is switched on by default, so no player shows it (and VoiceOver reads it) unasked',
  );
  assert.equal(await media.quietTextTracks(output.video), 0, 'running it again changes nothing');
  assert.equal(await media.quietTextTracks(output.audio), 0, 'a file without text tracks is left alone');
  const lead = info.videoStart - info.formatStart;
  for (const [out, shift] of [[output.video, lead], [output.audio, 0]]) {
    const data = await probeJson(out, 'chapter=start_time:chapter_tags=title:format_tags=title', ['-show_chapters']);
    assert.deepEqual(data.chapters.map((c) => c.tags.title), ['Opening', 'Ad = one; two #1']);
    const second = Number(data.chapters[1].start_time);
    assert.ok(Math.abs(second - (3 + shift)) < 0.01, `${out} second chapter at ${second}, picture starts ${shift}`);
    const tag = data.format.tags.title;
    assert.ok(tag.endsWith(' (described)') && !tag.includes('�') && Array.from(tag).length <= 200, tag);
  }

  assert.equal(media.trackLanguage('en-US'), 'eng');
  assert.equal(media.trackLanguage('spa'), 'spa');
  assert.equal(media.trackLanguage(''), 'und');
  assert.equal(media.clip('ab😀cd', 3), 'ab😀');
  assert.equal(media.titleTag('Tape\u200b 3\n (described)'), 'Tape 3 (described)');
  assert.equal(media.chapterMetadata([{ start: 5, title: 'x' }], 4), null);
  assert.match(media.chapterMetadata([{ start: 0, title: 'a=b;c#d\\e' }], 10), /title=a\\=b\\;c\\#d\\\\e\n/);
});

test('a copied picture stops where the new soundtrack stops, and none of the original tags come along', async () => {
  const file = await make('phone.mov', [
    ...lavfi(picture('320x240', 30, 30)),
    ...lavfi(sound(30)),
    ...h264,
    '-c:a',
    'aac',
    '-metadata',
    'location=+37.2090-093.2923/',
    '-metadata',
    'comment=Birthday at home',
  ]);
  const dir = await folder('copy-preview');
  const working = await media.normalize(file, dir, signal);
  assert.equal(media.copyable(working.media), true);
  const flac = join(dir, 'sound.flac');
  await media.saveSound(await media.sectionSound(working.file, dir, 0, 10 * 48000, true, signal, working.media), flac, signal);
  const descriptions = join(dir, 'descriptions.vtt');
  await writeFile(descriptions, 'WEBVTT\n\n00:01.000 --> 00:04.000\nA white flash.\n');
  const output = await media.assemble(dir, [flac], null, working.file, 'Birthday (described)', signal, {
    media: working.media,
    subtitles: [{ file: descriptions, language: 'en', title: 'Audio descriptions (text)' }],
  });
  const data = await probeJson(output.video, 'format=duration:format_tags:stream=codec_type,duration');
  const lengths = [data.format.duration, ...data.streams.filter((s) => s.codec_type !== 'subtitle').map((s) => s.duration)];
  assert.ok(lengths.every((value) => Math.abs(Number(value) - 10) < 0.1), `described copy lengths ${lengths}`);
  const tags = Object.keys(data.format.tags);
  assert.ok(tags.includes('title'), `tags ${tags}`);
  assert.deepEqual(tags.filter((key) => /location|comment/i.test(key)), [], 'no place or comment from the original');
});

test('media tools run with a thread cap and lowered priority, and fail in plain words', async () => {
  assert.equal(media.threadCount(), 2);
  process.env.KADE_DESCRIPTION_THREADS = '3';
  assert.equal(media.threadCount(), 3);
  process.env.KADE_DESCRIPTION_THREADS = 'lots';
  assert.equal(media.threadCount(), 2);
  delete process.env.KADE_DESCRIPTION_THREADS;
  const { stdout } = await media.execute(
    process.execPath,
    ['-e', 'setTimeout(() => process.stdout.write(String(require("os").getPriority())), 300)'],
    signal,
  );
  assert.equal(stdout.toString(), '10');
  await assert.rejects(
    media.execute(ffmpegPath, ['-v', 'error', '-i', join(root, 'missing', 'file.mp4'), '-f', 'null', '-'], signal),
    (error) => error instanceof media.MediaError && error.kind === 'tools' && error.detail.includes('missing'),
  );
  assert.equal(media.mediaProblem('[mov,mp4 @ 0x1] moov atom not found'), 'damaged');
  assert.equal(media.mediaProblem('av_interleaved_write_frame(): No space left on device'), 'disk');
  assert.equal(media.mediaProblem("Stream map '0:v:0' matches no streams."), 'no-video');
  assert.equal(media.mediaProblem('[concat @ 0x1] Format not on whitelist'), 'format');
  assert.equal(new media.MediaError('damaged', '/tmp/job/source: moov atom not found').message.includes('/tmp'), false);
  const controller = new AbortController();
  const running = media.execute(ffmpegPath, ['-v', 'error', '-re', ...lavfi('testsrc2=d=30'), '-f', 'null', '-'], controller.signal);
  controller.abort();
  await assert.rejects(running, (error) => error.name === 'AbortError', 'cancelling stays a cancellation');
  await assert.rejects(
    media.execute(ffmpegPath, ['-v', 'error', '-re', ...lavfi('testsrc2=d=5'), '-f', 'null', '-'], signal, undefined, undefined, { timeoutMs: 300 }),
    (error) => {
      assert.ok(error instanceof media.MediaError);
      assert.equal(error.message, 'This video took too long to prepare. Describe a shorter part, or a lower-resolution copy.');
      return true;
    },
    'a tool that runs past its time limit says so',
  );
  const film = { seconds: 5400, width: 1920, height: 1080, fps: { num: 30, den: 1 } };
  assert.equal(media.workLimit({ ...film, seconds: 60 }), 60 * 60e3, 'at least an hour');
  assert.equal(media.workLimit(film), 5400 * 1.5e3, 'a 90-minute 1080p film gets half as long again as its length');
  assert.equal(media.workLimit({ ...film, width: 3840, height: 2160 }), 4 * 5400 * 1.5e3, '4K gets four times that');
  assert.equal(media.workLimit(film, 600), 60 * 60e3, 'a short part of a long film');
});

test('the ffmpeg capability check is logged once and missing filters degrade', async () => {
  const tools = await media.capabilities(log);
  await media.capabilities(log);
  const lines = logged.filter((line) => line.startsWith('Media tools:'));
  assert.equal(lines.length, 1, 'logged once per process');
  assert.match(lines[0], /^Media tools: ffmpeg version .*; missing: none$/);
  assert.equal(tools.bwdif && tools.scdet && tools.freezedetect && tools.zscale && tools.limiterLatency, true);
  const plain = { ...tools, bwdif: false, zscale: false };
  const hdrFile = await make('tools-hdr.mov', [...lavfi('testsrc2=s=320x240:r=30:d=1'), '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-color_trc', 'arib-std-b67', '-color_primaries', 'bt2020', '-colorspace', 'bt2020nc', '-x265-params', 'log-level=error']);
  const hdr = await media.probe(hdrFile, signal);
  assert.match(media.deinterlace({ ...hdr, interlaced: true, parity: 'bff' }, plain), /^yadif=mode=send_frame:parity=bff:deint=all$/);
  assert.equal(media.shape(hdr, plain, 960).some((f) => f.startsWith('zscale')), false);
  assert.equal(media.shape(hdr, tools, 960).includes('tonemap=hable:desat=0'), true);
  const fallback = [media.deinterlace(hdr, plain), ...media.shape(hdr, plain, 320)].join(',');
  await media.command(ffmpegPath, ['-nostdin', '-v', 'error', '-i', hdrFile, '-vf', fallback, '-f', 'null', '-'], signal);
});
