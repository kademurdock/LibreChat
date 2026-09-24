import { z } from 'zod';
import { join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
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

const metadataSchema = z.object({
  title: z.string().max(1000),
  duration: z.number().finite().positive(),
  is_live: z.boolean().optional(),
  live_status: z.string().optional(),
});
export async function importYouTube(
  url: string,
  directory: string,
  maxSeconds: number,
  signal: AbortSignal,
): Promise<{ file: string; name: string; bytes: number }> {
  const binary = process.env.YT_DLP_PATH || 'yt-dlp';
  const common = [
    '--ignore-config',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--socket-timeout',
    '25',
    '--retries',
    '0',
    '--extractor-retries',
    '0',
    '--fragment-retries',
    '0',
    '--js-runtimes',
    `node:${process.execPath}`,
  ];
  let raw: Buffer;
  try {
    raw = await command(
      binary,
      [...common, '--dump-single-json', '--skip-download', '--', youtubeURL(url)],
      signal,
      undefined,
      8 * 1024 ** 2,
    );
  } catch {
    signal.throwIfAborted();
    throw new Error(
      'YouTube could not provide this video. It may require sign-in, be restricted, or block server downloads. Upload the video file instead.',
    );
  }
  const metadata = metadataSchema.parse(JSON.parse(raw.toString()));
  if (
    metadata.is_live ||
    ['is_live', 'is_upcoming', 'post_live'].includes(metadata.live_status || '')
  )
    throw new Error('Choose a finished YouTube video, rather than a live or upcoming stream.');
  if (metadata.duration > maxSeconds)
    throw new Error(
      `YouTube videos are limited to ${Math.floor(maxSeconds / 60)} minutes in this trial.`,
    );
  const local = new AbortController();
  const combined = AbortSignal.any([signal, local.signal]);
  const monitor = setInterval(() => {
    void (async () => {
      const files = await readdir(directory);
      let bytes = 0;
      for (const file of files) {
        const size = await stat(join(directory, file));
        if (size.isFile()) bytes += size.size;
      }
      if (bytes > 4 * 1024 ** 3)
        local.abort(new Error('YouTube video exceeds the download limit.'));
    })().catch(() => local.abort());
  }, 2000);
  monitor.unref();
  try {
    await command(
      binary,
      [
        ...common,
        '--max-filesize',
        String(2 * 1024 ** 3),
        '--match-filter',
        `duration <= ${Math.floor(maxSeconds)} & !is_live`,
        '-f',
        'bv*[height<=720]+ba/b[height<=720]',
        '--merge-output-format',
        'mp4',
        '--remux-video',
        'mp4',
        '--ffmpeg-location',
        process.env.FFMPEG_PATH || 'ffmpeg',
        '-o',
        join(directory, 'youtube.%(ext)s'),
        '--',
        youtubeURL(url),
      ],
      combined,
      undefined,
      1024 * 1024,
    );
    const file = join(directory, 'youtube.mp4');
    const bytes = (await stat(file)).size;
    if (bytes > 2 * 1024 ** 3) throw new Error('The YouTube video exceeds 2 GB.');
    return { file, bytes, name: metadata.title.replace(/[\r\n\0]/g, ' ').slice(0, 230) + '.mp4' };
  } catch {
    signal.throwIfAborted();
    throw new Error(
      'The YouTube video could not be downloaded within the trial limits. Upload the video file instead.',
    );
  } finally {
    clearInterval(monitor);
  }
}
