import { z } from 'zod';
import { join } from 'node:path';
import { readdir, stat, writeFile } from 'node:fs/promises';
import type { Chapter } from './types';
import { spokenLength } from './transcript';
import { cleanLabel } from './prompt';
import { command } from './media';

export function youtubeURL(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Enter a YouTube video link.');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port)
    throw new Error('Enter a YouTube video link.');
  let id: string | null = null;
  if (url.hostname === 'youtu.be') id = url.pathname.split('/')[1];
  if (
    ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname)
  ) {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else if (/^\/(shorts|embed|live)\//.test(url.pathname)) id = url.pathname.split('/')[2];
  }
  if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id))
    throw new Error('Enter a single YouTube video link, not a channel or playlist.');
  return `https://www.youtube.com/watch?v=${id}`;
}

const viaLibrary = 'download it with TubeVault, add it to your Library, then describe it from there';

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
    pattern: /has been removed|been terminated|account .{0,40}closed|video has been deleted|no longer available/i,
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
    pattern: /not made this video available in your country|blocked it in your country|not available in your country|geo.?restrict/i,
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
  return found ? { kind: found.kind, message: found.message, permanent: found.permanent } : undefined;
}

const errorText = (error: unknown) => {
  if (!(error instanceof Error)) return String(error);
  const detail = (error as Error & { detail?: unknown }).detail;
  return `${error.message} ${typeof detail === 'string' ? detail : ''}`;
};
const reason = (error: unknown) => errorText(error).replace(/\s+/g, ' ').trim().slice(-300);

/** A named YouTube failure that should reach Kade as it is. */
class Refused extends Error {}

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
 */
async function climb(
  args: string[],
  directory: string,
  signal: AbortSignal,
  maxBytes: number,
  log: (message: string) => void,
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
      if (problem) throw new Refused(problem.message);
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
        last = error;
        const problem = youtubeProblem(errorText(error));
        if (!pass) answers.push(problem?.kind);
        log(
          `youtube: client ${pass * ladder.length + i + 1} of ${ladder.length * 2} failed (${problem?.kind ?? 'unrecognised'}): ${reason(error)}`,
        );
        if (problem?.permanent) throw new Refused(problem.message);
      }
    }
  }
  throw last instanceof Error ? last : new Error('Every YouTube client refused.');
}

const metadataSchema = z.object({
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
      line
        .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
        .replace(/(^|\s)[@#][\p{L}\p{N}_.-]+/gu, '$1'),
    )
    .join(' ');
  return cut(cleanLabel(kept), 600);
}

export type YouTubeDetails = { name: string; seconds: number; about: string; chapters: Chapter[] };

/**
 * Reads yt-dlp's metadata and decides, before any download, whether the video can be described.
 * Throws an Error with a plain sentence otherwise (never a validation dump).
 */
export function readMetadata(json: unknown, maxSeconds: number, cookies: boolean): YouTubeDetails {
  const parsed = metadataSchema.safeParse(json);
  if (!parsed.success)
    throw new Error('YouTube sent details the server could not read. Try again later, or upload the file instead.');
  const data = parsed.data;
  const live = data.live_status ?? '';
  if (live === 'post_live')
    throw new Error('This stream has just ended and YouTube is still processing it. Try again later.');
  if (data.is_live || live === 'is_live' || live === 'is_upcoming')
    throw new Error('Choose a finished YouTube video, rather than a live or upcoming stream.');
  const availability = data.availability ?? '';
  const named = (text: string) => new Error(youtubeProblem(text)?.message ?? text);
  if (availability === 'private') throw named('private video');
  if (availability === 'subscriber_only') throw named('members-only');
  if (availability === 'premium_only')
    throw new Error(`This YouTube video needs a YouTube Premium account. If you can watch it, ${viaLibrary}.`);
  if (!cookies && (availability === 'needs_auth' || (data.age_limit ?? 0) >= 18))
    throw named('confirm your age');
  const seconds = data.duration ?? 0;
  if (!(seconds > 0))
    throw new Error("YouTube has not published this video's length yet. Try again after it has finished processing.");
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
    throw new Error('YouTube sent details the server could not read. Try again later, or upload the file instead.');
  }
  const details = readMetadata(json, maxSeconds, !!(process.env.KADE_YT_COOKIES || '').trim());
  const height = details.seconds > 6000 ? 480 : 720;
  const local = new AbortController();
  let oversize = false;
  const combined = AbortSignal.any([signal, local.signal]);
  const monitor = setInterval(() => {
    void (async () => {
      let bytes = 0;
      for (const file of await readdir(directory)) {
        const size = await stat(join(directory, file));
        if (size.isFile()) bytes += size.size;
      }
      if (bytes > 4 * 1024 ** 3 && !oversize) {
        oversize = true;
        local.abort(new Error('YouTube video exceeds the download limit.'));
      }
    })().catch(() => local.abort());
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
        '--ffmpeg-location',
        process.env.FFMPEG_PATH || 'ffmpeg',
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
    const file = join(directory, 'youtube.mp4');
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
