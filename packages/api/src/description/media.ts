import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { sampleRate } from './mix';
import { tempoFilters } from './timing';

export const ffmpeg = (): string => process.env.FFMPEG_PATH || 'ffmpeg';
export const ffprobe = (): string => process.env.FFPROBE_PATH || 'ffprobe';
const quiet = ['-nostdin', '-hide_banner', '-v', 'error', '-y', '-protocol_whitelist', 'file,pipe'];

export async function command(
  bin: string,
  args: string[],
  signal: AbortSignal,
  input?: Buffer,
  maxBytes: number = 32 * 1024 ** 2,
): Promise<Buffer> {
  return (await execute(bin, args, signal, input, maxBytes)).stdout;
}

/** Runs a media tool and keeps the tail of its log as well as its output. */
export async function execute(
  bin: string,
  args: string[],
  signal: AbortSignal,
  input?: Buffer,
  maxBytes: number = 32 * 1024 ** 2,
): Promise<{ stdout: Buffer; log: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, signal, stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = [];
    let bytes = 0;
    let log = '';
    let settled = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 60 * 60 * 1000);
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(output), log });
    };
    child.on('error', done);
    child.stdout.on('data', (buffer: Buffer) => {
      bytes += buffer.length;
      if (bytes > maxBytes) {
        child.kill('SIGKILL');
        done(new Error('Media output exceeded its limit.'));
        return;
      }
      output.push(buffer);
    });
    child.stderr.on('data', (buffer: Buffer) => {
      log = (log + buffer.toString()).slice(-12000);
    });
    child.on('close', (code) =>
      done(
        code === 0 ? undefined : new Error(`Media processing failed (${code}): ${log.slice(-800)}`),
      ),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export type Rational = { num: number; den: number };
export type Media = {
  seconds: number;
  audio: boolean;
  width: number;
  height: number;
  fps: Rational;
  codec: string;
  pixels: string;
};
type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
};
type Probe = { format?: { duration?: string }; streams?: ProbeStream[] };

function rational(value: string | undefined): Rational | null {
  const [num, den] = String(value || '')
    .split('/')
    .map(Number);
  if (!num || !den || !Number.isFinite(num / den)) return null;
  const rate = num / den;
  return rate >= 5 && rate <= 61 ? { num, den } : null;
}

/** Chooses a steady output frame rate close to the source, never above 60. */
export function frameRate(stream: ProbeStream): Rational {
  const direct = rational(stream.r_frame_rate) || rational(stream.avg_frame_rate);
  if (direct) return direct;
  const [num, den] = String(stream.r_frame_rate || '')
    .split('/')
    .map(Number);
  if (num && den && num / den > 61) {
    let divisor = 2;
    while (num / den / divisor > 61) divisor++;
    return { num, den: den * divisor };
  }
  return { num: 30, den: 1 };
}

export async function probe(file: string, signal: AbortSignal): Promise<Media> {
  const raw = await command(
    ffprobe(),
    [
      '-v',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      '-show_entries',
      'format=duration:stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,r_frame_rate',
      '-of',
      'json',
      file,
    ],
    signal,
    undefined,
    1024 * 1024,
  );
  const data: Probe = JSON.parse(raw.toString());
  const seconds = Number(data.format?.duration);
  const video = data.streams?.find(
    (stream) => stream.codec_type === 'video' && (stream.width || 0) > 0,
  );
  if (!video || !Number.isFinite(seconds) || seconds < 0.5)
    throw new Error('This file does not contain a playable video.');
  return {
    seconds,
    audio: !!data.streams?.some((stream) => stream.codec_type === 'audio'),
    width: video.width || 0,
    height: video.height || 0,
    fps: frameRate(video),
    codec: video.codec_name || '',
    pixels: video.pix_fmt || '',
  };
}

/** True when the original picture can be kept as it is, with only the soundtrack replaced. */
export const copyable = (media: Media): boolean =>
  media.codec === 'h264' && ['yuv420p', 'yuvj420p'].includes(media.pixels) && media.width <= 1920;

/**
 * One pass over the whole soundtrack: measures its loudness and peak, and writes the small mono
 * copy that speech recognition reads.
 */
export async function soundtrack(
  source: string,
  directory: string,
  signal: AbortSignal,
): Promise<{ dialogue: string; program: number; peak: number }> {
  const dialogue = join(directory, 'dialogue.m4a');
  const { log } = await execute(
    ffmpeg(),
    [
      '-nostdin',
      '-hide_banner',
      '-nostats',
      '-v',
      'info',
      '-y',
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      source,
      '-filter_complex',
      '[0:a:0]aresample=48000,aformat=channel_layouts=stereo,asplit=2[l][d];[l]ebur128=peak=sample:framelog=quiet[m];[d]aresample=16000,pan=mono|c0=0.5*c0+0.5*c1[s]',
      '-map',
      '[m]',
      '-f',
      'null',
      '-',
      '-map',
      '[s]',
      '-c:a',
      'aac',
      '-b:a',
      '48k',
      '-movflags',
      '+faststart',
      dialogue,
    ],
    signal,
  );
  const summary = log.slice(log.lastIndexOf('Summary:'));
  const program = Number(/I:\s*(-?[\d.]+|-inf) LUFS/.exec(summary)?.[1]);
  const peak = Number(/Peak:\s*(-?[\d.]+|-inf) dBFS/.exec(summary)?.[1]);
  return {
    dialogue,
    program: Number.isFinite(program) ? program : -70,
    peak: Number.isFinite(peak) ? peak : -70,
  };
}

/** A small copy of one section, with sound, for the vision model to watch and hear. */
export async function sectionClip(
  source: string,
  directory: string,
  start: number,
  seconds: number,
  signal: AbortSignal,
): Promise<string> {
  const video = join(directory, 'analysis.mp4');
  await command(
    ffmpeg(),
    [
      ...quiet,
      '-ss',
      start.toFixed(6),
      '-i',
      source,
      '-t',
      seconds.toFixed(6),
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-vf',
      "scale=w='min(960,iw)':h=-2,fps=3",
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '28',
      '-c:a',
      'aac',
      '-ac',
      '1',
      '-b:a',
      '48k',
      '-movflags',
      '+faststart',
      video,
    ],
    signal,
  );
  if ((await stat(video)).size > 40 * 1024 ** 2)
    throw new Error('A video section is too large to analyze.');
  return video;
}

const floats = (buffer: Buffer): Float32Array =>
  new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
const bytes = (pcm: Float32Array): Buffer =>
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);

/** The section's own soundtrack as 48 kHz interleaved stereo, exactly `frames` long. */
export async function sectionSound(
  source: string,
  directory: string,
  start: number,
  frames: number,
  hasAudio: boolean,
  signal: AbortSignal,
): Promise<Float32Array> {
  const out = new Float32Array(frames * 2);
  if (!hasAudio) return out;
  const file = join(directory, 'sound.f32');
  await command(
    ffmpeg(),
    [
      ...quiet,
      '-ss',
      start.toFixed(6),
      '-i',
      source,
      '-t',
      (frames / sampleRate + 0.1).toFixed(6),
      '-map',
      '0:a:0',
      '-af',
      `aresample=${sampleRate}:first_pts=0,aformat=sample_fmts=flt:channel_layouts=stereo`,
      '-f',
      'f32le',
      file,
    ],
    signal,
  );
  const decoded = floats(await readFile(file));
  out.set(decoded.subarray(0, Math.min(decoded.length, out.length)));
  return out;
}

export async function decodeVoice(file: string, signal: AbortSignal): Promise<Float32Array> {
  return floats(
    await command(
      ffmpeg(),
      [...quiet, '-i', file, '-vn', '-ar', String(sampleRate), '-ac', '1', '-f', 'f32le', 'pipe:1'],
      signal,
      undefined,
      64 * 1024 ** 2,
    ),
  );
}

/** Speeds narration up with pitch kept. */
export async function stretch(
  pcm: Float32Array,
  factor: number,
  signal: AbortSignal,
): Promise<Float32Array> {
  if (Math.abs(factor - 1) < 0.005) return pcm;
  const raw = ['-f', 'f32le', '-ar', String(sampleRate), '-ac', '1'];
  return floats(
    await command(
      ffmpeg(),
      [...quiet, ...raw, '-i', 'pipe:0', '-af', tempoFilters(factor), ...raw, 'pipe:1'],
      signal,
      bytes(pcm),
      64 * 1024 ** 2,
    ),
  );
}

/** Limits peaks to -1 dBFS and stores a mixed section losslessly. */
export async function saveSound(
  pcm: Float32Array,
  file: string,
  signal: AbortSignal,
): Promise<void> {
  const raw = join(file + '.f32');
  await writeFile(raw, bytes(pcm));
  await command(
    ffmpeg(),
    [
      ...quiet,
      '-f',
      'f32le',
      '-ar',
      String(sampleRate),
      '-ac',
      '2',
      '-i',
      raw,
      '-af',
      'alimiter=limit=0.891:attack=5:release=80:level=false:latency=true',
      '-c:a',
      'flac',
      '-sample_fmt',
      's32',
      file,
    ],
    signal,
  );
}

/** Frozen-picture pauses for one section, in frames of the output rate. */
export type Freeze = { frame: number; frames: number };

/**
 * Re-encodes one section's picture on the output frame grid, holding the picture still for
 * each pause. The section is exactly `frames + pauses` frames long, so sections line up with
 * their soundtrack no matter how many are joined.
 */
export async function sectionPicture(
  source: string,
  directory: string,
  index: number,
  start: number,
  frames: number,
  fps: Rational,
  freezes: Freeze[],
  signal: AbortSignal,
): Promise<string> {
  const merged = freezes
    .filter((item) => item.frames > 0)
    .map((item) => ({ frame: Math.min(frames, Math.max(0, item.frame)), frames: item.frames }))
    .sort((a, b) => a.frame - b.frame)
    .reduce<Freeze[]>((list, item) => {
      const last = list[list.length - 1];
      if (last && last.frame === item.frame) last.frames += item.frames;
      else list.push({ ...item });
      return list;
    }, []);
  const lead = merged[0]?.frame === 0 ? merged.shift()!.frames : 0;
  const cuts = [0, ...merged.map((item) => item.frame), frames];
  const count = cuts.length - 1;
  const rate = `${fps.num}/${fps.den}`;
  const filters = [
    `[0:v:0]fps=${rate}:start_time=0,scale=w='min(1280,iw)':h=-2:flags=bicubic,setsar=1,format=yuv420p,trim=end_frame=${frames}[base]`,
    `[base]split=${count}${cuts
      .slice(1)
      .map((_, i) => `[v${i}]`)
      .join('')}`,
    ...cuts.slice(1).map((end, i) => {
      const pads = [
        i === 0 && lead ? `tpad=start_mode=clone:start=${lead}` : '',
        merged[i] ? `tpad=stop_mode=clone:stop=${merged[i].frames}` : '',
      ].filter(Boolean);
      return `[v${i}]trim=start_frame=${cuts[i]}:end_frame=${end},setpts=PTS-STARTPTS${pads.length ? ',' + pads.join(',') : ''}[s${i}]`;
    }),
    `${cuts
      .slice(1)
      .map((_, i) => `[s${i}]`)
      .join('')}concat=n=${count}:v=1:a=0[out]`,
  ];
  const graph = join(directory, 'picture.txt');
  await writeFile(graph, filters.join(';\n'));
  const output = join(directory, `part-${index}.mp4`);
  const total = frames + lead + merged.reduce((sum, item) => sum + item.frames, 0);
  await command(
    ffmpeg(),
    [
      ...quiet,
      '-ss',
      start.toFixed(6),
      '-t',
      ((frames * fps.den) / fps.num + 1).toFixed(6),
      '-i',
      source,
      '-filter_complex_script',
      graph,
      '-map',
      '[out]',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '22',
      '-threads',
      '2',
      '-r',
      rate,
      '-frames:v',
      String(total),
      '-movflags',
      '+faststart',
      output,
    ],
    signal,
  );
  return output;
}

const listFile = (files: string[]) =>
  files.map((file) => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');

/**
 * Joins the finished sections: one AAC soundtrack for both files, and either the original
 * picture untouched or the re-encoded sections with their pauses.
 */
export async function assemble(
  directory: string,
  sounds: string[],
  pictures: string[] | null,
  source: string,
  title: string,
  signal: AbortSignal,
): Promise<{ video: string; audio: string }> {
  const soundList = join(directory, 'sounds.txt');
  await writeFile(soundList, listFile(sounds));
  const audio = join(directory, 'described.m4a');
  const video = join(directory, 'described.mp4');
  const tag = ['-metadata', `title=${title.replace(/[\r\n]/g, ' ').slice(0, 200)}`];
  await command(
    ffmpeg(),
    [
      ...quiet,
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      soundList,
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      ...tag,
      '-movflags',
      '+faststart',
      audio,
    ],
    signal,
  );
  const picture = pictures ? join(directory, 'pictures.txt') : source;
  if (pictures) await writeFile(picture, listFile(pictures));
  await command(
    ffmpeg(),
    [
      ...quiet,
      ...(pictures ? ['-f', 'concat', '-safe', '0'] : []),
      '-i',
      picture,
      '-i',
      audio,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c',
      'copy',
      ...tag,
      '-movflags',
      '+faststart',
      video,
    ],
    signal,
  );
  return { video, audio };
}
