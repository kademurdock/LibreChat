import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lookup } from 'node:dns/promises';
import { mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { createSSRFSafeAgents } from '../auth/agent';
import { isSSRFTarget } from '../auth/domain';
import { isPrivateIP } from '../auth/ip';
import { cleanLabel } from './text';
import { command, ffprobe } from './media';
import {
  coverMp3,
  errorText,
  ffmpegLocation,
  readAudioMetadata,
  readYouTubeLink,
  reason,
  youtubeAudio,
  YouTubeAudioError,
  youtubeProblem,
} from './youtube';
import type { YouTubeAudio, YouTubeAudioKind, YouTubeAudioOptions } from './youtube';

/* ---------------------------------------------------------------------------------------------
 * MEDIA LINKS (Part 293, Sep 25 2026). Her correction: "it's not just a youtube link it's a media
 * in general link." One pasted link becomes one song's sound for a Sound Booth cover, from:
 *
 * - YouTube and YouTube Music: youtubeAudio, unchanged (its client ladder, cookies and PO tokens).
 * - Other big media sites (Vimeo, SoundCloud, Bandcamp, TikTok, Instagram, Facebook, X, Reddit,
 *   Dailymotion, Twitch clips, the Internet Archive): yt-dlp with ONLY the allowlisted extractors
 *   loaded (--use-extractors, which yt-dlp has had since 2022.11.11; the production image installs
 *   the newest yt-dlp from PyPI), so its generic extractor, which would fetch any page on any host
 *   it is handed, never runs: a link or a redirect to anywhere else is "No suitable extractor".
 *   Never through a shell (spawn with an argument list), the link after '--'. The page and media
 *   links yt-dlp settles on are checked against private addresses before the download, and the
 *   download uses exactly that checked listing (--load-info-json).
 * - A direct link to an audio or video file: fetched by this code, never by yt-dlp. The name must
 *   resolve only to public addresses (the fork's SSRF rules: private, loopback, link-local, the
 *   cloud metadata address, CGNAT, unique-local, *.internal including railway.internal), every
 *   redirect is checked again (at most three), the connection itself refuses a private address
 *   at connect time (createSSRFSafeAgents, so a name cannot change its answer in between), the
 *   bytes are capped, and the file must start like real media before ffmpeg reads it.
 *
 * A link carrying a sign-in (user@host), a port, or an IP address instead of a name is refused
 * before anything is looked up. Every failure comes back as a YouTubeAudioError `kind`; the caller
 * says it in its own words.
 * ------------------------------------------------------------------------------------------- */

export type MediaSite =
  | 'youtube'
  | 'vimeo'
  | 'soundcloud'
  | 'bandcamp'
  | 'tiktok'
  | 'instagram'
  | 'facebook'
  | 'x'
  | 'dailymotion'
  | 'twitch'
  | 'reddit'
  | 'archive'
  | 'file';

/** Why a pasted text is not a link the server will fetch. */
export type MediaLinkProblem = 'not-link' | 'not-supported' | 'not-video' | 'blocked-address';

/** One pasted link, read: what it is and the one address that will be fetched. */
export type MediaLinkFound = {
  kind: 'youtube' | 'site' | 'file';
  site: MediaSite;
  /** The site in words: "YouTube", "SoundCloud", "the link" for a direct file. */
  siteName: string;
  /** Short and log-safe: the YouTube id, "soundcloud:song-name", "file:host/song.mp3". */
  id: string;
  url: string;
};
export type MediaLink = MediaLinkFound | { problem: MediaLinkProblem };

type SiteRule = { site: MediaSite; name: string; hosts: readonly string[]; subdomains?: string };

const siteRules: readonly SiteRule[] = [
  { site: 'vimeo', name: 'Vimeo', hosts: ['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'] },
  {
    site: 'soundcloud',
    name: 'SoundCloud',
    hosts: ['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com', 'on.soundcloud.com'],
  },
  { site: 'bandcamp', name: 'Bandcamp', hosts: ['bandcamp.com'], subdomains: 'bandcamp.com' },
  {
    site: 'tiktok',
    name: 'TikTok',
    hosts: ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
  },
  { site: 'instagram', name: 'Instagram', hosts: ['instagram.com', 'www.instagram.com'] },
  {
    site: 'facebook',
    name: 'Facebook',
    hosts: ['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com', 'fb.watch'],
  },
  {
    site: 'x',
    name: 'X',
    hosts: ['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'],
  },
  { site: 'dailymotion', name: 'Dailymotion', hosts: ['dailymotion.com', 'www.dailymotion.com', 'dai.ly'] },
  { site: 'twitch', name: 'Twitch', hosts: ['clips.twitch.tv', 'twitch.tv', 'www.twitch.tv', 'm.twitch.tv'] },
  {
    site: 'reddit',
    name: 'Reddit',
    hosts: ['reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com', 'v.redd.it'],
  },
  { site: 'archive', name: 'the Internet Archive', hosts: ['archive.org', 'www.archive.org'] },
];

/**
 * The only yt-dlp extractors ever loaded for a media link (yt-dlp reads each as a regular
 * expression matched against its whole lower-case name). No "generic", no "default", no "all",
 * and none of the link shorteners (twitter:shortener follows t.co to anywhere). Checked against
 * yt-dlp 2026.08.19's --list-extractors: exactly these 14 load. A name a later yt-dlp renames
 * simply matches nothing, which fails closed.
 */
export const MEDIA_EXTRACTORS: readonly string[] = [
  'youtube',
  'vimeo',
  'soundcloud',
  'bandcamp',
  'tiktok',
  'vm\\.tiktok',
  'instagram',
  'facebook',
  'facebook:reel',
  'twitter',
  'dailymotion',
  'twitch:clips',
  'reddit',
  'archive\\.org',
];

/** --use-extractors with the allowlist, and the generic extractor struck out by name as well. */
export function extractorArgs(): string[] {
  return ['--use-extractors', [...MEDIA_EXTRACTORS, '-generic'].join(',')];
}

/** Every yt-dlp run for a media site: no config file can widen it, one item, the allowlist. */
export function siteArgs(): string[] {
  return [
    '--ignore-config',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--socket-timeout',
    '25',
    '--retries',
    '2',
    '--fragment-retries',
    '2',
    '--js-runtimes',
    `node:${process.execPath}`,
    ...extractorArgs(),
  ];
}

/** Direct audio and video file endings the booth takes. */
export const MEDIA_FILE_EXTENSIONS: readonly string[] = [
  'mp3',
  'm4a',
  'wav',
  'flac',
  'ogg',
  'opus',
  'aac',
  'mp4',
  'mov',
  'webm',
];

const blockedSuffixes = ['.internal', '.local', '.localhost', '.home.arpa', '.lan', '.intranet', '.corp'];

const bareHost = (hostname: string) =>
  hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');

/** True for a name no public link uses: one label, internal suffixes, the fork's SSRF names. */
function privateName(host: string): boolean {
  const labels = host.split('.');
  if (labels.length < 2 || !/[a-z]/.test(labels[labels.length - 1])) return true;
  return isSSRFTarget(host) || blockedSuffixes.some((suffix) => host.endsWith(suffix));
}

/**
 * Why the server will not fetch this address at all, or null. Checked for the pasted link and
 * again for every redirect: web links only, no sign-in in the link, no port, no IP address in
 * place of a name, and no private or internal name.
 */
export function linkShapeProblem(url: URL): string | null {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'not a web link';
  if (url.username || url.password) return 'carries a sign-in';
  if (url.port) return 'names a port';
  const host = bareHost(url.hostname);
  if (isIP(host)) return 'is an IP address';
  if (privateName(host)) return 'is a private or internal name';
  return null;
}

/** The file ending when the link's path ends in a media file, else ''. */
export function mediaFileExtension(pathname: string): string {
  const found = /\.([a-z\d]{2,5})$/i.exec(pathname);
  const ext = found ? found[1].toLowerCase() : '';
  return MEDIA_FILE_EXTENSIONS.includes(ext) ? ext : '';
}

function siteRule(hostname: string): SiteRule | undefined {
  const host = bareHost(hostname);
  return siteRules.find(
    (rule) =>
      rule.hosts.includes(host) ||
      (!!rule.subdomains && new RegExp(`^[a-z\\d-]+\\.${rule.subdomains.replace('.', '\\.')}$`).test(host)),
  );
}

const shortId = (value: string) =>
  value
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/**
 * Reads a pasted link. YouTube links become one plain watch link (readYouTubeLink); other big
 * media sites keep their link without its #fragment; a link ending in an audio or video file is
 * a direct file. Nothing is looked up or fetched here.
 */
export function readMediaLink(value: string): MediaLink {
  const text = String(value ?? '').trim();
  if (!text) return { problem: 'not-link' };
  const youtube = readYouTubeLink(text);
  if ('url' in youtube)
    return { kind: 'youtube', site: 'youtube', siteName: 'YouTube', id: youtube.id, url: youtube.url };
  if (youtube.problem === 'not-video') return { problem: 'not-video' };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return { problem: 'not-link' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { problem: 'not-link' };
  if (linkShapeProblem(url)) return { problem: 'blocked-address' };
  url.hash = '';
  const segments = url.pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1] || '';
  if (mediaFileExtension(url.pathname)) {
    return {
      kind: 'file',
      site: 'file',
      siteName: 'the link',
      id: `file:${shortId(`${bareHost(url.hostname)}/${decodeSafely(last)}`)}`,
      url: url.href,
    };
  }
  const rule = siteRule(url.hostname);
  if (!rule) return { problem: 'not-supported' };
  return {
    kind: 'site',
    site: rule.site,
    siteName: rule.name,
    id: `${rule.site}:${shortId(decodeSafely(last)) || 'link'}`,
    url: url.href,
  };
}

function decodeSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/* ── public addresses only ───────────────────────────────────────────── */

/** Every address a name has. Tests answer for DNS; production asks the system resolver. */
export type Resolve = (hostname: string) => Promise<{ address: string; family: number }[]>;
const systemResolve: Resolve = (hostname) => lookup(hostname, { all: true, verbatim: true });

/**
 * Null when every address the host has is public; 'blocked-address' when any one is private,
 * loopback, link-local, the metadata address, CGNAT or unique-local (isPrivateIP); 'not-found'
 * when the name does not resolve (fail closed, unlike the fork's preflight check). An IP address
 * is judged as it is, without a lookup.
 */
export async function publicHost(
  hostname: string,
  resolve: Resolve = systemResolve,
): Promise<'blocked-address' | 'not-found' | null> {
  const host = bareHost(hostname);
  if (isIP(host)) return isPrivateIP(host) ? 'blocked-address' : null;
  if (privateName(host)) return 'blocked-address';
  let found: { address: string }[];
  try {
    found = await resolve(host);
  } catch {
    return 'not-found';
  }
  if (!found.length) return 'not-found';
  return found.some((entry) => isPrivateIP(entry.address)) ? 'blocked-address' : null;
}

/* ── a direct file, fetched by this code ─────────────────────────────── */

/** One HTTP answer, as the direct-file fetch reads it. */
export type MediaResponse = {
  status: number;
  header: (name: string) => string;
  body: AsyncIterable<Uint8Array>;
  close: () => void;
};
/** One GET that never follows a redirect itself. */
export type Transport = (url: URL, signal: AbortSignal) => Promise<MediaResponse>;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
let agents: ReturnType<typeof createSSRFSafeAgents> | undefined;

/**
 * The production GET: Node's own http/https (which never follows redirects) through the fork's
 * SSRF-safe agents, whose DNS lookup at connect time refuses a private address (code ESSRF).
 */
export const directTransport: Transport = (url, signal) =>
  new Promise((resolve, reject) => {
    agents ??= createSSRFSafeAgents();
    const secure = url.protocol === 'https:';
    const request = (secure ? https : http).get(
      url,
      {
        agent: secure ? agents.httpsAgent : agents.httpAgent,
        signal,
        timeout: 20000,
        headers: { 'User-Agent': USER_AGENT, Accept: 'audio/*, video/*;q=0.9, */*;q=0.5' },
      },
      (response) =>
        resolve({
          status: response.statusCode ?? 0,
          header: (name) => {
            const value = response.headers[name.toLowerCase()];
            return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
          },
          body: response,
          close: () => response.destroy(),
        }),
    );
    request.on('timeout', () => request.destroy(new Error('the site did not answer in time')));
    request.on('error', reject);
  });

/** Redirects a direct file may take before it is refused. */
export const MEDIA_REDIRECTS = 3;
const redirectCodes = new Set([301, 302, 303, 307, 308]);
/** Content types that are pages or playlists, never one file of sound. */
const notMediaType = /^text\/|html|xml|json|mpegurl|dash|javascript/;

function statusFailure(status: number): YouTubeAudioError {
  if (status === 401 || status === 403) return new YouTubeAudioError('private', `HTTP ${status}`);
  if (status === 404 || status === 410) return new YouTubeAudioError('removed', `HTTP ${status}`);
  if (status === 429 || status >= 500) return new YouTubeAudioError('unavailable', `HTTP ${status}`);
  return new YouTubeAudioError('failed', `HTTP ${status}`);
}

function fetchFailure(error: unknown, signal: AbortSignal): YouTubeAudioError {
  if (error instanceof YouTubeAudioError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (signal.aborted) return new YouTubeAudioError('timeout', reason(error));
  if (code === 'ESSRF') return new YouTubeAudioError('blocked-address', reason(error));
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new YouTubeAudioError('not-found', reason(error));
  return new YouTubeAudioError('failed', reason(error));
}

async function saveBody(response: MediaResponse, file: string, maxBytes: number): Promise<number> {
  const handle = await open(file, 'w');
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        response.close();
        throw new YouTubeAudioError('too-large', `over ${maxBytes} bytes`);
      }
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
  return bytes;
}

type DirectOptions = { maxBytes: number; signal: AbortSignal; resolve: Resolve; transport: Transport };

/**
 * GETs a direct media file into `file`, checking the address before every hop: the shape
 * (linkShapeProblem), then every address the name resolves to (publicHost). At most
 * MEDIA_REDIRECTS redirects; a page, playlist or oversized file is refused.
 */
export async function downloadDirect(
  link: URL,
  file: string,
  options: DirectOptions,
): Promise<{ bytes: number; url: URL }> {
  let current = link;
  for (let hop = 0; hop <= MEDIA_REDIRECTS; hop++) {
    const shape = linkShapeProblem(current);
    if (shape) throw new YouTubeAudioError('blocked-address', `hop ${hop}: the address ${shape}`);
    const where = await publicHost(current.hostname, options.resolve);
    if (where) throw new YouTubeAudioError(where, `hop ${hop}: ${bareHost(current.hostname)}`);
    let response: MediaResponse;
    try {
      response = await options.transport(current, options.signal);
    } catch (error) {
      throw fetchFailure(error, options.signal);
    }
    if (redirectCodes.has(response.status)) {
      const location = response.header('location');
      response.close();
      if (!location) throw new YouTubeAudioError('failed', `redirect ${response.status} with no address`);
      try {
        current = new URL(location, current);
      } catch {
        throw new YouTubeAudioError('failed', `redirect ${response.status} to an unreadable address`);
      }
      current.hash = '';
      continue;
    }
    if (response.status !== 200) {
      response.close();
      throw statusFailure(response.status);
    }
    const type = response.header('content-type').toLowerCase();
    if (notMediaType.test(type)) {
      response.close();
      throw new YouTubeAudioError('not-media', `content-type ${type}`);
    }
    const length = Number(response.header('content-length'));
    if (length > options.maxBytes) {
      response.close();
      throw new YouTubeAudioError('too-large', `content-length ${length}`);
    }
    try {
      return { bytes: await saveBody(response, file, options.maxBytes), url: current };
    } catch (error) {
      throw fetchFailure(error, options.signal);
    }
  }
  throw new YouTubeAudioError('redirects', `more than ${MEDIA_REDIRECTS} redirects`);
}

const ascii = (head: Uint8Array, at: number, text: string) =>
  Array.from(text).every((letter, i) => head[at + i] === letter.charCodeAt(0));

/**
 * True when a file starts like real audio or video: MP3 (ID3 or a frame), AAC (ADTS or ADIF),
 * FLAC, Ogg and Opus, WAV, MP4, M4A and MOV, WebM. A playlist or page saved under an audio name
 * (#EXTM3U, ffconcat, XML) is refused before ffmpeg opens it.
 */
export function looksLikeMedia(head: Uint8Array): boolean {
  if (head.length < 12) return false;
  if (ascii(head, 0, 'ID3') || ascii(head, 0, 'fLaC') || ascii(head, 0, 'OggS') || ascii(head, 0, 'ADIF'))
    return true;
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return true;
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WAVE')) return true;
  if (['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].some((box) => ascii(head, 4, box))) return true;
  return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
}

async function fileHead(file: string): Promise<Uint8Array> {
  const handle = await open(file, 'r');
  try {
    const head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, 16, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** The length of a downloaded source, measured by ffprobe reading the local file only. */
async function measuredSeconds(file: string, signal: AbortSignal): Promise<number> {
  let printed: Buffer;
  try {
    printed = await command(
      ffprobe(),
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        file,
      ],
      signal,
      undefined,
      64 * 1024,
    );
  } catch (error) {
    if (signal.aborted) throw new YouTubeAudioError('timeout', 'ffprobe: ' + reason(error));
    if (/ENOENT/.test(errorText(error))) throw new YouTubeAudioError('tools', 'ffprobe: ' + reason(error));
    throw new YouTubeAudioError('not-media', 'ffprobe: ' + reason(error));
  }
  const seconds = Number.parseFloat(printed.toString().trim());
  if (!(Number.isFinite(seconds) && seconds > 0)) throw new YouTubeAudioError('not-media', 'no length');
  return seconds;
}

/* ── the shared finish ───────────────────────────────────────────────── */

export type MediaAudioOptions = YouTubeAudioOptions & {
  /** DNS for the address checks (the system resolver by default). */
  resolve?: Resolve;
  /** The direct-file GET (directTransport by default). */
  transport?: Transport;
};

/** One link's sound as an MP3, named with the site it came from. */
export type MediaAudio = YouTubeAudio & { site: MediaSite; siteName: string };

/** The largest source a site or a direct file may send before it becomes an MP3. */
const sourceCap = (maxBytes: number) => Math.max(3 * maxBytes, 64 * 1024 ** 2);

async function finish(
  source: string,
  directory: string,
  listedSeconds: number,
  options: MediaAudioOptions,
): Promise<{ buffer: Buffer; seconds: number }> {
  const { maxSeconds, maxBytes, signal } = options;
  const seconds = listedSeconds > 0 ? listedSeconds : await measuredSeconds(source, signal);
  if (seconds >= maxSeconds) throw new YouTubeAudioError('too-long', `${seconds} s`, seconds);
  const output = join(directory, 'cover.mp3');
  const bytes = await coverMp3(source, output, { maxSeconds, signal, bitrate: options.bitrate });
  if (bytes > maxBytes) throw new YouTubeAudioError('too-large', `${bytes} bytes as MP3`);
  if (bytes < 1000) throw new YouTubeAudioError('failed', 'ffmpeg made an empty MP3');
  return { buffer: await readFile(output), seconds };
}

function fileTitle(url: URL): string {
  const name = decodeSafely(url.pathname.split('/').filter(Boolean).pop() || '')
    .replace(/\.[a-z\d]{2,5}$/i, '')
    .replace(/[_+]+/g, ' ');
  return Array.from(cleanLabel(name)).slice(0, 200).join('') || 'Linked song';
}

async function fileAudio(link: MediaLinkFound, options: MediaAudioOptions): Promise<MediaAudio> {
  const url = new URL(link.url);
  const directory = await mkdtemp(join(options.tmp ?? tmpdir(), 'kade-mediafile-'));
  try {
    const source = join(directory, `source.${mediaFileExtension(url.pathname)}`);
    const got = await downloadDirect(url, source, {
      maxBytes: sourceCap(options.maxBytes),
      signal: options.signal,
      resolve: options.resolve ?? systemResolve,
      transport: options.transport ?? directTransport,
    });
    options.log?.(`file: ${got.bytes} bytes from ${bareHost(got.url.hostname)}`);
    if (!looksLikeMedia(await fileHead(source)))
      throw new YouTubeAudioError('not-media', 'the file does not start like audio or video');
    const done = await finish(source, directory, 0, options);
    return {
      ...done,
      title: fileTitle(got.url),
      uploader: '',
      id: link.id,
      /* No query string is kept: a signed link's token stays out of the record. */
      link: `${got.url.origin}${got.url.pathname}`,
      site: 'file',
      siteName: link.siteName,
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/* ── another media site, through yt-dlp's allowlisted extractors ───────── */

const linksSchema = z.object({
  webpage_url: z.string().optional().catch(undefined),
  url: z.string().optional().catch(undefined),
  manifest_url: z.string().optional().catch(undefined),
  formats: z
    .array(
      z.object({
        url: z.string().optional().catch(undefined),
        manifest_url: z.string().optional().catch(undefined),
        fragment_base_url: z.string().optional().catch(undefined),
      }),
    )
    .optional()
    .catch(undefined),
  requested_formats: z
    .array(z.object({ url: z.string().optional().catch(undefined) }))
    .optional()
    .catch(undefined),
});

/** Every host yt-dlp's listing would send the download to (page, manifests, formats). */
export function listedHosts(json: unknown): { hosts: string[]; page?: string; problem?: string } {
  const parsed = linksSchema.safeParse(json);
  if (!parsed.success) return { hosts: [], problem: 'unreadable listing' };
  const data = parsed.data;
  const addresses = [
    data.webpage_url,
    data.url,
    data.manifest_url,
    ...(data.formats ?? []).flatMap((format) => [format.url, format.manifest_url, format.fragment_base_url]),
    ...(data.requested_formats ?? []).map((format) => format.url),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  const hosts = new Set<string>();
  for (const address of addresses) {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      return { hosts: [], problem: `a ${url.protocol} link` };
    if (url.username || url.password) return { hosts: [], problem: 'a link with a sign-in' };
    hosts.add(bareHost(url.hostname));
  }
  return { hosts: [...hosts], page: data.webpage_url };
}

const siteKinds: ReadonlySet<string> = new Set([
  'private',
  'copyright',
  'removed',
  'age',
  'members',
  'region',
  'bot',
  'unavailable',
]);

function siteFailure(error: unknown, signal: AbortSignal): YouTubeAudioError {
  if (error instanceof YouTubeAudioError) return error;
  const text = errorText(error);
  if (signal.aborted) return new YouTubeAudioError('timeout', reason(error));
  if (/ENOENT|no such option|unrecognized arguments/i.test(text))
    return new YouTubeAudioError('tools', reason(error));
  if (/Unsupported URL|No suitable extractor/i.test(text))
    return new YouTubeAudioError('not-supported', reason(error));
  const named = youtubeProblem(text)?.kind;
  if (named && siteKinds.has(named)) return new YouTubeAudioError(named as YouTubeAudioKind, reason(error));
  if (/log ?in|sign ?in|cookies|authenticat/i.test(text)) return new YouTubeAudioError('private', reason(error));
  if (/HTTP Error 40[34]|HTTP Error 410/i.test(text)) return new YouTubeAudioError('removed', reason(error));
  return new YouTubeAudioError('failed', reason(error));
}

const ytDlp = () => process.env.YT_DLP_PATH || 'yt-dlp';

async function siteAudio(link: MediaLinkFound, options: MediaAudioOptions): Promise<MediaAudio> {
  const { signal, maxSeconds } = options;
  const log = options.log ?? (() => {});
  const directory = await mkdtemp(join(options.tmp ?? tmpdir(), 'kade-mediasite-'));
  try {
    const metaSignal = AbortSignal.any([signal, AbortSignal.timeout(options.metadataMs ?? 45000)]);
    let raw: Buffer;
    try {
      raw = await command(
        ytDlp(),
        [...siteArgs(), '--flat-playlist', '--dump-single-json', '--skip-download', '--', link.url],
        metaSignal,
        undefined,
        16 * 1024 ** 2,
      );
    } catch (error) {
      log(`${link.site}: metadata failed: ${reason(error)}`);
      throw siteFailure(error, metaSignal);
    }
    let json: unknown;
    try {
      json = JSON.parse(raw.toString());
    } catch {
      throw new YouTubeAudioError('unreadable', 'metadata was not JSON');
    }
    /* No server sign-in exists for these sites, so only the caller's age rule applies here: a
     * child's account is refused an age-restricted listing before anything is downloaded. */
    const details = readAudioMetadata(json, maxSeconds, true, options.allowAgeRestricted === true, {
      lengthOptional: true,
      fallbackTitle: `Song from ${link.siteName}`,
    });
    const listed = listedHosts(json);
    if (listed.problem) throw new YouTubeAudioError('blocked-address', `listing: ${listed.problem}`);
    if (listed.hosts.length > 40) throw new YouTubeAudioError('failed', 'the listing names too many hosts');
    for (const host of listed.hosts) {
      if ((await publicHost(host, options.resolve ?? systemResolve)) === 'blocked-address')
        throw new YouTubeAudioError('blocked-address', `listing sends the download to ${host}`);
    }
    const info = join(directory, 'info.json');
    await writeFile(info, JSON.stringify(json));
    let printed: string;
    try {
      printed = (
        await command(
          ytDlp(),
          [
            ...siteArgs(),
            '--load-info-json',
            info,
            '--max-filesize',
            String(sourceCap(options.maxBytes)),
            '--match-filter',
            `duration <? ${Math.ceil(maxSeconds)} & !is_live`,
            '-f',
            'ba/b[height<=480]/b',
            ...ffmpegLocation(),
            '-o',
            join(directory, 'source.%(ext)s'),
          ],
          signal,
          undefined,
          1024 * 1024,
        )
      ).toString();
    } catch (error) {
      log(`${link.site}: download failed: ${reason(error)}`);
      throw siteFailure(error, signal);
    }
    const tail = printed.replace(/\s+/g, ' ').trim().slice(-300);
    if (/larger than max-filesize/i.test(printed)) throw new YouTubeAudioError('too-large', tail);
    const names = (await readdir(directory)).sort();
    const source = names.find((name) => /^source\.[a-z\d]+$/i.test(name));
    if (!source) throw new YouTubeAudioError('failed', `no media file; yt-dlp said: ${tail}`);
    const done = await finish(join(directory, source), directory, details.seconds, options);
    return {
      ...done,
      title: details.title,
      uploader: details.uploader,
      id: link.id,
      link: link.url,
      site: link.site,
      siteName: link.siteName,
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * One media link's sound as an MP3, or a YouTubeAudioError. The link is read again here whatever
 * the caller passed, so only a link readMediaLink accepts is ever fetched.
 */
export async function mediaAudio(
  value: string | MediaLinkFound,
  options: MediaAudioOptions,
): Promise<MediaAudio> {
  const link = readMediaLink(typeof value === 'string' ? value : value.url);
  if (!('url' in link)) throw new YouTubeAudioError(link.problem);
  if (options.signal.aborted) throw new YouTubeAudioError('timeout', 'stopped before it started');
  if (link.kind === 'youtube')
    return { ...(await youtubeAudio(link.url, options)), site: 'youtube', siteName: 'YouTube' };
  if (link.kind === 'file') return fileAudio(link, options);
  return siteAudio(link, options);
}
