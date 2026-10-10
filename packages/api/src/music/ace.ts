import axios from 'axios';
import type { Router } from 'express';
import type { Hooks, Input, InputBody, Output, Provider } from '../audio/jobs';
import type { YueGuideSetting } from './yue';
import { yueInstrumentalChoice, yueSinging, yueTakeCost } from './yue';
import { createAudioRouter } from '../audio/jobs';

/* ACE-Step 1.5 XL: the booth's second song engine, beside YuE2. It runs on its own RunPod endpoint
 * (ACE_ENDPOINT_ID) and is off until ACE_ENABLED=1. While ACE_ADMIN_ONLY is on (the default) only an
 * admin account sees it or may start a take. With the flag unset nothing here changes a guide, a
 * request or an answer. The worker's request and answer shapes are in the ACE contract; take 0 of its
 * answer sits at the top level, so the shared audio router reads it exactly like a YuE2 answer. */

export type AceModel = 'xl-turbo' | 'xl-sft';
export type AceUser = { role?: string | null } | null | undefined;
export type AceVerdict = { ok: true } | { ok: false; error: string };

/** What RunPod receives as the job's `input`. Always one take; another take is another request. */
export type AceRequest = {
  model: AceModel;
  caption: string;
  lyrics: string;
  duration: number;
  seed: number;
  batch_size: 1;
  bpm?: number;
};

/** The settings as saved on the project, in the words the guide shows, so Open in the booth restores them. */
export type AceProjectOptions = {
  quality: string;
  length: string;
  singing: string;
  lyrics: string;
  seed: number;
};

/** What the asset keeps about a finished take; only what the worker really reported. */
export type AceTakeFacts = {
  gpu?: string;
  model?: string;
  instrumental?: boolean;
  bpm?: number;
  keyscale?: string;
};

export type AceGuideSetting = YueGuideSetting & { min?: number; max?: number };
export type AceGuideEntry = {
  name: string;
  tagline: string;
  where: string;
  cost: string;
  bestFor: string[];
  notFor: string[];
  howToWrite: string[];
  settings: AceGuideSetting[];
};

export const aceQuality: { fast: string; best: string } = { fast: 'Fast', best: 'Best' };
export const aceMatchLyrics = 'Match my lyrics';
export const aceCost: string =
  'ACE-Step XL does not deduct from your credit balance yet, and there is no per-song estimate. GPU time is billed by the second, including startup and two minutes awake after the last job; Best uses more.';

const ACE_OFF = 'ACE-Step XL is not turned on yet.';
const ACE_CLOSED = 'ACE-Step XL is not open to your account yet.';
const ACE_NO_COVERS = 'ACE-Step XL does not take a recording to cover. Use YuE2 for covers.';
const DIRECTION_SENTENCE = 'Describe the music in 3 to 3000 characters.';
const CAPTION_LIMIT = 512;
const LYRICS_LIMIT = 4096;
const SEED_LIMIT = 2147483647;
const MIN_BPM = 30;
const MAX_BPM = 300;
const MIN_SECONDS = 30;
const DEFAULT_MAX_SECONDS = 360;
const MATCH_CEILING_SECONDS = 300;
const INSTRUMENTAL_SECONDS = 120;
/** What the worker reads as "no singing". */
const INSTRUMENTAL_TAG = '[Instrumental]';
/* Match my lyrics: 20 seconds for the intro and outro, 3.7 for each sung line, to the nearest five
 * (the desk aims for about four minutes at 50 to 70 lines). A starting point for the first listening
 * test, not a measurement; the tests pin a table so a change is deliberate. */
const LYRIC_BASE_SECONDS = 20;
const LYRIC_SECONDS_PER_LINE = 3.7;
const ACE_EXECUTION_TIMEOUT_MS = 1200000;
const ACE_PROVIDER_TTL_MS = 7200000;

/* ---------- flags: every one defaults to off, closed or the stated default ---------- */

function lowered(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export function aceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ACE_ENABLED === '1';
}
/** ACE_ADMIN_ONLY: on unless it says 0, false, no or off. Anything unreadable stays closed. */
export function aceAdminOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return !['0', 'false', 'no', 'off'].includes(lowered(env.ACE_ADMIN_ONLY ?? '1'));
}
/** The endpoint and key, not the flag: turning ACE_ENABLED off must not strand takes already queued. */
export function aceConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.ACE_ENDPOINT_ID && env.RUNPOD_API_KEY);
}
export function aceDefaultModel(env: NodeJS.ProcessEnv = process.env): AceModel {
  return lowered(env.ACE_DEFAULT_MODEL) === 'xl-sft' ? 'xl-sft' : 'xl-turbo';
}
/** ACE_MAX_SECONDS as a whole number from 60 to 600, else 360. */
export function aceMaxSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const said = Number(String(env.ACE_MAX_SECONDS ?? '').trim());
  return Number.isInteger(said) && said >= 60 && said <= 600 ? said : DEFAULT_MAX_SECONDS;
}

/** Whether this account may use ACE-Step XL now, and the plain sentence when it may not. */
export function aceAccess(user: AceUser, env: NodeJS.ProcessEnv = process.env): AceVerdict {
  if (!aceEnabled(env)) return { ok: false, error: ACE_OFF };
  if (!user) return { ok: false, error: ACE_CLOSED };
  if (!aceAdminOnly(env)) return { ok: true };
  const admin = String(user.role ?? '').toUpperCase() === 'ADMIN';
  return admin ? { ok: true } : { ok: false, error: ACE_CLOSED };
}
export function aceAllowed(user: AceUser, env: NodeJS.ProcessEnv = process.env): boolean {
  return aceAccess(user, env).ok;
}

/* ---------- Music direction -> caption and tempo ---------- */

/* "88 BPM", "~88 bpm", "around 88 BPM", "at 88bpm", "a 90-BPM groove", and a range such as "88-92 BPM" (two values). */
const BPM_PHRASE =
  /(?:\b(?:around|about|roughly|approximately|at)\s+|~\s*)?\b(\d{2,3}(?:\.\d+)?(?:\s*(?:-|–|—|to)\s*\d{2,3}(?:\.\d+)?)?)[\s-]*bpm\b/i;
const BPM_PHRASE_ALL = new RegExp(BPM_PHRASE.source, 'gi');
const NUMBER = /\d+(?:\.\d+)?/g;

/** Joins what stood either side of a removed tempo without leaving a stray comma, bracket or full stop. */
function joinAround(left: string, right: string): string {
  const head = left.trimEnd();
  const tail = right.trimStart();
  if (!head) return tail.replace(/^[\s,;:.\-–—]+/, '');
  if (!tail) return head.replace(/[\s,;:\-–—]+$/, '');
  if (/[([]$/.test(head) && /^[)\]]/.test(tail))
    return joinAround(head.slice(0, -1), tail.slice(1));
  if (/[([]$/.test(head)) return head + tail.replace(/^[\s,;:]+/, '');
  if (/^[)\]]/.test(tail)) return head.replace(/[\s,;:]+$/, '') + tail;
  if (!/^[,;:.]/.test(tail)) return `${head} ${tail}`;
  if (head.endsWith('.')) return `${head} ${tail.replace(/^[\s,;:.]+/, '')}`;
  return head.replace(/[,;:]+$/, '') + tail;
}

function withoutTempo(direction: string): string {
  const found = BPM_PHRASE.exec(direction);
  if (!found) return direction;
  const rest = joinAround(
    direction.slice(0, found.index),
    direction.slice(found.index + found[0].length),
  );
  return withoutTempo(rest);
}

/** The one tempo Music direction names, 30 to 300; none when it names two different ones or one out of range. */
function tempoIn(direction: string): number | undefined {
  const values = new Set(
    Array.from(direction.matchAll(BPM_PHRASE_ALL)).flatMap((found) =>
      (found[1].match(NUMBER) ?? []).map((value) => Math.round(Number(value))),
    ),
  );
  const [bpm] = Array.from(values);
  if (values.size !== 1 || bpm < MIN_BPM || bpm > MAX_BPM) return undefined;
  return bpm;
}

/** Cuts at the last whitespace at or before 512 characters (counted as the worker counts them, in code points). */
function fitCaption(text: string): { text: string; trimmed: boolean } {
  const chars = Array.from(text);
  if (chars.length <= CAPTION_LIMIT) return { text, trimmed: false };
  const head = chars.slice(0, CAPTION_LIMIT).join('');
  const whole = /\s/.test(chars[CAPTION_LIMIT]);
  const cut = whole ? head : head.replace(/\s+\S*$/, '');
  return { text: cut.replace(/[\s,;:\-–—]+$/, ''), trimmed: true };
}

/**
 * The worker's caption and tempo from Music direction. A tempo such as "88 BPM" moves into the `bpm`
 * field and out of the caption (ACE reads it from the field); everything else stays, trimmed to the
 * 512 characters ACE reads at a word boundary. Two different tempos, or one outside 30 to 300, send no
 * `bpm` and leave the text as written. A direction that is only a tempo keeps its words.
 */
export function aceCaption(direction: string): { caption: string; bpm?: number; trimmed: boolean } {
  const text = direction.trim();
  const bpm = tempoIn(text);
  const stripped =
    bpm === undefined
      ? text
      : withoutTempo(text)
          .replace(/[ \t]{2,}/g, ' ')
          .trim();
  const fitted = fitCaption(stripped || text);
  return { caption: fitted.text, ...(bpm === undefined ? {} : { bpm }), trimmed: fitted.trimmed };
}

/* ---------- length ---------- */

const SECTION_TAG = /^\[[^\]\n]*\]$/;

function sungLines(lyrics: string): number {
  return lyrics
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !SECTION_TAG.test(line)).length;
}

/** "3:05" for 185 seconds. */
function clock(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * Match my lyrics: the song's length from the lyric lines that are sung (tag lines and blank lines
 * are not). 20 seconds plus 3.7 a line, to the nearest five, from 30 seconds up to 5 minutes or the
 * ACE_MAX_SECONDS if lower. No sung line (an instrumental) is two minutes.
 */
export function aceLyricSeconds(lyrics: string, max: number = DEFAULT_MAX_SECONDS): number {
  const lines = sungLines(lyrics);
  const seconds = lines
    ? Math.round((LYRIC_BASE_SECONDS + LYRIC_SECONDS_PER_LINE * lines) / 5) * 5
    : INSTRUMENTAL_SECONDS;
  return Math.min(MATCH_CEILING_SECONDS, max, Math.max(MIN_SECONDS, seconds));
}

function wantsLyricLength(choice: string | number | undefined): boolean {
  if (choice == null) return true;
  return typeof choice === 'string' && ['', lowered(aceMatchLyrics)].includes(lowered(choice));
}

function chosenSeconds(choice: string | number): number | undefined {
  if (typeof choice === 'number') return Number.isFinite(choice) ? Math.round(choice) : undefined;
  if (typeof choice !== 'string') return undefined;
  const form = /^(\d{1,2}):([0-5]\d)$/.exec(choice.trim());
  return form ? Number(form[1]) * 60 + Number(form[2]) : undefined;
}

/**
 * The Length choice as seconds and as the label the guide shows. Nothing or "Match my lyrics" sizes the
 * song from the lyrics (an instrumental ignores them); "M:SS" is that long. Too long is refused, never shortened.
 */
export function aceLength(
  choice: string | number | undefined,
  lyrics: string,
  instrumental: boolean,
  max: number,
): { seconds: number; label: string } {
  if (wantsLyricLength(choice))
    return { seconds: aceLyricSeconds(instrumental ? '' : lyrics, max), label: aceMatchLyrics };
  const seconds = chosenSeconds(choice ?? '');
  if (seconds === undefined)
    throw new Error(`Under Length, choose ${aceMatchLyrics} or a length such as 3:00.`);
  if (seconds > max) throw new Error(`Choose a length up to ${clock(max)}.`);
  if (seconds < MIN_SECONDS) throw new Error(`Choose a length of at least ${clock(MIN_SECONDS)}.`);
  return { seconds, label: clock(seconds) };
}

/* ---------- quality ---------- */

/** Fast is the turbo checkpoint, Best the slower sft one; nothing sent takes ACE_DEFAULT_MODEL. */
export function aceModelChoice(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): AceModel {
  if (value == null) return aceDefaultModel(env);
  const said = typeof value === 'string' ? lowered(value) : '?';
  if (!said) return aceDefaultModel(env);
  if (said === lowered(aceQuality.fast)) return 'xl-turbo';
  if (said === lowered(aceQuality.best)) return 'xl-sft';
  throw new Error(`Under Quality, choose ${aceQuality.fast} or ${aceQuality.best}.`);
}

/* ---------- the request ---------- */

/** The router's parse: validates a booth request and applies every default (a choice she did not touch is not sent). */
export function aceInput(body: InputBody, env: NodeJS.ProcessEnv = process.env): Input {
  if (body.reference_voice_url || body.referenceExpected) throw new Error(ACE_NO_COVERS);
  if (typeof body.script !== 'string' || body.script.trim().length < 3 || body.script.length > 3000)
    throw new Error(DIRECTION_SENTENCE);
  if (body.title != null && (typeof body.title !== 'string' || body.title.length > 80))
    throw new Error('Use a title up to 80 characters.');
  const instrumental = yueInstrumentalChoice(body.singing);
  const lyrics = typeof body.lyrics === 'string' ? body.lyrics.trim() : '';
  const length = Array.from(lyrics).length;
  if (!instrumental && !lyrics)
    throw new Error(
      'Add the words to sing in Lyrics, or choose Instrumental under Singing or instrumental.',
    );
  if (length > LYRICS_LIMIT)
    throw new Error(
      instrumental
        ? `Keep Lyrics to ${LYRICS_LIMIT} characters. An instrumental sings none of them.`
        : `Those lyrics are ${length} characters; ACE-Step XL reads at most ${LYRICS_LIMIT}. Cut a verse or a repeated chorus and try again.`,
    );
  if (
    body.seed != null &&
    (!Number.isInteger(body.seed) || body.seed < 0 || body.seed > SEED_LIMIT)
  )
    throw new Error(`Seed must be a whole number from 0 to ${SEED_LIMIT}.`);
  const direction = body.script.trim();
  const model = aceModelChoice(body.quality, env);
  const song = aceLength(body.length, lyrics, instrumental, aceMaxSeconds(env));
  const { bpm } = aceCaption(direction);
  return {
    style: direction,
    title: body.title?.trim() || direction.split(/\s+/).slice(0, 7).join(' ').slice(0, 80),
    count: 1,
    lyrics,
    ...(instrumental ? { instrumental: true } : {}),
    duration: song.seconds,
    model,
    ...(bpm === undefined ? {} : { bpm }),
    length_choice: song.label,
    seed: body.seed ?? Math.floor(Math.random() * SEED_LIMIT),
  };
}

/** The worker job for one take. The sheet goes through whole (never cut); an instrumental sends the tag the worker reads. */
export function aceRequest(input: Input): AceRequest {
  const sung = input.instrumental ? '' : (input.lyrics ?? '');
  return {
    model: input.model ?? 'xl-turbo',
    caption: aceCaption(input.style).caption,
    lyrics: input.instrumental ? INSTRUMENTAL_TAG : sung,
    duration: input.duration ?? aceLyricSeconds(sung),
    seed: input.seed,
    batch_size: 1,
    ...(input.bpm ? { bpm: input.bpm } : {}),
  };
}

/** What is said before anything is spent: the length, the quality, a note if the direction was cut, then the cost. */
export function aceEstimate(input: Input): string {
  const quality = input.model === 'xl-sft' ? aceQuality.best : aceQuality.fast;
  const note = aceCaption(input.style).trimmed
    ? ` Only the first part of Music direction fits; ACE-Step XL reads ${CAPTION_LIMIT} characters.`
    : '';
  return `About ${clock(input.duration ?? 0)} of music, ${quality.toLowerCase()} quality.${note} ${aceCost}`;
}

/* ---------- the project row and the library asset ---------- */

export function aceProjectOptions(input: Input): AceProjectOptions {
  return {
    quality: input.model === 'xl-sft' ? aceQuality.best : aceQuality.fast,
    length: input.length_choice ?? aceMatchLyrics,
    singing: input.instrumental ? yueSinging.instrumental : yueSinging.sung,
    lyrics: input.lyrics ?? '',
    seed: input.seed,
  };
}

/** A library row's reason line. */
export function aceProjectWhy(options?: Partial<AceProjectOptions>): string {
  const made = options?.singing === yueSinging.instrumental ? 'an instrumental' : 'a song';
  const best = options?.quality === aceQuality.best ? ', best quality' : '';
  return `ACE-Step XL — ${made} made on the sleeping music GPU${best}`;
}

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** What the asset keeps about a finished take: the card, the checkpoint and what the planner chose, when the worker said. */
export function aceTakeFacts(output: Output | undefined, input: Input): AceTakeFacts {
  if (!output) return {};
  const facts: AceTakeFacts = {};
  const bpm = finiteNumber(output.plan?.bpm);
  if (typeof output.gpu === 'string') facts.gpu = output.gpu;
  if (typeof output.model === 'string') facts.model = output.model;
  if (typeof output.instrumental === 'boolean') facts.instrumental = output.instrumental;
  else if (input.instrumental === true) facts.instrumental = true;
  if (bpm !== undefined) facts.bpm = bpm;
  if (typeof output.plan?.keyscale === 'string') facts.keyscale = output.plan.keyscale;
  return facts;
}

/**
 * A worker answer as the shared router reads it: take 0 at the top level, where `url` marks a finished take. The
 * worker already answers that way; an answer that lists its takes but leaves take 0 out of the top level is lifted,
 * so a drift between the two never turns a finished song into a failed one. The top level wins when it is there.
 */
export function aceOutput(output: Output): Output {
  const first = output.takes?.[0];
  if (output.url || !first?.url) return output;
  return {
    ...output,
    key: first.key,
    wav_key: first.wav_key,
    url: first.url,
    wav_url: first.wav_url,
    duration_s: first.duration_s,
    bytes: first.bytes,
    seed: output.seed ?? first.seed,
  };
}

/* ---------- the guide ---------- */

/** The ACE-Step XL card for the booth guide: the settings in the order they are shown. */
export function aceGuide(env: NodeJS.ProcessEnv = process.env): AceGuideEntry {
  const max = aceMaxSeconds(env);
  const minutes = Array.from({ length: Math.floor(max / 60) }, (_, index) =>
    clock((index + 1) * 60),
  );
  return {
    name: 'ACE-Step XL',
    tagline: 'Songs with your own lyrics, in the style you describe.',
    where: 'Runs on a music GPU that sleeps between songs.',
    cost: aceCost,
    bestFor: [
      'songs with your own lyrics',
      'a quick draft to hear an idea',
      'a longer song in one pass',
    ],
    notFor: ['covers of a recording: use YuE2', 'cloning a singer’s voice'],
    howToWrite: [
      'Describe the style, instruments and singing voice in Music direction. A tempo such as 88 BPM is read out for you.',
      'Put the exact words under Lyrics, with [Verse] and [Chorus] tags. Words in (parentheses) are sung as backing vocals.',
      'Leave Length on Match my lyrics, or choose a length. Quality Best is slower and costs more.',
    ],
    settings: [
      {
        key: 'singing',
        label: 'Singing or instrumental',
        hint: 'Instrumental plays the tune on instruments and ignores any lyrics.',
        kind: 'choice',
        options: [yueSinging.sung, yueSinging.instrumental],
        default: yueSinging.sung,
      },
      {
        key: 'lyrics',
        label: 'Lyrics',
        hint: 'The words to sing, with [Verse] and [Chorus] tags. Write my song idea can draft them.',
        kind: 'text',
      },
      {
        key: 'quality',
        label: 'Quality',
        hint: 'Fast is quick. Best is slower and costs more.',
        kind: 'choice',
        options: [aceQuality.fast, aceQuality.best],
        default: aceDefaultModel(env) === 'xl-sft' ? aceQuality.best : aceQuality.fast,
      },
      {
        key: 'length',
        label: 'Length',
        hint: 'Match my lyrics sizes the song from your lyric lines.',
        kind: 'choice',
        options: [aceMatchLyrics, ...minutes],
        default: aceMatchLyrics,
      },
      {
        key: 'seed',
        label: 'Optional seed',
        hint: 'Leave blank for a new take; reuse a number for a similar start.',
        kind: 'number',
        min: 0,
        max: SEED_LIMIT,
        advanced: true,
      },
    ],
  };
}

/**
 * The guide for one person. Someone who may use ACE-Step XL gets its card last; everyone else gets
 * the very same object back, so with ACE_ENABLED unset the guide is untouched.
 */
export function withAceGuide<T extends { engines: Record<string, object> }>(
  guide: T,
  user: AceUser,
  env: NodeJS.ProcessEnv = process.env,
): T {
  if (!guide || !guide.engines || !aceAllowed(user, env)) return guide;
  return { ...guide, engines: { ...guide.engines, ace: aceGuide(env) } };
}

/* ---------- the router ---------- */

async function provider(
  path: string,
  data?: { input: AceRequest; policy: { executionTimeout: number; ttl: number } },
): Promise<Provider> {
  const base = `https://api.runpod.ai/v2/${process.env.ACE_ENDPOINT_ID}`;
  const response = await axios.request<Provider>({
    url: `${base}/${path}`,
    method: data || path.startsWith('cancel/') ? 'POST' : 'GET',
    data,
    headers: { Authorization: `Bearer ${process.env.RUNPOD_API_KEY}` },
    timeout: 30000,
  });
  return response.data;
}

export function createAceRouter(hooks: Hooks): Router {
  return createAudioRouter(hooks, {
    engine: 'ace',
    prefix: 'ace_',
    model: 'KadeAceJob',
    name: 'ACE-Step XL',
    configured: () => aceConfigured(),
    parse: (body) => aceInput(body),
    estimate: (input) => ({ spoken: aceEstimate(input) }),
    submit: (input) =>
      provider('run', {
        input: aceRequest(input),
        policy: { executionTimeout: ACE_EXECUTION_TIMEOUT_MS, ttl: ACE_PROVIDER_TTL_MS },
      }),
    status: async (take) => {
      const result = await provider(`status/${encodeURIComponent(take.providerId || '')}`);
      /* How long the job waited for a GPU and how long it ran, kept beside the take as for YuE2. */
      const output = result.output && {
        ...aceOutput(result.output),
        queue_ms: result.delayTime,
        execution_ms: result.executionTime,
      };
      return { ...result, output, costUSD: yueTakeCost(result.executionTime, result.output?.gpu) };
    },
    cancel: async (take) => {
      await provider(`cancel/${encodeURIComponent(take.providerId || '')}`);
    },
    providerTtlMs: ACE_PROVIDER_TTL_MS,
    working: 'ACE-Step XL is composing.',
    stopping:
      'Stop requested for unfinished takes. Finished takes are kept. GPU time already used is still billed.',
  });
}
