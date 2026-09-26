import { z } from 'zod';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { Chapter } from './types';
import { spokenLength } from './transcript';
import { cleanLabel } from './text';
import { command, ffmpeg } from './media';

/** One YouTube video as its id and plain watch link, or why the text is not one. */
export type YouTubeLink =
  { id: string; url: string } | { problem: 'not-link' | 'not-youtube' | 'not-video' };

const youtubeHosts = [
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
];

/**
 * Reads a pasted link as one YouTube video. Watch, youtu.be, Shorts, embed, live, mobile and
 * YouTube Music links all come back as https://www.youtube.com/watch?v=ID, so a playlist, radio
 * mix or start time riding on the link (list=, index=, start_radio=, t=) is dropped and exactly
 * one video is ever fetched. A link pasted without https:// is read as if it had it.
 */
export function readYouTubeLink(value: string): YouTubeLink {
  const text = String(value ?? '').trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return { problem: 'not-link' };
  }
  if (
    !text ||
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port
  )
    return { problem: 'not-link' };
  const host = url.hostname.toLowerCase();
  let id: string | null | undefined = null;
  if (host === 'youtu.be' || host === 'www.youtu.be') id = url.pathname.split('/')[1];
  else if (youtubeHosts.includes(host)) {
    if (url.pathname === '/watch' || url.pathname === '/watch/') id = url.searchParams.get('v');
    else if (/^\/(shorts|embed|live|v)\//.test(url.pathname)) id = url.pathname.split('/')[2];
  } else return { problem: 'not-youtube' };
  if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return { problem: 'not-video' };
  return { id, url: `https://www.youtube.com/watch?v=${id}` };
}

export function youtubeURL(value: string): string {
  const link = readYouTubeLink(value);
  if ('url' in link) return link.url;
  throw new Error(
    link.problem === 'not-link'
      ? 'Enter a YouTube video link.'
      : 'Enter a single YouTube video link, not a channel or playlist.',
  );
}

const viaLibrary =
  'download it with TubeVault, add it to your Library, then describe it from there';

export type YouTubeProblem = {
  kind: string;
  message: string;
  /** No other player client will get a different answer, so stop trying at once. */
  permanent: boolean;
};

const problems: (YouTubeProblem & { pattern: RegExp })[] = [
  {
    kind: 'private',
    pattern: /private video|video is private/i,
    permanent: true,
    message: `This YouTube video is private, so the server cannot get it. If you can watch it, ${viaLibrary}.`,
  },
  {
    kind: 'copyright',
    pattern: /copyright/i,
    permanent: true,
    message:
      'YouTube has blocked this video over a copyright claim, so the server cannot get it. If you have a copy, upload the file instead.',
  },
  {
    kind: 'removed',
    pattern:
      /has been removed|been terminated|account .{0,40}closed|video has been deleted|no longer available/i,
    permanent: true,
    message: 'This YouTube video has been removed, or its channel was closed.',
  },
  {
    kind: 'age',
    pattern: /confirm your age|age[- ]restricted|inappropriate for some users/i,
    permanent: false,
    message: `This YouTube video is age-restricted, and YouTube will not hand it to the server without a sign-in. To describe it, ${viaLibrary}.`,
  },
  {
    kind: 'members',
    pattern: /members[- ]only|join this channel/i,
    permanent: false,
    message: `This YouTube video is for channel members only. If you can watch it, ${viaLibrary}.`,
  },
  {
    kind: 'region',
    pattern:
      /not made this video available in your country|blocked it in your country|not available in your country|geo.?restrict/i,
    permanent: false,
    message: `YouTube does not offer this video in the server's country. To describe it, ${viaLibrary}.`,
  },
  {
    kind: 'bot',
    pattern: /not a bot/i,
    permanent: false,
    message: `YouTube is blocking downloads from the server right now. Try again later, or ${viaLibrary}.`,
  },
  {
    kind: 'unavailable',
    pattern: /unavailable/i,
    permanent: false,
    message: `YouTube says this video is unavailable. If you can still watch it, ${viaLibrary}.`,
  },
];

/** Names what yt-dlp's error text means, or undefined when it is not recognised. */
export function youtubeProblem(text: string): YouTubeProblem | undefined {
  const found = problems.find((problem) => problem.pattern.test(text));
  return found
    ? { kind: found.kind, message: found.message, permanent: found.permanent }
    : undefined;
}

/** A failed command's message and the tail of what it printed. */
export const errorText = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const detail = (error as Error & { detail?: unknown }).detail;
  return `${error.message} ${typeof detail === 'string' ? detail : ''}`;
};
/** errorText on one line, its last 300 characters, for a log line. */
export const reason = (error: unknown): string =>
  errorText(error).replace(/\s+/g, ' ').trim().slice(-300);

/** A named YouTube failure that should reach Kade as it is. `kind` is youtubeProblem's name. */
class Refused extends Error {
  readonly kind?: string;
  constructor(message: string, kind?: string) {
    super(message);
    this.kind = kind;
  }
}

/**
 * YouTube walls off datacenter addresses, and which player client gets through shifts over
 * time. Same ladder as the Clubhouse jukebox: try each client in turn, remember the one that
 * worked, and go around twice because the wall flickers.
 */
const ladder = [
  ['--extractor-args', 'youtube:formats=missing_pot'],
  ['--extractor-args', 'youtube:player_client=tv;formats=missing_pot'],
  ['--extractor-args', 'youtube:player_client=android_vr;formats=missing_pot'],
  ['--extractor-args', 'youtube:player_client=web_embedded,mweb;formats=missing_pot'],
];
let rung = 0;

async function extras(directory: string): Promise<string[]> {
  const pot = process.env.KADE_POT_URL
    ? ['--extractor-args', `youtubepot-bgutilhttp:base_url=${process.env.KADE_POT_URL}`]
    : [];
  const cookies = process.env.KADE_YT_COOKIES || '';
  if (!cookies.trim()) return pot;
  const file = join(directory, 'youtube-cookies.txt');
  await writeFile(file, cookies, { mode: 0o600 });
  return [...pot, '--cookies', file];
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });

/** Answers that another pass round the same clients will not change. */
const settled: ReadonlySet<string> = new Set(['unavailable', 'age', 'members', 'region']);

/**
 * Runs yt-dlp down the ladder. A permanent answer (private, removed, copyright) stops at once;
 * when every client in the first pass gives the same named answer, the second pass is skipped.
 * `seen.error` keeps the last client's failure, so a climb cut short by a deadline can still
 * say what YouTube was answering (the bot wall, usually).
 */
async function climb(
  args: string[],
  directory: string,
  signal: AbortSignal,
  maxBytes: number,
  log: (message: string) => void,
  seen?: { error?: unknown },
): Promise<Buffer> {
  const binary = process.env.YT_DLP_PATH || 'yt-dlp';
  const common = [
    '--ignore-config',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--socket-timeout',
    '25',
    '--retries',
    '3',
    '--fragment-retries',
    '3',
    '--js-runtimes',
    `node:${process.execPath}`,
    ...(await extras(directory)),
  ];
  let last: unknown;
  const answers: (string | undefined)[] = [];
  for (let pass = 0; pass < 2; pass++) {
    if (pass) {
      const agreed =
        answers.length === ladder.length &&
        settled.has(answers[0] ?? '') &&
        answers.every((kind) => kind === answers[0]);
      const problem = agreed ? youtubeProblem(errorText(last)) : undefined;
      if (problem) throw new Refused(problem.message, problem.kind);
      await wait(3000, signal);
    }
    for (let i = 0; i < ladder.length; i++) {
      signal.throwIfAborted();
      const step = (rung + i) % ladder.length;
      try {
        const output = await command(
          binary,
          [...common, ...ladder[step], ...args],
          signal,
          undefined,
          maxBytes,
        );
        rung = step;
        return output;
      } catch (error) {
        signal.throwIfAborted();
        if (seen) seen.error = error;
        last = error;
        const problem = youtubeProblem(errorText(error));
        if (!pass) answers.push(problem?.kind);
        log(
          `youtube: client ${pass * ladder.length + i + 1} of ${ladder.length * 2} failed (${problem?.kind ?? 'unrecognised'}): ${reason(error)}`,
        );
        if (problem?.permanent) throw new Refused(problem.message, problem.kind);
      }
    }
  }
  throw last instanceof Error ? last : new Error('Every YouTube client refused.');
}

const metadataSchema = z.object({
  _type: z.string().nullable().optional().catch(undefined),
  title: z.string().max(1000).catch(''),
  duration: z.number().finite().nullable().optional().catch(undefined),
  is_live: z.boolean().nullable().optional().catch(undefined),
  live_status: z.string().nullable().optional().catch(undefined),
  description: z.string().nullable().optional().catch(undefined),
  uploader: z.string().nullable().optional().catch(undefined),
  upload_date: z.string().nullable().optional().catch(undefined),
  availability: z.string().nullable().optional().catch(undefined),
  age_limit: z.number().nullable().optional().catch(undefined),
  chapters: z
    .array(z.object({ start_time: z.number().finite().nonnegative(), title: z.string().catch('') }))
    .nullable()
    .optional()
    .catch(undefined),
});

const cut = (value: string, most: number) => Array.from(value).slice(0, most).join('');

/** A description line that is a chapter timestamp: "12:05 Chuck E. Cheese", "1:02:10 - News". */
const chapterLine =
  /^\s*[-*•▶►]?\s*\(?((?:\d{1,2}:)?\d{1,2}:\d{2})\)?\s*(?:[-–—:|.)]\s*)?(.*\S)?\s*$/;
const secondsOf = (stamp: string) =>
  stamp
    .split(':')
    .map(Number)
    .reduce((total, part) => total * 60 + part, 0);

/** Chapters written as timestamps in a description, when there are at least two. */
export function chaptersFrom(description: string, duration: number): Chapter[] {
  const found: Chapter[] = [];
  for (const line of description.split(/\r?\n/)) {
    const match = chapterLine.exec(line);
    if (!match?.[2]) continue;
    const start = secondsOf(match[1]);
    const title = cut(cleanLabel(match[2]), 120);
    if (title && start < duration && !found.some((chapter) => chapter.start === start))
      found.push({ start, title });
  }
  return found.length >= 2 ? found.sort((a, b) => a.start - b.start).slice(0, 300) : [];
}

const boilerplate =
  /\b(?:subscribe|follow (?:me|us)|sponsor(?:ed)?|patreon|merch|affiliate|instagram|twitter|facebook|tiktok|discord|like and share|paypal|venmo|cash ?app)\b/i;

/** The uploader's words as prompt context: no links, handles, hashtags, timestamps or plugs. */
export function cleanAbout(description: string): string {
  const kept = description
    .split(/\r?\n/)
    .filter((line) => !chapterLine.test(line) && !boilerplate.test(line))
    .map((line) =>
      line.replace(/https?:\/\/\S+|www\.\S+/gi, ' ').replace(/(^|\s)[@#][\p{L}\p{N}_.-]+/gu, '$1'),
    )
    .join(' ');
  return cut(cleanLabel(kept), 600);
}

/** Bytes of the files in a folder; a file yt-dlp renames or removes while it is counted is skipped. */
export async function folderBytes(
  directory: string,
  list: (path: string) => Promise<string[]> = readdir,
): Promise<number> {
  let bytes = 0;
  for (const file of await list(directory)) {
    const size = await stat(join(directory, file)).catch(() => null);
    if (size?.isFile()) bytes += size.size;
  }
  return bytes;
}

/**
 * yt-dlp reads `--ffmpeg-location ffmpeg` as a path in its working folder, finds nothing, and
 * quietly downloads picture and sound as separate files. Only a real path is passed on: one with
 * a folder in it, the same test the Clubhouse link lane uses (a bare name means "on the PATH").
 */
export function ffmpegLocation(): string[] {
  const path = (process.env.FFMPEG_PATH || '').trim();
  return /[\\/]/.test(path) ? ['--ffmpeg-location', path] : [];
}

/** A finished part file yt-dlp leaves when it cannot merge: youtube.f136.mp4, youtube.f251.webm. */
const partFile = /^youtube\.f[\w-]+\.(?:mp4|m4a|webm|mkv|mov|3gp|opus|ogg|mp3|aac)$/i;

/**
 * The downloaded video, always youtube.mp4. When yt-dlp left the picture and the sound as two
 * part files, they are joined here (streams copied, sound re-encoded only if MP4 refuses it).
 * Anything else throws with what yt-dlp printed, so the log says why.
 */
export async function downloadedVideo(
  directory: string,
  printed: string,
  signal: AbortSignal,
): Promise<string> {
  const target = join(directory, 'youtube.mp4');
  const found = await stat(target).catch(() => null);
  if (found?.isFile()) return target;
  const names = (await readdir(directory)).sort();
  const parts = names.filter((name) => partFile.test(name));
  const tail = printed.replace(/\s+/g, ' ').trim().slice(-300);
  if (parts.length !== 2)
    throw new Error(`no youtube.mp4; files [${names.join(', ')}]; yt-dlp said: ${tail}`);
  const inputs = parts.flatMap((name) => ['-i', join(directory, name)]);
  const maps = ['-map', '0:v:0?', '-map', '1:v:0?', '-map', '0:a:0?', '-map', '1:a:0?'];
  const mux = (audio: string[]) =>
    command(
      ffmpeg(),
      ['-nostdin', '-v', 'error', '-y', ...inputs, ...maps, '-c:v', 'copy', ...audio, target],
      signal,
    );
  try {
    await mux(['-c:a', 'copy']);
  } catch {
    signal.throwIfAborted();
    await mux(['-c:a', 'aac', '-b:a', '192k']);
  }
  return target;
}

export type YouTubeDetails = { name: string; seconds: number; about: string; chapters: Chapter[] };

/**
 * Reads yt-dlp's metadata and decides, before any download, whether the video can be described.
 * Throws an Error with a plain sentence otherwise (never a validation dump).
 */
export function readMetadata(json: unknown, maxSeconds: number, cookies: boolean): YouTubeDetails {
  const parsed = metadataSchema.safeParse(json);
  if (!parsed.success)
    throw new Error(
      'YouTube sent details the server could not read. Try again later, or upload the file instead.',
    );
  const data = parsed.data;
  const live = data.live_status ?? '';
  if (live === 'post_live')
    throw new Error(
      'This stream has just ended and YouTube is still processing it. Try again later.',
    );
  if (data.is_live || live === 'is_live' || live === 'is_upcoming')
    throw new Error('Choose a finished YouTube video, rather than a live or upcoming stream.');
  const availability = data.availability ?? '';
  const named = (text: string) => new Error(youtubeProblem(text)?.message ?? text);
  if (availability === 'private') throw named('private video');
  if (availability === 'subscriber_only') throw named('members-only');
  if (availability === 'premium_only')
    throw new Error(
      `This YouTube video needs a YouTube Premium account. If you can watch it, ${viaLibrary}.`,
    );
  if (!cookies && (availability === 'needs_auth' || (data.age_limit ?? 0) >= 18))
    throw named('confirm your age');
  const seconds = data.duration ?? 0;
  if (!(seconds > 0))
    throw new Error(
      "YouTube has not published this video's length yet. Try again after it has finished processing.",
    );
  if (seconds > maxSeconds)
    throw new Error(
      `This YouTube video is ${spokenLength(seconds)} long, and the longest video the server can bring in is ${spokenLength(maxSeconds)}.`,
    );
  const chapters = (data.chapters ?? [])
    .map((chapter) => ({ start: chapter.start_time, title: cut(cleanLabel(chapter.title), 120) }))
    .filter((chapter) => chapter.title && chapter.start < seconds)
    .sort((a, b) => a.start - b.start)
    .slice(0, 300);
  const description = data.description ?? '';
  const uploaded = [
    data.uploader ? `Uploaded by ${cleanLabel(data.uploader)}` : '',
    data.upload_date ? `on ${data.upload_date.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    name: cut(cleanLabel(data.title), 230) || 'YouTube video',
    seconds,
    about: [uploaded ? `${uploaded}.` : '', cleanAbout(description)].filter(Boolean).join(' '),
    chapters: chapters.length >= 2 ? chapters : chaptersFrom(description, seconds),
  };
}

export async function importYouTube(
  url: string,
  directory: string,
  maxSeconds: number,
  signal: AbortSignal,
  log: (message: string) => void = () => {},
): Promise<{ file: string; name: string; bytes: number; about: string; chapters?: Chapter[] }> {
  const link = youtubeURL(url);
  let raw: Buffer;
  try {
    raw = await climb(
      ['--dump-single-json', '--skip-download', '--', link],
      directory,
      signal,
      16 * 1024 ** 2,
      log,
    );
  } catch (error) {
    signal.throwIfAborted();
    log('youtube metadata: ' + reason(error));
    if (error instanceof Refused) throw new Error(error.message);
    throw new Error(
      youtubeProblem(errorText(error))?.message ??
        `YouTube would not hand this video to the server. It may need a sign-in, be restricted, or be blocking server downloads right now. Try again later, or ${viaLibrary}.`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.toString());
  } catch {
    throw new Error(
      'YouTube sent details the server could not read. Try again later, or upload the file instead.',
    );
  }
  const details = readMetadata(json, maxSeconds, !!(process.env.KADE_YT_COOKIES || '').trim());
  const height = details.seconds > 6000 ? 480 : 720;
  const local = new AbortController();
  let oversize = false;
  const combined = AbortSignal.any([signal, local.signal]);
  const monitor = setInterval(() => {
    void folderBytes(directory).then(
      (bytes) => {
        if (bytes <= 4 * 1024 ** 3 || oversize) return;
        oversize = true;
        local.abort(new Error('YouTube video exceeds the download limit.'));
      },
      () => {},
    );
  }, 2000);
  monitor.unref();
  const tooLarge =
    'This YouTube video is larger than the 2 GB download limit, even at the lower quality the server asks for. Upload a smaller copy instead.';
  try {
    const output = await climb(
      [
        '--max-filesize',
        String(2 * 1024 ** 3),
        '--match-filter',
        `duration <= ${Math.floor(maxSeconds)} & !is_live`,
        '-f',
        [
          `bv*[height<=${height}][fps<=30][vcodec^=avc1]+ba[acodec^=mp4a]`,
          `bv*[height<=${height}][vcodec^=avc1]+ba[acodec^=mp4a]`,
          `bv*[height<=${height}][vcodec^=avc1]+ba`,
          `bv*[height<=${height}]+ba`,
          `b[height<=${height}]`,
          'b',
        ].join('/'),
        '--merge-output-format',
        'mp4',
        '--remux-video',
        'mp4',
        ...ffmpegLocation(),
        '-o',
        join(directory, 'youtube.%(ext)s'),
        '--',
        link,
      ],
      directory,
      combined,
      1024 * 1024,
      log,
    );
    if (/larger than max-filesize/i.test(output.toString())) throw new Refused(tooLarge);
    const file = await downloadedVideo(directory, output.toString(), combined);
    const bytes = (await stat(file)).size;
    if (bytes > 2 * 1024 ** 3) throw new Refused(tooLarge);
    return {
      file,
      bytes,
      name: details.name,
      about: details.about,
      ...(details.chapters.length ? { chapters: details.chapters } : {}),
    };
  } catch (error) {
    signal.throwIfAborted();
    log('youtube download: ' + reason(error));
    if (error instanceof Refused) throw new Error(error.message);
    if (oversize) throw new Error(tooLarge);
    const problem = youtubeProblem(errorText(error));
    throw new Error(
      problem?.message ??
        'The YouTube video could not be downloaded. Upload the video file instead, or try again later.',
    );
  } finally {
    clearInterval(monitor);
  }
}

/* ---------------------------------------------------------------------------------------------
 * AUDIO ONLY, for the Sound Booth's YuE2 covers (Part 293, Sep 25 2026, her ask: "The soundbooth
 * needs a youtube paste link in the yue2 workflow so people can cover songs from youtube videos.")
 *
 * The same ladder, cookies and PO-token sidecar as the describer above (not a third copy of the
 * Clubhouse's): the length is read from the metadata BEFORE anything is downloaded, then only the
 * sound is fetched and turned into an MP3 with the server's own ffmpeg. MP3 because every reader
 * of a cover takes it: the YuE2 worker, the lyric transcriber, the website player and the iPhone.
 * Failures come back as a `kind`, never as the describer's sentences, so the booth says them in
 * its own words. Everything lands in one temporary folder that is removed on every path.
 * ------------------------------------------------------------------------------------------- */

/** Why a YouTube audio import stopped. The caller turns the kind into words. */
export type YouTubeAudioKind =
  | 'not-link'
  | 'not-youtube'
  | 'not-video'
  | 'private'
  | 'copyright'
  | 'removed'
  | 'age'
  | 'members'
  | 'region'
  | 'bot'
  | 'unavailable'
  | 'premium'
  | 'live'
  | 'processing'
  | 'no-length'
  | 'too-long'
  | 'too-large'
  | 'timeout'
  | 'unreadable'
  | 'tools'
  | 'failed'
  /* Media links from other sites and direct files (Part 293, links.ts). */
  | 'not-supported'
  | 'blocked-address'
  | 'not-found'
  | 'not-media'
  | 'redirects';

/** A YouTube audio import that stopped. `message` is detail for the server log only. */
export class YouTubeAudioError extends Error {
  readonly kind: YouTubeAudioKind;
  /** The video's length, for a video that is too long. */
  readonly seconds: number | undefined;
  constructor(kind: YouTubeAudioKind, detail: string = '', seconds?: number) {
    super(detail || kind);
    this.name = 'YouTubeAudioError';
    this.kind = kind;
    this.seconds = seconds;
  }
}

/** `seconds` is 0 only when `lengthOptional` let a listing without a length through. */
export type YouTubeAudioDetails = { title: string; seconds: number; uploader: string };

export type AudioMetadataOptions = {
  /**
   * Other media sites do not always list a length (Part 293): with this set, a listing without
   * one comes back as 0 seconds and the caller measures the downloaded file instead.
   */
  lengthOptional?: boolean;
  /** The title when the listing has none ("YouTube video" by default). */
  fallbackTitle?: string;
};

/**
 * Reads yt-dlp's metadata and decides, before any download, whether the sound can come in.
 * An age-restricted video comes in only when the caller allows it (never for a child's account)
 * AND the server is signed in; a child is refused even though the server's cookies could fetch it.
 * A playlist, album or profile is never one song, so it is refused as 'not-video'.
 */
export function readAudioMetadata(
  json: unknown,
  maxSeconds: number,
  cookies: boolean,
  allowAgeRestricted: boolean = false,
  options: AudioMetadataOptions = {},
): YouTubeAudioDetails {
  const parsed = metadataSchema.safeParse(json);
  if (!parsed.success) throw new YouTubeAudioError('unreadable');
  const data = parsed.data;
  if (data._type === 'playlist' || data._type === 'multi_video')
    throw new YouTubeAudioError('not-video');
  const live = data.live_status ?? '';
  if (live === 'post_live') throw new YouTubeAudioError('processing');
  if (data.is_live || live === 'is_live' || live === 'is_upcoming')
    throw new YouTubeAudioError('live');
  const availability = data.availability ?? '';
  if (availability === 'private') throw new YouTubeAudioError('private');
  if (availability === 'subscriber_only') throw new YouTubeAudioError('members');
  if (availability === 'premium_only') throw new YouTubeAudioError('premium');
  const ageGated = availability === 'needs_auth' || (data.age_limit ?? 0) >= 18;
  if (ageGated && !(allowAgeRestricted && cookies)) throw new YouTubeAudioError('age');
  const seconds = data.duration ?? 0;
  if (!(seconds > 0) && !options.lengthOptional) throw new YouTubeAudioError('no-length');
  /* YouTube lists whole seconds (a listed 6:00 may hold up to 6:00.99 of sound), so a video
   * listed AT the limit is refused too: only a listing under it is sure to fit. */
  if (seconds >= maxSeconds) throw new YouTubeAudioError('too-long', `${seconds} s`, seconds);
  return {
    title: cut(cleanLabel(data.title), 200) || options.fallbackTitle || 'YouTube video',
    seconds: seconds > 0 ? seconds : 0,
    uploader: data.uploader ? cut(cleanLabel(data.uploader), 120) : '',
  };
}

/**
 * Turns a downloaded source into the cover MP3 with the server's own ffmpeg: sound only, no
 * metadata, cut a tenth of a second short of maxSeconds. YouTube lists whole seconds, so a video
 * listed at 5:59 can hold up to 5:59.99 of sound, and the MP3 encoder adds a few hundredths more;
 * only that last fraction of a second past the limit is ever lost. Only local files are read
 * (-protocol_whitelist file), so a playlist file dressed up as audio cannot send ffmpeg to the
 * network. Throws a YouTubeAudioError ('timeout', 'tools' or 'failed'); returns the MP3's bytes.
 */
export async function coverMp3(
  input: string,
  output: string,
  options: { maxSeconds: number; signal: AbortSignal; bitrate?: string },
): Promise<number> {
  const { signal } = options;
  const lastSecond = String(Math.max(1, options.maxSeconds - 0.1));
  try {
    await command(
      ffmpeg(),
      [
        '-nostdin',
        '-hide_banner',
        '-v',
        'error',
        '-y',
        '-protocol_whitelist',
        'file',
        '-i',
        input,
        '-map',
        '0:a:0',
        '-vn',
        '-map_metadata',
        '-1',
        '-c:a',
        'libmp3lame',
        '-b:a',
        options.bitrate ?? '192k',
        '-t',
        lastSecond,
        output,
      ],
      signal,
    );
  } catch (error) {
    if (signal.aborted) throw new YouTubeAudioError('timeout', 'ffmpeg: ' + reason(error));
    if (/ENOENT/.test(errorText(error)))
      throw new YouTubeAudioError('tools', 'ffmpeg: ' + reason(error));
    throw new YouTubeAudioError('failed', 'ffmpeg: ' + reason(error));
  }
  return (await stat(output)).size;
}

const audioKinds: ReadonlySet<string> = new Set([
  'private',
  'copyright',
  'removed',
  'age',
  'members',
  'region',
  'bot',
  'unavailable',
]);
/** What a walled server sees when youtubeProblem has no name for it. */
const walled = /HTTP Error 403|No video formats|Requested format is not available|--cookies/i;

/** A failed or cut-short climb as a kind. When the deadline cut it, the last answer names it. */
function audioFailure(
  error: unknown,
  signal: AbortSignal,
  seen: { error?: unknown },
): YouTubeAudioError {
  if (error instanceof YouTubeAudioError) return error;
  const cause = signal.aborted && seen.error !== undefined ? seen.error : error;
  const named =
    error instanceof Refused && error.kind ? error.kind : youtubeProblem(errorText(cause))?.kind;
  if (named && audioKinds.has(named))
    return new YouTubeAudioError(named as YouTubeAudioKind, reason(cause));
  if (signal.aborted) return new YouTubeAudioError('timeout', reason(cause));
  if (/ENOENT/.test(errorText(error))) return new YouTubeAudioError('tools', reason(error));
  if (walled.test(errorText(cause))) return new YouTubeAudioError('bot', reason(cause));
  return new YouTubeAudioError('failed', reason(cause));
}

/** Sound only: YouTube's AAC stream when there is one, any audio stream, then a small video. */
const audioFormat = 'ba[acodec^=mp4a]/ba/b[height<=360]/b';

export type YouTubeAudioOptions = {
  /**
   * The length limit: a video listed at or over it is refused from the metadata before any
   * download, and the MP3 is cut a tenth of a second short of it.
   */
  maxSeconds: number;
  /** The largest MP3 handed back. */
  maxBytes: number;
  /** The caller's deadline and hang-up; aborting it stops yt-dlp and ffmpeg at once. */
  signal: AbortSignal;
  log?: (message: string) => void;
  /** How long the metadata pass may take (45 s by default), so the download keeps its share. */
  metadataMs?: number;
  /** MP3 bit rate, 192k by default: six minutes is about 8.6 MB. */
  bitrate?: string;
  /** Folder for the temporary folder (the system temp folder by default). */
  tmp?: string;
  /**
   * May an age-restricted video come in through the server's signed-in YouTube account? False by
   * default; the booth passes true for grown-ups only, so a child's account never gets past
   * YouTube's own age gate.
   */
  allowAgeRestricted?: boolean;
};

export type YouTubeAudio = {
  buffer: Buffer;
  title: string;
  /** The video's length from YouTube. */
  seconds: number;
  uploader: string;
  id: string;
  /** The plain watch link that was fetched. */
  link: string;
};

/**
 * One YouTube video's sound as an MP3, or a YouTubeAudioError. The length is checked before the
 * download; a video listed at or over `maxSeconds` is refused with its length, and nothing is
 * fetched.
 */
export async function youtubeAudio(
  value: string,
  options: YouTubeAudioOptions,
): Promise<YouTubeAudio> {
  const found = readYouTubeLink(value);
  if (!('url' in found)) throw new YouTubeAudioError(found.problem);
  const { signal, maxSeconds, maxBytes } = options;
  const log = options.log ?? (() => {});
  if (signal.aborted) throw new YouTubeAudioError('timeout', 'stopped before it started');
  const directory = await mkdtemp(join(options.tmp ?? tmpdir(), 'kade-ytaudio-'));
  /* What YouTube last answered, one record per climb: a metadata pass that was walled on its
   * first client must not name a slow download "the bot wall" when the deadline cuts it. */
  const seen: { error?: unknown } = {};
  const downloadSeen: { error?: unknown } = {};
  try {
    const metaSignal = AbortSignal.any([signal, AbortSignal.timeout(options.metadataMs ?? 45000)]);
    let raw: Buffer;
    try {
      raw = await climb(
        ['--dump-single-json', '--skip-download', '--', found.url],
        directory,
        metaSignal,
        16 * 1024 ** 2,
        log,
        seen,
      );
    } catch (error) {
      throw audioFailure(error, metaSignal, seen);
    }
    let json: unknown;
    try {
      json = JSON.parse(raw.toString());
    } catch {
      throw new YouTubeAudioError('unreadable', 'metadata was not JSON');
    }
    const details = readAudioMetadata(
      json,
      maxSeconds,
      !!(process.env.KADE_YT_COOKIES || '').trim(),
      options.allowAgeRestricted === true,
    );
    let printed: string;
    try {
      printed = (
        await climb(
          [
            '--max-filesize',
            String(Math.max(3 * maxBytes, 64 * 1024 ** 2)),
            '--match-filter',
            `duration < ${Math.ceil(maxSeconds)} & !is_live`,
            '-f',
            audioFormat,
            ...ffmpegLocation(),
            '-o',
            join(directory, 'source.%(ext)s'),
            '--',
            found.url,
          ],
          directory,
          signal,
          1024 * 1024,
          log,
          downloadSeen,
        )
      ).toString();
    } catch (error) {
      throw audioFailure(error, signal, downloadSeen);
    }
    const tail = printed.replace(/\s+/g, ' ').trim().slice(-300);
    // Over --max-filesize or outside the filter, yt-dlp skips the file and still exits 0.
    if (/larger than max-filesize/i.test(printed)) throw new YouTubeAudioError('too-large', tail);
    const names = (await readdir(directory)).sort();
    const source = names.find((name) => /^source\.[a-z\d]+$/i.test(name));
    if (!source)
      throw new YouTubeAudioError(
        'failed',
        `no audio file; files [${names.filter((name) => name.startsWith('source')).join(', ')}]; yt-dlp said: ${tail}`,
      );
    const output = join(directory, 'cover.mp3');
    /* Cut a tenth of a second short of maxSeconds (coverMp3): a listing at 5:59 always fits the
     * booth's own six-minute check after the whole download. */
    const bytes = await coverMp3(join(directory, source), output, {
      maxSeconds,
      signal,
      bitrate: options.bitrate,
    });
    if (bytes > maxBytes) throw new YouTubeAudioError('too-large', `${bytes} bytes as MP3`);
    if (bytes < 1000) throw new YouTubeAudioError('failed', 'ffmpeg made an empty MP3');
    return {
      buffer: await readFile(output),
      title: details.title,
      seconds: details.seconds,
      uploader: details.uploader,
      id: found.id,
      link: found.url,
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
