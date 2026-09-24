import { setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { Chapter, Interval } from './types';
import { tempoFilters } from './timing';
import { sampleRate } from './mix';

export const ffmpeg = (): string => process.env.FFMPEG_PATH || 'ffmpeg';
export const ffprobe = (): string => process.env.FFPROBE_PATH || 'ffprobe';
const quiet = ['-nostdin', '-hide_banner', '-v', 'error', '-y', '-protocol_whitelist', 'file,pipe'];
const loud = ['-nostdin', '-hide_banner', '-nostats', '-v', 'info', '-y'];

/**
 * Demuxers a source may be opened with. Script and playlist demuxers (concat, hls, dash, image2,
 * ffmetadata, tee, lavfi) are never on it, so an upload cannot make the tools open other files.
 */
export const videoFormats: readonly string[] = [
  'mov',
  'mp4',
  'm4a',
  '3gp',
  '3g2',
  'mj2',
  'matroska',
  'webm',
  'avi',
  'mpegts',
  'mpeg',
  'mpegvideo',
  'asf',
  'flv',
  'dv',
  'ogg',
  'rm',
  'wtv',
  'mxf',
  'nut',
  'gxf',
  'h264',
  'hevc',
  'm4v',
];
const audioFormats = ['mp3', 'wav', 'flac', 'aac', 'w64', 'aiff'];
const sourceOnly = ['-format_whitelist', videoFormats.join(',')];

/** Worker threads for each media tool (KADE_DESCRIPTION_THREADS, 2 by default). */
export function threadCount(): number {
  const value = Number.parseInt(process.env.KADE_DESCRIPTION_THREADS || '', 10);
  return Number.isFinite(value) && value >= 1 ? Math.min(value, 16) : 2;
}
const inputThreads = (): string[] => ['-threads', String(threadCount())];
const outputThreads = (complex: boolean = false): string[] => [
  '-threads',
  String(threadCount()),
  '-filter_threads',
  '1',
  ...(complex ? ['-filter_complex_threads', '1'] : []),
];

export type MediaProblem =
  'damaged' | 'no-video' | 'cover-art' | 'too-short' | 'format' | 'too-detailed' | 'disk' | 'tools';
const plainWords: Record<MediaProblem, string> = {
  damaged:
    'This video file is incomplete or damaged. It may not have finished copying. Export or download it again.',
  'no-video': 'This file does not contain a playable video.',
  'cover-art':
    'This is an audio file with a picture, not a video. Describing it would only describe the still image.',
  'too-short': 'This clip is too short to describe.',
  format: 'This file is a playlist, a script or a kind of file that cannot be described.',
  'too-detailed': 'This part of the video is too detailed to send to the video model.',
  disk: 'The server ran out of room for temporary files. Try again later.',
  tools: 'The video tools could not process part of this video.',
};

/** A media failure: `message` is plain words for Kade, `detail` the tool log for the server log only. */
export class MediaError extends Error {
  readonly kind: MediaProblem;
  readonly detail: string;
  constructor(kind: MediaProblem, detail: string = '', message: string = plainWords[kind]) {
    super(message);
    this.name = 'MediaError';
    this.kind = kind;
    this.detail = detail;
  }
}

/** Names the likely cause of a failed media tool run from its log. */
export function mediaProblem(log: string): MediaProblem {
  if (/No space left on device|Disk quota exceeded/i.test(log)) return 'disk';
  if (/not on whitelist/i.test(log)) return 'format';
  if (
    /moov atom not found|Invalid data found|could not find codec parameters|error reading header|Invalid NAL|truncated|End of file/i.test(
      log,
    )
  )
    return 'damaged';
  if (/matches no streams/i.test(log)) return 'no-video';
  return 'tools';
}

export type ExecuteOptions = { cwd?: string; logBytes?: number };

export async function command(
  bin: string,
  args: string[],
  signal: AbortSignal,
  input?: Buffer,
  maxBytes: number = 32 * 1024 ** 2,
): Promise<Buffer> {
  return (await execute(bin, args, signal, input, maxBytes)).stdout;
}

function lowerPriority(pid: number | undefined): void {
  if (!pid) return;
  try {
    setPriority(pid, 10);
  } catch {
    return;
  }
}

/**
 * Runs a media tool at lowered priority and keeps the tail of its log as well as its output.
 * Failures become a MediaError; cancellation stays an AbortError.
 */
export async function execute(
  bin: string,
  args: string[],
  signal: AbortSignal,
  input?: Buffer,
  maxBytes: number = 32 * 1024 ** 2,
  options: ExecuteOptions = {},
): Promise<{ stdout: Buffer; log: string }> {
  const logBytes = options.logBytes ?? 12000;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, {
      windowsHide: true,
      signal,
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    lowerPriority(child.pid);
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
      else resolvePromise({ stdout: Buffer.concat(output), log });
    };
    child.on('error', (error: Error) =>
      done(error.name === 'AbortError' ? error : new MediaError('tools', error.message)),
    );
    child.stdout.on('data', (buffer: Buffer) => {
      bytes += buffer.length;
      if (bytes > maxBytes) {
        child.kill('SIGKILL');
        done(new MediaError('tools', 'Media output exceeded its limit.'));
        return;
      }
      output.push(buffer);
    });
    child.stderr.on('data', (buffer: Buffer) => {
      log += buffer.toString();
      if (log.length > 2 * logBytes) log = log.slice(-logBytes);
    });
    child.on('close', (code) =>
      done(
        code === 0
          ? undefined
          : new MediaError(mediaProblem(log), `exit ${code}: ${log.slice(-800)}`),
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
  /** Start time of the picture stream (V0): the zero of every read. */
  videoStart: number;
  /** The chosen audio track, as N in -map 0:a:N. */
  audioIndex: number | null;
  audioTracks: number;
  /** Sample aspect ratio (1:1 when pixels are square). */
  sar: Rational;
  interlaced: boolean;
  hdr: boolean;
  /** ffprobe format_name. */
  format: string;
  /** Set by the engine: a capture with sound on this channel only. */
  oneSided?: 'left' | 'right';
  /** Earliest start of any stream (format start_time); absent means the same as videoStart. */
  formatStart?: number;
  /** The picture stream, as N in -map 0:v:N (cover art is skipped); absent means 0. */
  videoIndex?: number;
  /** Field order when interlaced. */
  parity?: 'tff' | 'bff';
  /** Channels of the chosen audio track, and whether it has a centre (dialogue) channel. */
  channels?: number;
  centre?: boolean;
  /** Another audio track is flagged or titled as audio description. */
  describedAudio?: boolean;
};
type Disposition = Partial<
  Record<'default' | 'attached_pic' | 'comment' | 'visual_impaired' | 'hearing_impaired', number>
>;
type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  start_time?: string;
  duration?: string;
  sample_aspect_ratio?: string;
  field_order?: string;
  color_transfer?: string;
  channels?: number;
  channel_layout?: string;
  disposition?: Disposition;
  tags?: { language?: string; title?: string };
  side_data_list?: { rotation?: number }[];
};
type Probe = {
  format?: { duration?: string; format_name?: string; start_time?: string };
  streams?: ProbeStream[];
};

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

function aspect(value: string | undefined): Rational {
  const [num, den] = String(value || '')
    .split(':')
    .map(Number);
  return num > 0 && den > 0 ? { num, den } : { num: 1, den: 1 };
}

const seconds = (value: string | undefined): number | null => {
  const parsed = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(parsed) ? parsed : null;
};
const describedTitle = /descri(bed|ption)|\bdvs\b|narrat/i;
const englishLike = (language: string) =>
  ['eng', 'en'].includes(language) ? 2 : language === 'und' || !language ? 1 : 0;
const centred = /^(3\.[01]|4\.[01]|5\.|6\.[01]|7\.|hexagonal|octagonal)/;
/** Channel layouts with a front centre (dialogue) channel. */
const hasCentre = (layout: string) =>
  centred.test(layout) && !['3.0(back)', '6.0(front)', '6.1(front)'].includes(layout);

/**
 * Picks the audio track to describe against: skips commentary and description tracks, then
 * prefers the default track, English (or unlabelled) speech and more channels, in that order.
 */
export function chooseAudio(streams: ProbeStream[]): { index: number | null; described: boolean } {
  const tracks = streams
    .filter((stream) => stream.codec_type === 'audio')
    .map((stream, position) => ({
      position,
      flags: stream.disposition ?? {},
      title: stream.tags?.title ?? '',
      language: (stream.tags?.language ?? '').toLowerCase(),
      channels: stream.channels ?? 0,
    }));
  if (!tracks.length) return { index: null, described: false };
  const isDescribed = (track: (typeof tracks)[number]) =>
    !!track.flags.visual_impaired || describedTitle.test(track.title);
  const main = tracks.filter(
    (track) => !track.flags.comment && !isDescribed(track) && !/commentary/i.test(track.title),
  );
  const ranked = (main.length ? main : tracks).sort(
    (a, b) =>
      (b.flags.default ?? 0) - (a.flags.default ?? 0) ||
      englishLike(b.language) - englishLike(a.language) ||
      b.channels - a.channels ||
      a.position - b.position,
  );
  return { index: ranked[0].position, described: tracks.some(isDescribed) };
}

type Inspection = { media: Media; known: boolean; rotated: boolean };

const probeEntries = [
  'format=duration,format_name,start_time',
  'stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,r_frame_rate,start_time,duration,sample_aspect_ratio,field_order,color_transfer,channels,channel_layout',
  'stream_disposition=default,attached_pic,comment,visual_impaired,hearing_impaired',
  'stream_tags=language,title',
  'stream_side_data_list',
].join(':');

/** Reads the file's headers: streams, timing, geometry and track choice. Seconds may be NaN. */
async function inspect(file: string, signal: AbortSignal): Promise<Inspection> {
  let raw: Buffer;
  try {
    raw = await command(
      ffprobe(),
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-format_whitelist',
        [...videoFormats, ...audioFormats].join(','),
        '-show_entries',
        probeEntries,
        '-of',
        'json',
        file,
      ],
      signal,
      undefined,
      4 * 1024 ** 2,
    );
  } catch (error) {
    if (error instanceof MediaError && error.kind === 'tools')
      throw new MediaError('damaged', error.detail);
    throw error;
  }
  let data: Probe;
  try {
    data = JSON.parse(raw.toString());
  } catch {
    throw new MediaError('damaged', 'ffprobe returned unreadable output');
  }
  const streams = data.streams ?? [];
  const videos = streams.filter((stream) => stream.codec_type === 'video');
  const video = videos.find(
    (stream) => (stream.width || 0) > 0 && !stream.disposition?.attached_pic,
  );
  if (!video)
    throw new MediaError(
      videos.some((stream) => stream.disposition?.attached_pic) ? 'cover-art' : 'no-video',
    );
  const format = data.format?.format_name ?? '';
  if (!format.split(',').some((name) => videoFormats.includes(name)))
    throw new MediaError('format', `format ${format}`);
  const audio = chooseAudio(streams);
  const track =
    audio.index === null ? undefined : streams.filter((s) => s.codec_type === 'audio')[audio.index];
  const videoStart = seconds(video.start_time) ?? 0;
  const formatStart = Math.min(seconds(data.format?.start_time) ?? videoStart, videoStart);
  const durations = streams.map((stream) => seconds(stream.duration) ?? 0);
  const whole = seconds(data.format?.duration) ?? (Math.max(0, ...durations) || null);
  /** Length on the picture's clock: a video that starts after the sound has that much less. */
  const total =
    whole === null
      ? null
      : Math.max(0, (seconds(data.format?.start_time) ?? videoStart) + whole - videoStart);
  const order = video.field_order ?? '';
  const interlaced = ['tt', 'bb', 'tb', 'bt'].includes(order);
  return {
    known: order !== '' && order !== 'unknown',
    rotated: (video.side_data_list ?? []).some((item) => !!item.rotation),
    media: {
      seconds: total ?? Number.NaN,
      audio: audio.index !== null,
      width: video.width || 0,
      height: video.height || 0,
      fps: frameRate(video),
      codec: video.codec_name || '',
      pixels: video.pix_fmt || '',
      videoStart,
      audioIndex: audio.index,
      audioTracks: streams.filter((stream) => stream.codec_type === 'audio').length,
      sar: aspect(video.sample_aspect_ratio),
      interlaced,
      hdr: ['smpte2084', 'arib-std-b67'].includes(video.color_transfer ?? ''),
      format,
      formatStart,
      videoIndex: videos.indexOf(video),
      ...(interlaced ? { parity: order === 'bb' || order === 'bt' ? 'bff' : 'tff' } : {}),
      ...(track
        ? {
            channels: track.channels ?? 0,
            centre: hasCentre(track.channel_layout ?? ''),
          }
        : {}),
      ...(audio.described ? { describedAudio: true } : {}),
    },
  };
}

const lastValue = (pattern: RegExp, text: string): number => {
  const matches = [...text.matchAll(pattern)];
  return matches.length ? Number(matches[matches.length - 1][1]) : Number.NaN;
};

/** Length of a file whose headers carry none (a WebM written to a pipe), by reading its packets. */
async function measure(file: string, media: Media, signal: AbortSignal): Promise<number> {
  const { stdout } = await execute(
    ffmpeg(),
    [
      ...quiet,
      ...sourceOnly,
      '-i',
      file,
      '-map',
      `0:v:${media.videoIndex ?? 0}`,
      '-c',
      'copy',
      '-progress',
      'pipe:1',
      '-f',
      'null',
      '-',
    ],
    signal,
    undefined,
    8 * 1024 ** 2,
  );
  const micro = lastValue(/out_time_us=(\d+)/g, stdout.toString());
  if (!Number.isFinite(micro)) throw new MediaError('damaged', 'no packet times');
  return micro / 1e6;
}

export type Capabilities = {
  version: string;
  zscale: boolean;
  bwdif: boolean;
  scdet: boolean;
  freezedetect: boolean;
  limiterLatency: boolean;
  perChannel: boolean;
};
let toolCheck: { bin: string; result: Promise<Capabilities> } | null = null;
let reported = false;

async function checkTools(bin: string): Promise<Capabilities> {
  const signal = AbortSignal.timeout(60000);
  const text = async (args: string[]) =>
    (await command(bin, ['-hide_banner', ...args], signal, undefined, 4 * 1024 ** 2)).toString();
  const [version, filters, limiter, stats] = await Promise.all([
    text(['-version']),
    text(['-filters']),
    text(['-h', 'filter=alimiter']),
    text(['-h', 'filter=astats']),
  ]);
  const names = new Set([...filters.matchAll(/^\s*[A-Z.|]{2,3}\s+(\w+)\s/gm)].map((m) => m[1]));
  return {
    version: version.split('\n')[0].trim(),
    zscale: names.has('zscale'),
    bwdif: names.has('bwdif'),
    scdet: names.has('scdet'),
    freezedetect: names.has('freezedetect'),
    limiterLatency: /\blatency\b/.test(limiter),
    perChannel: /measure_perchannel/.test(stats),
  };
}

/**
 * What the installed ffmpeg can do, checked once per process. The first caller that passes
 * `log` gets one line naming the version and any missing filter; missing filters degrade.
 */
export async function capabilities(log?: (message: string) => void): Promise<Capabilities> {
  const bin = ffmpeg();
  if (!toolCheck || toolCheck.bin !== bin) toolCheck = { bin, result: checkTools(bin) };
  const current = toolCheck;
  let result: Capabilities;
  try {
    result = await current.result;
  } catch (error) {
    if (toolCheck === current) toolCheck = null;
    throw error;
  }
  if (log && !reported) {
    reported = true;
    const missing: string[] = [
      ...(['zscale', 'bwdif', 'scdet', 'freezedetect'] as const).filter((name) => !result[name]),
      ...(result.limiterLatency ? [] : ['alimiter latency']),
      ...(result.perChannel ? [] : ['astats per channel']),
    ];
    log(`Media tools: ${result.version}; missing: ${missing.length ? missing.join(', ') : 'none'}`);
  }
  return result;
}

/** The deinterlacer: always on for frames flagged interlaced, and for every frame of a known interlaced source. */
export function deinterlace(media: Media, tools: Capabilities): string {
  const filter = tools.bwdif ? 'bwdif' : 'yadif';
  return media.interlaced
    ? `${filter}=mode=send_frame:parity=${media.parity ?? 'auto'}:deint=all`
    : `${filter}=mode=send_frame:deint=interlaced`;
}

/**
 * Square pixels at most `width` wide with even sides and the source's display shape, then 8-bit
 * 4:2:0, tone-mapped to standard range when the source is HDR and zscale is available.
 */
export function shape(media: Media, tools: Capabilities, width: number): string[] {
  return [
    `scale=w='trunc(min(${width},iw*sar)/2)*2':h='trunc(ow/dar/2)*2':flags=bicubic`,
    'setsar=1',
    ...(media.hdr && tools.zscale
      ? [
          'zscale=t=linear:npl=100',
          'format=gbrpf32le',
          'zscale=p=bt709',
          'tonemap=hable:desat=0',
          'zscale=t=bt709:m=bt709:r=tv',
        ]
      : []),
    'format=yuv420p',
  ];
}
const colourTags = (media: Media, tools: Capabilities): string[] =>
  media.hdr && tools.zscale
    ? ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709']
    : [];

/** Decodes the first seconds, so a damaged file fails at the free check; also detects interlacing. */
async function trial(
  file: string,
  media: Media,
  detect: boolean,
  signal: AbortSignal,
): Promise<Media> {
  const tools = await capabilities();
  const filters = [
    ...(detect ? ['idet'] : []),
    deinterlace(media, tools),
    ...shape(media, tools, 320),
  ];
  const { stdout, log } = await execute(
    ffmpeg(),
    [
      ...loud,
      '-protocol_whitelist',
      'file,pipe',
      ...sourceOnly,
      ...inputThreads(),
      '-t',
      '3',
      '-i',
      file,
      '-map',
      `0:v:${media.videoIndex ?? 0}`,
      ...(media.audioIndex === null ? [] : ['-map', `0:a:${media.audioIndex}`]),
      '-vf',
      filters.join(','),
      ...outputThreads(),
      '-progress',
      'pipe:1',
      '-f',
      'null',
      '-',
    ],
    signal,
    undefined,
    4 * 1024 ** 2,
  );
  if (!(lastValue(/^frame=(\d+)/gm, stdout.toString()) > 0))
    throw new MediaError('damaged', `no frames decoded: ${log.slice(-800)}`);
  const found = [
    ...log.matchAll(/Multi frame detection: TFF:\s*(\d+)\s*BFF:\s*(\d+)\s*Progressive:\s*(\d+)/g),
  ].pop();
  if (!found) return media;
  const [tff, bff, progressive] = found.slice(1).map(Number);
  const [top, other] = tff >= bff ? [tff, bff] : [bff, tff];
  if (top < 20 || top < 4 * (other + progressive)) return media;
  return { ...media, interlaced: true, parity: tff >= bff ? 'tff' : 'bff' };
}

async function examine(file: string, signal: AbortSignal): Promise<Inspection> {
  const found = await inspect(file, signal);
  const length = Number.isFinite(found.media.seconds)
    ? found.media.seconds
    : await measure(file, found.media, signal);
  if (length < 0.2) throw new MediaError('too-short', `duration ${length}`);
  return { ...found, media: { ...found.media, seconds: length } };
}

async function check(file: string, signal: AbortSignal): Promise<Inspection> {
  const found = await examine(file, signal);
  const detect = !found.known && found.media.height <= 576;
  return { ...found, media: await trial(file, found.media, detect, signal) };
}

/**
 * Checks a source: allowed container, a real picture stream (cover art does not count), a length,
 * and a short decode of its opening. Failures are MediaError with plain words.
 */
export async function probe(file: string, signal: AbortSignal): Promise<Media> {
  return (await check(file, signal)).media;
}

/** True when the original picture can be kept as it is, with only the soundtrack replaced. */
export const copyable = (media: Media): boolean =>
  media.codec === 'h264' && ['yuv420p', 'yuvj420p'].includes(media.pixels) && media.width <= 1920;

const anchorOf = (media: Media, start: number) => media.videoStart + start;
/** Seeks so the read starts at picture time `start`; no seek at all for the opening. */
const seekTo = (media: Media, start: number): string[] => {
  if (start <= 0) return [];
  const offset = start + media.videoStart - (media.formatStart ?? media.videoStart);
  return ['-ss', Math.max(0, offset).toFixed(6)];
};
const pictureClock = (media: Media, start: number) =>
  `setpts=PTS-(${anchorOf(media, start).toFixed(6)})/TB`;
const soundTimes = (media: Media, start: number) =>
  `asetpts=PTS-(${anchorOf(media, start).toFixed(6)})/TB`;
const soundFill = (rate: number) => `aresample=${rate}:async=1:first_pts=0`;
/** Puts sound on the picture's clock: late starts and holes become silence, early sound is cut. */
const soundClock = (media: Media, start: number, rate: number = sampleRate) =>
  `${soundTimes(media, start)},${soundFill(rate)}`;
const oneSidedPan = (media: Media): string[] =>
  media.oneSided
    ? [
        `pan=stereo|c0=${media.oneSided === 'left' ? 'c0' : 'c1'}|c1=${media.oneSided === 'left' ? 'c0' : 'c1'}`,
      ]
    : [];

const mediaOf = async (source: string, media: Media | undefined, signal: AbortSignal) =>
  media ?? (await inspect(source, signal)).media;

export type Momentary = { time: number; lufs: number };

/**
 * Parses ebur128 momentary loudness printed by ametadata. Each 100 ms frame's value covers the
 * 400 ms ending with that frame; `time` is the centre of that block, and blocks not yet full are left out.
 */
export function momentaryBlocks(text: string): Momentary[] {
  const blocks: Momentary[] = [];
  let time = Number.NaN;
  for (const line of text.split('\n')) {
    const at = /pts_time:(\S+)/.exec(line);
    if (at) {
      time = Number(at[1]);
      continue;
    }
    const value = /^lavfi\.r128\.M=(\S+)/.exec(line.trim());
    if (!value || !Number.isFinite(time)) continue;
    const lufs = Number(value[1]);
    if (Number.isFinite(lufs) && time >= 0.3 - 1e-6)
      blocks.push({
        time: Math.round((time - 0.1) * 1000) / 1000,
        lufs: Math.round(lufs * 100) / 100,
      });
  }
  return blocks;
}

/** RMS level (dB) of each channel from an astats log, in channel order. */
export function channelLevels(log: string): number[] {
  const levels: number[] = [];
  let channel = -1;
  for (const line of log.split('\n')) {
    if (!line.includes('astats')) continue;
    const heading = /Channel: (\d+)/.exec(line);
    if (heading) {
      channel = Number(heading[1]) - 1;
      continue;
    }
    if (/Overall/.test(line)) channel = -1;
    const level = /RMS level dB: (-?[\d.]+|-inf)/.exec(line);
    if (level && channel >= 0 && levels[channel] === undefined)
      levels[channel] = level[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(level[1]);
  }
  return levels;
}

/** The live channel of a stereo capture whose other channel is more than 20 dB quieter. */
export function liveChannel(levels: number[]): 'left' | 'right' | undefined {
  if (levels.length !== 2) return undefined;
  const [left, right] = levels;
  if (!(Math.max(left, right) > -60)) return undefined;
  if (left - right > 20) return 'left';
  if (right - left > 20) return 'right';
  return undefined;
}

/**
 * Scene cuts and still stretches (freezes of 5 s or more) from what scdet and freezedetect print;
 * a still that runs to the end closes at `end`.
 */
export function pictureEvents(
  printed: string,
  end: number,
): { cuts: number[]; stills: Interval[] } {
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const values = (key: string) =>
    [...printed.matchAll(new RegExp(`lavfi\\.${key}[:=]\\s*(-?[\\d.]+)`, 'g'))]
      .map((match) => Number(match[1]))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
  const cuts = [...new Set(values('scd\\.time').map(round))].filter((value) => value > 0);
  const ends = values('freezedetect\\.freeze_end');
  const stills: Interval[] = values('freezedetect\\.freeze_start').flatMap((start) => {
    const stop = ends.find((value) => value > start) ?? end;
    return Number.isFinite(stop) && stop > start
      ? [{ start: round(Math.max(0, start)), end: round(stop) }]
      : [];
  });
  return { cuts, stills };
}

export type Soundtrack = {
  /** Mono 16 kHz copy for speech recognition, on the picture's clock ('' when there is no sound). */
  dialogue: string;
  program: number;
  peak: number;
  lra?: number;
  /** Momentary loudness every 100 ms; `time` is the centre of each 400 ms block. */
  momentary?: Momentary[];
  cuts?: number[];
  stills?: Interval[];
  oneSided?: 'left' | 'right';
};

async function soundtrackPass(
  source: string,
  directory: string,
  signal: AbortSignal,
  media: Media,
  tools: Capabilities,
  watch: boolean,
): Promise<Soundtrack & { levels: number[] }> {
  const hasSound = media.audioIndex !== null;
  const dialogue = join(directory, 'dialogue.m4a');
  const momentaryFile = 'momentary.txt';
  const stereo = ['aformat=channel_layouts=stereo', ...oneSidedPan(media)];
  const speech = media.centre
    ? ['pan=mono|c0=FC+0.3*FL+0.3*FR']
    : [...stereo, 'pan=mono|c0=0.5*c0+0.5*c1'];
  const printed = ['cuts.txt', 'still-start.txt', 'still-end.txt'];
  const print = (key: string, file: string) => `metadata=mode=print:key=lavfi.${key}:file=${file}`;
  const scan = [
    ...(tools.scdet ? ['scdet=threshold=10', print('scd.time', printed[0])] : []),
    ...(tools.freezedetect
      ? [
          'freezedetect=n=0.003:d=5',
          print('freezedetect.freeze_start', printed[1]),
          print('freezedetect.freeze_end', printed[2]),
        ]
      : []),
  ];
  const video = watch && scan.length > 0;
  const graph = [
    ...(hasSound
      ? [
          `[0:a:${media.audioIndex}]${soundTimes(media, 0)},asplit=2[a0][a1]`,
          `[a0]${[
            soundFill(48000),
            ...stereo,
            tools.perChannel
              ? 'astats=measure_perchannel=RMS_level:measure_overall=none'
              : 'astats',
            'ebur128=peak=sample:framelog=quiet:metadata=1',
            `ametadata=mode=print:key=lavfi.r128.M:file=${momentaryFile}`,
          ].join(',')}[m]`,
          `[a1]${[soundFill(48000), ...speech, 'aresample=16000'].join(',')}[s]`,
        ]
      : []),
    ...(video
      ? [
          `[0:v:${media.videoIndex ?? 0}]${pictureClock(media, 0)},scale=160:-2,${scan.join(',')}[v]`,
        ]
      : []),
  ];
  if (!graph.length) return { dialogue: '', program: -70, peak: -70, levels: [] };
  const { log } = await execute(
    ffmpeg(),
    [
      ...loud,
      '-protocol_whitelist',
      'file,pipe',
      ...sourceOnly,
      ...inputThreads(),
      ...(video ? ['-skip_loop_filter', 'all'] : []),
      '-copyts',
      '-i',
      resolve(source),
      '-filter_complex',
      graph.join(';'),
      ...(hasSound ? ['-map', '[m]'] : []),
      ...(video ? ['-map', '[v]'] : []),
      ...outputThreads(true),
      '-f',
      'null',
      '-',
      ...(hasSound
        ? [
            '-map',
            '[s]',
            '-c:a',
            'aac',
            '-b:a',
            '48k',
            ...outputThreads(true),
            '-movflags',
            '+faststart',
            resolve(dialogue),
          ]
        : []),
    ],
    signal,
    undefined,
    32 * 1024 ** 2,
    { cwd: directory, logBytes: 1024 ** 2 },
  );
  const texts = await Promise.all(
    printed.map(async (name) => {
      const path = join(directory, name);
      const text = await readFile(path, 'utf8').catch(() => '');
      await rm(path, { force: true });
      return text;
    }),
  );
  const events = video ? pictureEvents(texts.join('\n'), media.seconds) : {};
  if (!hasSound) return { dialogue: '', program: -70, peak: -70, levels: [], ...events };
  const summary = log.slice(log.lastIndexOf('Summary:'));
  const program = Number(/I:\s*(-?[\d.]+|-inf) LUFS/.exec(summary)?.[1]);
  const peak = Number(/Peak:\s*(-?[\d.]+|-inf) dBFS/.exec(summary)?.[1]);
  const lra = Number(/LRA:\s*(-?[\d.]+) LU\b/.exec(summary)?.[1]);
  const momentaryPath = join(directory, momentaryFile);
  const momentary = momentaryBlocks(await readFile(momentaryPath, 'utf8').catch(() => ''));
  await rm(momentaryPath, { force: true });
  return {
    dialogue,
    program: Number.isFinite(program) ? program : -70,
    peak: Number.isFinite(peak) ? peak : -70,
    ...(Number.isFinite(lra) ? { lra } : {}),
    momentary,
    ...events,
    levels: channelLevels(log),
  };
}

/**
 * One pass over the whole source on the picture's clock: the soundtrack's loudness (integrated,
 * peak, range and momentary blocks), the mono copy speech recognition reads (centre channel first
 * for surround), a small picture scan for scene cuts and still stretches, and a check for
 * captures with sound on one channel only (measured again with that channel on both sides).
 */
export async function soundtrack(
  source: string,
  directory: string,
  signal: AbortSignal,
  media?: Media,
): Promise<Soundtrack> {
  const info = await mediaOf(source, media, signal);
  const tools = await capabilities();
  const first = await soundtrackPass(source, directory, signal, info, tools, true);
  const { levels, ...result } = first;
  const live =
    info.oneSided || info.centre || (info.channels ?? 2) !== 2 ? undefined : liveChannel(levels);
  if (!live) return info.oneSided ? { ...result, oneSided: info.oneSided } : result;
  const again = await soundtrackPass(
    source,
    directory,
    signal,
    { ...info, oneSided: live },
    tools,
    false,
  );
  const { levels: _unused, cuts: _cuts, stills: _stills, ...measured } = again;
  return {
    ...measured,
    ...(result.cuts ? { cuts: result.cuts } : {}),
    ...(result.stills ? { stills: result.stills } : {}),
    oneSided: live,
  };
}

const clipLimit = 40 * 1024 ** 2;

/**
 * Video bitrate ceiling (bits/s) that keeps an analysis clip of `outputSeconds` under about 38 MB
 * with its 48 kbit/s sound, and never above 600 kbit/s. crf still decides below the ceiling.
 */
export function videoCeiling(outputSeconds: number): number {
  const budget = (38 * 1024 ** 2 * 8) / Math.max(1, outputSeconds) - 48000;
  return Math.max(100000, Math.floor(Math.min(600000, budget)));
}

/** Analysis frame rate: 8 fps for clips of 20 s or less (idents, bumpers), otherwise 3. */
export const lookRate = (seconds: number): number => (seconds <= 20 ? 8 : 3);

/** A small copy of one section, with sound, for the vision model to watch and hear. */
export async function sectionClip(
  source: string,
  directory: string,
  start: number,
  seconds: number,
  signal: AbortSignal,
  closeLook: boolean = false,
  media?: Media,
): Promise<string> {
  const info = await mediaOf(source, media, signal);
  const tools = await capabilities();
  const video = join(directory, 'analysis.mp4');
  const outputSeconds = closeLook ? seconds * 4 : seconds;
  const ceiling = videoCeiling(outputSeconds);
  const encode = async (width: number) => {
    const picture = [
      pictureClock(info, start),
      deinterlace(info, tools),
      `fps=${closeLook ? 4 : lookRate(seconds)}:start_time=0`,
      ...shape(info, tools, width),
      `trim=end=${seconds.toFixed(6)}`,
      ...(closeLook ? ['setpts=4*PTS'] : []),
    ];
    const sound = [
      soundClock(info, start, 48000),
      ...(info.oneSided ? ['aformat=channel_layouts=stereo', ...oneSidedPan(info)] : []),
      `atrim=end=${seconds.toFixed(6)}`,
      ...(closeLook ? ['atempo=0.5', 'atempo=0.5'] : []),
    ];
    await command(
      ffmpeg(),
      [
        ...quiet,
        ...sourceOnly,
        ...inputThreads(),
        '-copyts',
        ...seekTo(info, start),
        '-i',
        source,
        '-map',
        `0:v:${info.videoIndex ?? 0}`,
        ...(info.audioIndex === null
          ? []
          : ['-map', `0:a:${info.audioIndex}`, '-af', sound.join(',')]),
        '-vf',
        picture.join(','),
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '28',
        '-maxrate',
        String(ceiling),
        '-bufsize',
        String(ceiling * 2),
        '-profile:v',
        'high',
        '-pix_fmt',
        'yuv420p',
        ...colourTags(info, tools),
        '-c:a',
        'aac',
        '-ac',
        '1',
        '-b:a',
        '48k',
        ...outputThreads(),
        '-movflags',
        '+faststart',
        video,
      ],
      signal,
    );
    return (await stat(video)).size;
  };
  const width = closeLook ? 1440 : 960;
  if ((await encode(width)) <= clipLimit) return video;
  if ((await encode(closeLook ? 960 : 640)) <= clipLimit) return video;
  await rm(video, { force: true });
  throw new MediaError(
    'too-detailed',
    `clip over ${clipLimit} bytes`,
    closeLook
      ? 'This part of the video is too detailed to send for a close look.'
      : plainWords['too-detailed'],
  );
}

const floats = (buffer: Buffer): Float32Array =>
  new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
const bytes = (pcm: Float32Array): Buffer =>
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);

/** The section's own soundtrack as 48 kHz interleaved stereo on the picture's clock, exactly `frames` long. */
export async function sectionSound(
  source: string,
  directory: string,
  start: number,
  frames: number,
  hasAudio: boolean,
  signal: AbortSignal,
  media?: Media,
): Promise<Float32Array> {
  const out = new Float32Array(frames * 2);
  if (!hasAudio) return out;
  const info = await mediaOf(source, media, signal);
  if (info.audioIndex === null) return out;
  const file = join(directory, 'sound.f32');
  await command(
    ffmpeg(),
    [
      ...quiet,
      ...sourceOnly,
      ...inputThreads(),
      '-copyts',
      ...seekTo(info, start),
      '-i',
      source,
      '-map',
      `0:a:${info.audioIndex}`,
      '-af',
      [
        soundClock(info, start),
        'aformat=channel_layouts=stereo',
        ...oneSidedPan(info),
        'aformat=sample_fmts=flt:channel_layouts=stereo',
        `atrim=end_sample=${frames}`,
      ].join(','),
      ...outputThreads(),
      '-f',
      'f32le',
      file,
    ],
    signal,
  );
  const decoded = floats(await readFile(file));
  out.set(decoded.subarray(0, Math.min(decoded.length, out.length)));
  await rm(file, { force: true });
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
  const tools = await capabilities();
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
      `alimiter=limit=0.891:attack=5:release=80:level=false${tools.limiterLatency ? ':latency=true' : ''}`,
      '-c:a',
      'flac',
      '-sample_fmt',
      's32',
      file,
    ],
    signal,
  );
  await rm(raw, { force: true });
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
  media?: Media,
): Promise<string> {
  const info = await mediaOf(source, media, signal);
  const tools = await capabilities();
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
  const base = [
    pictureClock(info, start),
    deinterlace(info, tools),
    `fps=${rate}:start_time=0`,
    ...shape(info, tools, 1280),
    `trim=end_frame=${frames}`,
  ];
  const filters = [
    `[0:v:${info.videoIndex ?? 0}]${base.join(',')}[base]`,
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
      ...sourceOnly,
      ...inputThreads(),
      '-copyts',
      ...seekTo(info, start),
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
      ...colourTags(info, tools),
      ...outputThreads(true),
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

/**
 * Makes the working copy every later step reads. Without a range: the chosen picture and sound
 * tracks remuxed with generated timestamps (MKV, or MP4 for rotated phone video), which fixes
 * AVI/FLV openings and MPEG-PS/TS drift; the original is used if the remux fails. With a range:
 * an accurate cut re-timed to start at 0, re-encoded as square-pixel progressive 8-bit H.264 of
 * at most 1920 px with FLAC sound. Returns the working file's media.
 */
export async function normalize(
  source: string,
  directory: string,
  signal: AbortSignal,
  range?: Interval,
  log?: (message: string) => void,
): Promise<{ file: string; media: Media }> {
  await capabilities(log);
  const { media: original, rotated } = await check(source, signal);
  if (original.describedAudio)
    log?.('The source also has an audio description track; the main soundtrack is used.');
  if (range) return cut(source, directory, original, range, signal);
  const file = join(directory, rotated ? 'working.mp4' : 'working.mkv');
  const base = [
    ...quiet,
    ...sourceOnly,
    '-fflags',
    '+genpts',
    '-i',
    source,
    '-map',
    `0:v:${original.videoIndex ?? 0}`,
    ...(original.audioIndex === null ? [] : ['-map', `0:a:${original.audioIndex}`]),
    '-dn',
    '-sn',
    '-map_chapters',
    '-1',
    '-c:v',
    'copy',
  ];
  const attempts = [
    [...base, '-c:a', 'copy', file],
    [...base, ...(rotated ? ['-c:a', 'aac', '-b:a', '256k'] : ['-c:a', 'flac']), file],
  ];
  for (const args of attempts) {
    try {
      await command(ffmpeg(), args, signal);
      const working = (await examine(file, signal)).media;
      if (
        working.seconds < original.seconds - Math.max(1, original.seconds * 0.02) ||
        working.audio !== original.audio
      )
        continue;
      return {
        file,
        media: {
          ...working,
          fps: original.fps,
          sar: original.sar,
          interlaced: original.interlaced,
          ...(original.parity ? { parity: original.parity } : {}),
          hdr: original.hdr,
          ...(original.describedAudio ? { describedAudio: true } : {}),
        },
      };
    } catch (error) {
      if (signal.aborted) throw error;
    }
  }
  await rm(file, { force: true });
  log?.('The working copy could not be made; the original file is read directly.');
  return { file: source, media: original };
}

async function cut(
  source: string,
  directory: string,
  original: Media,
  range: Interval,
  signal: AbortSignal,
): Promise<{ file: string; media: Media }> {
  const start = Math.max(0, range.start);
  const end = Math.min(range.end, original.seconds);
  if (end - start < 0.2)
    throw new MediaError(
      'too-short',
      `range ${start}-${end} of ${original.seconds}`,
      'The part to describe is outside the video.',
    );
  const tools = await capabilities();
  const length = (end - start).toFixed(6);
  const file = join(directory, 'working.mkv');
  const picture = [
    pictureClock(original, start),
    deinterlace(original, tools),
    ...shape(original, tools, 1920),
    `trim=end=${length}`,
  ];
  const sound = [soundClock(original, start, 48000), `atrim=end=${length}`];
  await command(
    ffmpeg(),
    [
      ...quiet,
      ...sourceOnly,
      ...inputThreads(),
      '-copyts',
      ...seekTo(original, start),
      '-i',
      source,
      '-map',
      `0:v:${original.videoIndex ?? 0}`,
      ...(original.audioIndex === null
        ? []
        : ['-map', `0:a:${original.audioIndex}`, '-af', sound.join(','), '-c:a', 'flac']),
      '-vf',
      picture.join(','),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '18',
      '-profile:v',
      'high',
      '-pix_fmt',
      'yuv420p',
      ...colourTags(original, tools),
      '-dn',
      '-sn',
      '-map_chapters',
      '-1',
      ...outputThreads(),
      file,
    ],
    signal,
  );
  const working = (await examine(file, signal)).media;
  return {
    file,
    media: {
      ...working,
      fps: original.fps,
      ...(original.describedAudio ? { describedAudio: true } : {}),
    },
  };
}

const listFile = (files: string[]) =>
  files.map((file) => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');

/** Cuts text to at most `max` code points, so an emoji is never split into a broken half. */
export const clip = (text: string, max: number): string => Array.from(text).slice(0, max).join('');
const oneLine = (text: string) =>
  text
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, '')
    .replace(/[\s\u0000-\u001f\u007f]+/g, ' ')
    .trim();

/** A title of at most 200 code points that keeps a trailing " (described)". */
export function titleTag(title: string): string {
  const text = oneLine(title);
  const suffix = / \(described\)$/.exec(text)?.[0] ?? '';
  return clip(text.slice(0, text.length - suffix.length), 200 - suffix.length) + suffix;
}

const twoLetter: Record<string, string> = {
  en: 'eng',
  es: 'spa',
  fr: 'fra',
  de: 'deu',
  it: 'ita',
  pt: 'por',
  nl: 'nld',
  sv: 'swe',
  da: 'dan',
  no: 'nor',
  nb: 'nob',
  fi: 'fin',
  pl: 'pol',
  ru: 'rus',
  uk: 'ukr',
  ja: 'jpn',
  ko: 'kor',
  zh: 'zho',
  hi: 'hin',
  ar: 'ara',
  tr: 'tur',
  el: 'ell',
  he: 'heb',
  vi: 'vie',
  id: 'ind',
};
/** The ISO 639-2 code an MP4 track language needs, from a BCP 47 tag such as "en" or "en-US". */
export function trackLanguage(tag: string): string {
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  if (/^[a-z]{3}$/.test(primary)) return primary;
  return twoLetter[primary] ?? 'und';
}

const metaValue = (text: string) => oneLine(text).replace(/[=;#\\]/g, '\\$&');

async function lengthOf(file: string, signal: AbortSignal): Promise<number> {
  const raw = await command(
    ffprobe(),
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    signal,
  );
  return Number(raw.toString().trim());
}

/** An ffmetadata chapter list for a file of `total` seconds, or null when no chapter fits. */
export function chapterMetadata(chapters: Chapter[], total: number): string | null {
  const list = chapters
    .filter((item) => Number.isFinite(item.start) && item.start >= 0 && item.start < total - 0.5)
    .sort((a, b) => a.start - b.start)
    .filter(
      (item, i, all) =>
        i === 0 || Math.round(item.start * 1000) !== Math.round(all[i - 1].start * 1000),
    );
  if (!list.length) return null;
  return [
    ';FFMETADATA1',
    ...list.flatMap((item, i) => [
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      `START=${Math.round(item.start * 1000)}`,
      `END=${Math.round((list[i + 1]?.start ?? total) * 1000)}`,
      `title=${metaValue(clip(item.title, 120)) || `Chapter ${i + 1}`}`,
    ]),
    '',
  ].join('\n');
}

export type Subtitle = { file: string; language: string; title: string };
export type AssembleOptions = { media?: Media; subtitles?: Subtitle[]; chapters?: Chapter[] };

/**
 * Joins the finished sections: one AAC soundtrack for both files, and either the original
 * picture untouched or the re-encoded sections with their pauses. Optional text tracks go into
 * the MP4 as mov_text, and chapters (output times) into both files.
 */
export async function assemble(
  directory: string,
  sounds: string[],
  pictures: string[] | null,
  source: string,
  title: string,
  signal: AbortSignal,
  options: AssembleOptions = {},
): Promise<{ video: string; audio: string }> {
  const soundList = join(directory, 'sounds.txt');
  await writeFile(soundList, listFile(sounds));
  const audio = join(directory, 'described.m4a');
  const video = join(directory, 'described.mp4');
  const tag = ['-metadata', `title=${titleTag(title)}`];
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
  const metadata = options.chapters?.length
    ? chapterMetadata(options.chapters, await lengthOf(audio, signal))
    : null;
  const chapters = metadata ? join(directory, 'chapters.txt') : null;
  if (chapters && metadata) {
    await writeFile(chapters, metadata);
    const marked = join(directory, 'described-chapters.m4a');
    await command(
      ffmpeg(),
      [
        ...quiet,
        '-i',
        audio,
        '-i',
        chapters,
        '-map',
        '0:a',
        '-map_chapters',
        '1',
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        marked,
      ],
      signal,
    );
    await rename(marked, audio);
  }
  const copy = !pictures;
  const picture = pictures ? join(directory, 'pictures.txt') : source;
  if (pictures) await writeFile(picture, listFile(pictures));
  const media = options.media;
  const offset =
    copy && media ? Math.max(0, media.videoStart - (media.formatStart ?? media.videoStart)) : 0;
  const shift = offset > 0.0005 ? ['-itsoffset', offset.toFixed(6)] : [];
  const subtitles = options.subtitles ?? [];
  await command(
    ffmpeg(),
    [
      ...quiet,
      ...(pictures ? ['-f', 'concat', '-safe', '0'] : sourceOnly),
      '-i',
      picture,
      ...shift,
      '-i',
      audio,
      ...subtitles.flatMap((item) => [...shift, '-i', item.file]),
      ...(chapters ? ['-i', chapters] : []),
      '-map',
      `0:v:${copy ? (media?.videoIndex ?? 0) : 0}`,
      '-map',
      '1:a:0',
      ...subtitles.flatMap((_, i) => ['-map', `${2 + i}:s:0`]),
      '-map_chapters',
      chapters ? String(2 + subtitles.length) : '-1',
      '-c:v',
      'copy',
      '-c:a',
      'copy',
      ...(subtitles.length ? ['-c:s', 'mov_text'] : []),
      ...subtitles.flatMap((item, i) => [
        `-metadata:s:s:${i}`,
        `language=${trackLanguage(item.language)}`,
        `-metadata:s:s:${i}`,
        `handler_name=${oneLine(item.title)}`,
        `-metadata:s:s:${i}`,
        `title=${oneLine(item.title)}`,
      ]),
      ...tag,
      '-movflags',
      '+faststart',
      video,
    ],
    signal,
  );
  return { video, audio };
}
