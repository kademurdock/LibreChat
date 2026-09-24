import { z } from 'zod';
import { join } from 'node:path';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { command } from './media';

export function youtubeURL(value: string): string {
  const url = new URL(value.trim());
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

async function climb(
  args: string[],
  directory: string,
  signal: AbortSignal,
  maxBytes: number,
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
  for (let pass = 0; pass < 2; pass++) {
    if (pass) await new Promise((resolve) => setTimeout(resolve, 3000));
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
        last = error;
      }
    }
  }
  throw last instanceof Error ? last : new Error('Every YouTube client refused.');
}

const metadataSchema = z.object({
  title: z.string().max(1000),
  duration: z.number().finite().positive(),
  is_live: z.boolean().nullable().optional(),
  live_status: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  uploader: z.string().nullable().optional(),
  upload_date: z.string().nullable().optional(),
});
const reason = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(-300);

export async function importYouTube(
  url: string,
  directory: string,
  maxSeconds: number,
  signal: AbortSignal,
  log: (message: string) => void = () => {},
): Promise<{ file: string; name: string; bytes: number; about: string }> {
  const link = youtubeURL(url);
  let raw: Buffer;
  try {
    raw = await climb(
      ['--dump-single-json', '--skip-download', '--', link],
      directory,
      signal,
      16 * 1024 ** 2,
    );
  } catch (error) {
    signal.throwIfAborted();
    log('youtube metadata: ' + reason(error));
    throw new Error(
      'YouTube would not hand this video to the server. It may need a sign-in, be restricted, or be blocking server downloads right now. Upload the video file instead, or try again later.',
    );
  }
  const metadata = metadataSchema.parse(JSON.parse(raw.toString()));
  if (
    metadata.is_live ||
    ['is_live', 'is_upcoming', 'post_live'].includes(metadata.live_status || '')
  )
    throw new Error('Choose a finished YouTube video, rather than a live or upcoming stream.');
  if (metadata.duration > maxSeconds)
    throw new Error(`YouTube videos are limited to ${Math.floor(maxSeconds / 60)} minutes.`);
  const local = new AbortController();
  const combined = AbortSignal.any([signal, local.signal]);
  const monitor = setInterval(() => {
    void (async () => {
      let bytes = 0;
      for (const file of await readdir(directory)) {
        const size = await stat(join(directory, file));
        if (size.isFile()) bytes += size.size;
      }
      if (bytes > 4 * 1024 ** 3)
        local.abort(new Error('YouTube video exceeds the download limit.'));
    })().catch(() => local.abort());
  }, 2000);
  monitor.unref();
  try {
    await climb(
      [
        '--max-filesize',
        String(2 * 1024 ** 3),
        '--match-filter',
        `duration <= ${Math.floor(maxSeconds)} & !is_live`,
        '-f',
        'bv*[height<=720][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=720][vcodec^=avc1]+ba/bv*[height<=720]+ba/b[height<=720]/b',
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
    );
    const file = join(directory, 'youtube.mp4');
    const bytes = (await stat(file)).size;
    if (bytes > 2 * 1024 ** 3) throw new Error('The YouTube video exceeds 2 GB.');
    const about = [
      metadata.uploader ? `Uploaded by ${metadata.uploader}` : '',
      metadata.upload_date
        ? `on ${metadata.upload_date.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')}`
        : '',
      metadata.description ? `. ${metadata.description}` : '',
    ]
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1500);
    return {
      file,
      bytes,
      name: metadata.title.replace(/[\r\n\0]/g, ' ').slice(0, 230),
      about,
    };
  } catch (error) {
    signal.throwIfAborted();
    log('youtube download: ' + reason(error));
    throw new Error(
      'The YouTube video could not be downloaded within the limits. Upload the video file instead, or try again later.',
    );
  } finally {
    clearInterval(monitor);
  }
}
