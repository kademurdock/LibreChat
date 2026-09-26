import { z } from 'zod';
import axios from 'axios';
import type { InternalAxiosRequestConfig } from 'axios';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import type {
  Analysis,
  Chapter,
  Continuity,
  FailureClass,
  Line,
  Meter,
  VisionCall,
  Word,
} from './types';
import type { Brief } from './prompt';
import { analysisFormat, analysisPrompt, readAnalysis, speakable, spokenForm } from './prompt';
import { MediaError } from './media';
import { Halt } from './types';

/**
 * The standard tier by default. `google/gemini-3.8-flash:floor` in KADE_DESCRIPTION_MODEL lets
 * OpenRouter pick the cheapest endpoint, including Google's flex tier at about half the price,
 * where a queued background job may wait longer; retries then use the standard tier.
 */
export const visionModel = (): string =>
  process.env.KADE_DESCRIPTION_MODEL || 'google/gemini-3.8-flash';
/** The same model without the price-sorted variant, for a retry that should not queue on flex. */
export const standardModel = (model: string): string => model.replace(/:floor$/, '');
export const voiceBase = (): string =>
  process.env.KADE_TTS_PROXY_URL || 'https://inworld-tts-proxy-production.up.railway.app';
export const userAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Deepgram Nova-3, multilingual price (the higher of its two), per minute of audio. */
export const transcriptionPerMinute = 0.0052;
/** Deepgram keyterm prompting, added per minute only when keyterms are sent. */
export const keytermPerMinute = 0.0013;
/** Subscription narration is included for users; metered visual analysis and transcription remain separate. */
export const speechPerByte: number = 0;
/**
 * Delivery direction for fish.audio voices only, which read a leading [tag] as their style and
 * bill it as text, so it is counted with the spoken words. Inworld voices get none: the proxy
 * lifted it into Inworld's instruction field, and with it TTS-2 put unpunctuated pauses of up to
 * 383 ms after names and first words (5 to 10 of 24 test lines; none without it, Sep 25 A/B).
 * Fish voices had no such pauses with it.
 */
const fishDirection = '[clear engaged audio description] ';
const dialogueService = 'Dialogue timing (Deepgram)';

const speechSchema = z.object({
  metadata: z.object({ duration: z.number().nonnegative().optional() }).optional(),
  results: z.object({
    channels: z.array(
      z.object({
        detected_language: z.string().max(35).optional().catch(undefined),
        language_confidence: z.number().optional().catch(undefined),
        alternatives: z.array(
          z.object({
            words: z.array(
              z.object({
                word: z.string(),
                punctuated_word: z.string().optional(),
                start: z.number().finite().nonnegative(),
                end: z.number().finite().nonnegative(),
                speaker: z.number().int().nonnegative().optional(),
              }),
            ),
          }),
        ),
      }),
    ),
  }),
});
const modelSchema = z.object({
  id: z.string().max(200).nullable().optional().catch(undefined),
  model: z.string().max(200).nullable().optional().catch(undefined),
  provider: z.string().nullable().optional().catch(undefined),
  service_tier: z.string().nullable().optional().catch(undefined),
  choices: z.array(
    z.object({
      finish_reason: z.string().nullable().optional(),
      native_finish_reason: z.string().nullable().optional().catch(undefined),
      message: z.object({ content: z.string().nullable() }),
    }),
  ),
  usage: z
    .object({
      cost: z.number().nonnegative().optional(),
      is_byok: z.boolean().nullable().optional().catch(undefined),
      cost_details: z
        .object({ upstream_inference_cost: z.number().nullable().optional().catch(undefined) })
        .nullable()
        .optional()
        .catch(undefined),
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      completion_tokens_details: z
        .object({ reasoning_tokens: z.number().nullable().optional() })
        .nullable()
        .optional()
        .catch(undefined),
    })
    .optional(),
});
/**
 * An error OpenRouter sent inside a 200 reply, after the headers had already gone out, with its
 * typed code (`metadata.error_type`, which OpenRouter says to rely on over the number).
 */
const upstreamSchema = z.object({
  error: z.object({
    code: z.union([z.number(), z.string()]).nullable().optional().catch(undefined),
    message: z.string().nullable().optional().catch(undefined),
    metadata: z
      .object({ error_type: z.string().max(100).nullable().optional().catch(undefined) })
      .nullable()
      .optional()
      .catch(undefined),
  }),
});
/** OpenRouter's record of one generation, once it is final (free to read). */
const generationSchema = z.object({
  data: z.object({
    total_cost: z.number().finite().nonnegative(),
    is_byok: z.boolean().nullable().optional().catch(undefined),
    upstream_inference_cost: z.number().nullable().optional().catch(undefined),
    provider_name: z.string().max(200).nullable().optional().catch(undefined),
    native_tokens_reasoning: z.number().nullable().optional().catch(undefined),
  }),
});
/**
 * What an OpenRouter call really cost, from the figures it reports. Without BYOK its `cost` (a
 * generation record's `total_cost`) is the whole charge, and `upstream_inference_cost` repeats it
 * (two live calls on Sep 26 2026: the figures were equal), so the two are never added. With BYOK
 * (`is_byok` true: the provider bills the owner's own key, such as a Google AI Studio key) `cost`
 * is only OpenRouter's fee, and what the provider charged is `upstream_inference_cost` on top.
 * A BYOK figure without a usable provider charge is not a price: the fee alone (possibly 0, when
 * OpenRouter waives it) would book a call the provider billed at next to nothing, so it is
 * undefined and the call is priced as one that reported no cost (the generation record, then the
 * expected cost).
 */
export function realCost(
  cost: number,
  isByok?: boolean | null,
  upstreamCost?: number | null,
): number | undefined {
  if (isByok !== true) return cost;
  if (typeof upstreamCost !== 'number' || !Number.isFinite(upstreamCost) || upstreamCost < 0)
    return undefined;
  return cost + upstreamCost;
}
/** What a generation record says the call really cost (`realCost`); undefined when it cannot say. */
const recordedCost = (record: z.infer<typeof generationSchema>['data']): number | undefined =>
  realCost(record.total_cost, record.is_byok, record.upstream_inference_cost);
export type VoiceCatalog = {
  voices: string[];
  describe?: Record<string, string>;
  categories?: { name: string; voices: string[] }[];
  /** Old spelling ("Voice 541") -> the current described label. */
  renames?: Record<string, string>;
  /** Labels that speak through fish.audio (they sound less natural sped up). */
  fish?: string[];
};
let catalog: { at: number; data: VoiceCatalog } | undefined;
let pending: Promise<VoiceCatalog> | undefined;
let hung: { at: number; error: unknown } | undefined;
/**
 * The voice catalog, cached for five minutes. An old copy answers at once while one shared
 * request refreshes it; with no copy yet, a proxy that did not answer is not waited on again
 * for a minute.
 */
export async function voices(): Promise<VoiceCatalog> {
  if (catalog && Date.now() - catalog.at < 300000) return catalog.data;
  if (catalog) {
    refreshVoices().catch(() => {});
    return catalog.data;
  }
  if (hung && Date.now() - hung.at < 60000) throw hung.error;
  return refreshVoices();
}
function refreshVoices(): Promise<VoiceCatalog> {
  pending ??= fetchVoices()
    .catch((error: unknown) => {
      if (catalog) catalog = { at: Date.now() - 240000, data: catalog.data };
      else if (isTimeout(error)) hung = { at: Date.now(), error };
      throw error;
    })
    .finally(() => {
      pending = undefined;
    });
  return pending;
}
async function fetchVoices(): Promise<VoiceCatalog> {
  const response = await axios.get<VoiceCatalog>(`${voiceBase()}/voices.json`, {
    timeout: 15000,
    maxRedirects: 0,
    maxContentLength: 4 * 1024 ** 2,
    headers: { 'User-Agent': userAgent },
  });
  const data = z
    .object({
      voices: z.array(z.string().min(1).max(120)).max(3000),
      describe: z.record(z.string()).optional(),
      categories: z
        .array(z.object({ name: z.string().max(120), voices: z.array(z.string().max(120)) }))
        .max(200)
        .optional()
        .catch(undefined),
      renames: z.record(z.string().max(160)).optional().catch(undefined),
      fish: z.array(z.string().max(120)).max(3000).optional().catch(undefined),
    })
    .parse(response.data);
  catalog = { at: Date.now(), data };
  hung = undefined;
  return data;
}

/** The video model declined a clip (a safety filter); the same clip will be declined again. */
export class Refusal extends Error {}
/**
 * The model's reply ran out of room; one more try asks for fewer, shorter cues, or, when its
 * reasoning used up the room (`thinking`), caps the reasoning instead.
 */
class CutOff extends SyntaxError {
  thinking?: boolean;
}
/** The voice service answered, but not with audio; worth one more try. */
class Unplayable extends Error {}
/** A failure whose message is already a plain sentence for Kade (the provider error is its cause). */
export class Plain extends Error {}
/**
 * An error OpenRouter sent inside a 200 reply (`{"error":{"code","message"}}`), which happens when
 * the provider fails after OpenRouter has sent its headers. `status` is its code when that is an
 * HTTP-style number, and is read like an HTTP status everywhere below, except that it never proves
 * the request went unbilled (`billed`).
 */
class Upstream extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** HTTP statuses (and OpenRouter error codes) worth another try. */
const passing: readonly number[] = [408, 409, 425, 429, 500, 502, 503, 504, 529];
const statusOf = (error: unknown): number | undefined =>
  axios.isAxiosError(error)
    ? error.response?.status
    : error instanceof Upstream
      ? error.status
      : undefined;
const isTimeout = (error: unknown): boolean =>
  axios.isAxiosError(error) &&
  !error.response &&
  ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code ?? '');

/** The provider error behind a wrapped one (`new Error(message, { cause })`). */
function root(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < 4; depth++) {
    if (axios.isAxiosError(current) || current instanceof Refusal) return current;
    if (!(current instanceof Error) || current.cause === undefined) return current;
    current = current.cause;
  }
  return current;
}

/**
 * A provider failure that is worth another try: no answer, a timeout, rate limit or 5xx, or an
 * error sent inside a reply unless its code says the request itself was at fault.
 */
export function transient(error: unknown): boolean {
  if (!axios.isAxiosError(error) && !(error instanceof Upstream))
    return error instanceof SyntaxError;
  const status = statusOf(error);
  return !status || passing.includes(status);
}

/** Seconds the provider asked us to wait (Retry-After, in seconds or as a date), if it said. */
export function retryAfter(error: unknown): number | undefined {
  if (!axios.isAxiosError(error)) return undefined;
  const value = error.response?.headers?.['retry-after'];
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(String(value));
  return Number.isFinite(date) ? Math.max(0, (date - Date.now()) / 1000) : undefined;
}

/** Milliseconds to wait after failed try `attempt` (1-based). */
export type Wait = (attempt: number, error: unknown) => number;
/** Exponential waits (base, 3x base, 9x base…) with ±25% jitter, or the provider's Retry-After; at most a minute. */
export const backoff =
  (base: number, random: () => number = Math.random): Wait =>
  (attempt, error) => {
    const asked = retryAfter(error);
    if (asked !== undefined) return Math.min(60000, asked * 1000);
    return Math.min(60000, base * 3 ** (attempt - 1)) * (0.75 + random() * 0.5);
  };
/** Fixed waits, one per retry, unless the provider's Retry-After asks for something else. */
export const steps =
  (waits: number[]): Wait =>
  (attempt, error) => {
    const asked = retryAfter(error);
    return Math.min(
      60000,
      asked !== undefined ? asked * 1000 : waits[Math.min(attempt, waits.length) - 1],
    );
  };

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', stop, { once: true });
  });

/** Runs a paid step at most `tries` times, waiting between attempts; permanent errors stop at once. */
export async function attempt<T>(
  tries: number,
  signal: AbortSignal,
  action: () => Promise<T>,
  retryable: (error: unknown) => boolean = transient,
  wait: Wait = (i) => 2500 * i,
): Promise<T> {
  for (let i = 1; ; i++) {
    signal.throwIfAborted();
    try {
      return await action();
    } catch (error) {
      if (i >= tries || signal.aborted || !retryable(error)) throw error;
      await pause(wait(i, error), signal);
    }
  }
}

/** Describes a provider error in words without leaking request details. */
export function providerProblem(error: unknown, service: string): string {
  if (error instanceof Plain || error instanceof Unplayable) return error.message;
  const cause = root(error);
  if (cause instanceof Refusal) return `${service} declined to describe this scene.`;
  if (cause instanceof CutOff)
    return `${service} had too much to say about this part to fit in one reply. Describe this part again with less detail, or without the closer look.`;
  if (
    cause instanceof Error &&
    !axios.isAxiosError(cause) &&
    typeof (cause as Error & { detail?: unknown }).detail === 'string'
  )
    return cause.message;
  if (cause instanceof Upstream)
    return cause.status === 402
      ? `${service} needs its account balance topped up (code 402).`
      : `${service} stopped with an error before finishing its reply${cause.status ? ` (code ${cause.status})` : ''}.`;
  if (!axios.isAxiosError(cause)) return `${service} sent a reply the server could not read.`;
  const status = cause.response?.status;
  if (status === 400) return `${service} could not use this request (HTTP 400).`;
  if (status === 401 || status === 403)
    return `${service} refused the account key (HTTP ${status}).`;
  if (status === 402) return `${service} needs its account balance topped up (HTTP 402).`;
  if (status === 404)
    return `${service} could not find the model or address it was sent to (HTTP 404).`;
  if (status === 413) return `${service} said the clip was too large (HTTP 413).`;
  if (status === 429) return `${service} is busy right now (HTTP 429).`;
  if (status) return `${service} did not complete the request (HTTP ${status}).`;
  return isTimeout(cause)
    ? `${service} took too long to answer.`
    : `${service} could not be reached.`;
}

/**
 * Why a step failed: `refused` (the model declined this content), `input` (this clip or request
 * cannot work as it is, including a reply still cut off after the shorter retry), or `transient`
 * (worth trying again later, including a full disk, a crashed media tool, and account problems
 * that stop the job until they are fixed).
 */
export function failureClass(error: unknown): FailureClass {
  const cause = root(error);
  if (cause instanceof Refusal) return 'refused';
  if (cause instanceof CutOff) return 'input';
  if (cause instanceof MediaError && (cause.kind === 'disk' || cause.kind === 'tools'))
    return 'transient';
  const status = statusOf(cause);
  if (status === 400 || status === 413 || status === 422) return 'input';
  if (
    cause instanceof Error &&
    !axios.isAxiosError(cause) &&
    typeof (cause as Error & { detail?: unknown }).detail === 'string'
  )
    return 'input';
  return 'transient';
}

/**
 * False only when the provider certainly did not charge: it refused the request before doing
 * any work (any 4xx HTTP status, including 429), or the connection never opened. Anything else
 * may be billed, including an error sent inside a 200 reply whatever its code: the provider had
 * already taken the request, and may charge for reading it.
 */
export function billed(error: unknown): boolean {
  if (error instanceof Halt) return false;
  const cause = root(error);
  if (cause instanceof Upstream) return true;
  if (!axios.isAxiosError(cause)) return true;
  const status = cause.response?.status;
  if (status) return status >= 500;
  return !['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_INVALID_URL', 'ERR_BAD_OPTION'].includes(
    cause.code ?? '',
  );
}

/** The provider's own error text for the server log: at most 300 characters, keys removed. */
export function providerDetail(error: unknown): string {
  const cause = root(error);
  let text: string;
  if (cause instanceof Upstream) text = `code ${cause.status ?? 'none'} ${cause.message}`;
  else if (!axios.isAxiosError(cause)) text = cause instanceof Error ? cause.message : '';
  else if (!cause.response) text = `${cause.code ?? ''} ${cause.message}`;
  else {
    const body = cause.response.data;
    let said: string;
    if (typeof body === 'string') said = body;
    else if (Buffer.isBuffer(body)) said = body.toString('utf8', 0, 600);
    else if (body instanceof ArrayBuffer) said = Buffer.from(body).toString('utf8', 0, 600);
    else said = JSON.stringify(body ?? '');
    text = `${cause.response.status} ${said}`;
  }
  return text
    .replace(
      /(sk-[\w-]{8,}|bearer\s+[\w.~+/=-]+|token\s+[\w.~+/=-]{16,}|key=[\w.~+/=-]+)/gi,
      '[hidden]',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** Words Deepgram would otherwise mishear: call letters, local names and her notes' names. */
const commonCapitals: ReadonlySet<string> = new Set(
  'a an and are as at be but by for from he her here his how i in is it its my no not of on or our she so that the their them then there these they this those to was we were what when where who why will with you your also please note notes mom dad new old live full rare best part video clip tape vhs dvd tv hd sd the'.split(
    ' ',
  ),
);
const commonAcronyms: ReadonlySet<string> = new Set(
  'TV HD SD UHD VHS DVD VCR CD MP3 MP4 MOV AVI MKV VID IMG USA US UK OK AM PM FM CC NEW LIVE FULL RARE OLD BEST PART ALL ONE TWO ID IDS PSA FAQ VOL EP OST LOL OMG DIY ASMR HQ LQ AI THE AND FOR WITH FROM THIS THAT WHAT WHEN WHO WHY HOW WOW WAS WAY WEB WIN KID KIDS KEEP KING WEEK WILL WORLD WORK WALK WANT WHITE WEST'.split(
    ' ',
  ),
);
const callSign = /\b(?:[KW][A-Z]{2,3}(?:-(?:TV|DT|FM|AM|LP|CD))?|[KW][A-Z]\d{1,2})\b/g;
const acronym = /\b[A-Z][A-Z0-9]{1,4}\b/g;
const capitalized = /\b\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*){0,2}/gu;

function properNames(text: string): string[] {
  return [...text.matchAll(capitalized)].flatMap((match) => {
    const words = match[0].split(/\s+/);
    while (words.length && commonCapitals.has(words[0].toLowerCase())) words.shift();
    const term = words.join(' ').replace(/['’]s$/, '');
    return term.length >= 3 && !commonCapitals.has(term.toLowerCase()) ? [term] : [];
  });
}
const signs = (text: string) =>
  [...text.matchAll(callSign), ...text.matchAll(acronym)]
    .map((match) => match[0])
    .filter((term) => !commonAcronyms.has(term));
/** True when most words start with a capital, as in a title-cased title. */
const titleCased = (text: string) => {
  const words = text.split(/\s+/).filter((word) => /\p{L}/u.test(word));
  return words.filter((word) => /^\p{Lu}/u.test(word)).length > words.length * 0.6;
};
const labelled =
  /^\s*(?:call (?:letters|sign)s?|station|network|brand|advertiser|market|channel|sponsor)\s*[:=]\s*(.{2,40}?)\s*$/gim;
/** The owner in a title-cased title's possessive ("Daffy Duck's Insane Pranks"): a name, not a heading word. */
const possessive = /\p{Lu}[\p{L}-]*(?:\s+\p{Lu}[\p{L}-]*){0,2}(?=['’]s(?![\p{L}\p{N}]))/gu;
const owners = (title: string) =>
  properNames([...title.matchAll(possessive)].map((match) => match[0]).join('\n'));

/**
 * Up to 25 keyterms for Deepgram from high-signal sources only: her notes, chapter titles,
 * labelled library facts, call letters, proper names in a title written in sentence case, and
 * the owner of a possessive in a title-cased title. Free-form uploader text is never mined for names.
 */
export function keytermsFor(input: {
  title: string;
  notes: string;
  about: string;
  chapters?: Chapter[];
}): string[] {
  const chapters = (input.chapters ?? []).map((chapter) => chapter.title).join('\n');
  const about = input.about ?? '';
  const candidates = [
    ...properNames(input.notes),
    ...signs(input.notes),
    ...[...about.matchAll(labelled)].map((match) => match[1]),
    ...[...about.matchAll(callSign)].map((match) => match[0]).filter((term) => /-|\d/.test(term)),
    ...signs(input.title),
    ...signs(chapters),
    ...properNames(chapters),
    ...(titleCased(input.title) ? owners(input.title) : properNames(input.title)),
  ];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of candidates) {
    const term = raw.replace(/\s+/g, ' ').trim().slice(0, 40);
    const key = term.toLowerCase();
    if (term.length < 2 || seen.has(key) || commonAcronyms.has(term)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= 25) break;
  }
  return terms;
}

function deepgramProblem(error: unknown): string {
  return statusOf(error) === 400
    ? `${dialogueService} could not read this soundtrack (HTTP 400).`
    : providerProblem(error, dialogueService);
}

export async function transcribe(
  file: string,
  seconds: number,
  signal: AbortSignal,
  meter: Meter,
  hints?: { keyterms?: string[]; onLanguage?: (code: string) => void },
): Promise<Word[]> {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Plain('Dialogue timing is not configured.');
  const bytes = (await stat(file)).size;
  let words: Word[] = [];
  let language: string | undefined;
  const listen = (terms: string[]) => {
    const perMinute = transcriptionPerMinute + (terms.length ? keytermPerMinute : 0);
    const params = new URLSearchParams({
      model: 'nova-3',
      smart_format: 'true',
      diarize: 'true',
      detect_language: 'true',
      filler_words: 'true',
    });
    for (const term of terms) params.append('keyterm', term);
    return attempt(
      3,
      signal,
      () =>
        meter('transcription', (seconds / 60) * perMinute + 0.002, async () => {
          const response = await axios.post(
            `https://api.deepgram.com/v1/listen?${params.toString()}`,
            createReadStream(file),
            {
              headers: {
                Authorization: `Token ${key}`,
                'Content-Type': 'audio/mp4',
                'Content-Length': String(bytes),
              },
              signal,
              timeout: 20 * 60000,
              maxRedirects: 0,
              maxBodyLength: 1024 ** 3,
              maxContentLength: 256 * 1024 ** 2,
            },
          );
          const data = speechSchema.parse(response.data);
          const channel = data.results.channels[0];
          const alternative = channel?.alternatives[0];
          if (!alternative) throw new Plain(`${dialogueService} returned no result.`);
          words = alternative.words
            .filter((word) => word.end > word.start)
            .map((word) => ({
              word: word.punctuated_word || word.word,
              start: word.start,
              end: word.end,
              speaker: word.speaker,
            }));
          const sure =
            channel.language_confidence === undefined || channel.language_confidence >= 0.5;
          language = channel.detected_language && sure ? channel.detected_language : undefined;
          const heard = data.metadata?.duration ?? seconds;
          return { costUSD: (heard / 60) * perMinute };
        }),
      transient,
      steps([10000, 30000]),
    );
  };
  const terms = (hints?.keyterms ?? []).filter(Boolean).slice(0, 50);
  try {
    try {
      await listen(terms);
    } catch (error) {
      if (!terms.length || statusOf(error) !== 400) throw error;
      await listen([]);
    }
  } catch (error) {
    if (signal.aborted || error instanceof Halt) throw error;
    if (axios.isAxiosError(error)) throw new Plain(deepgramProblem(error), { cause: error });
    if (error instanceof z.ZodError)
      throw new Plain(`${dialogueService} sent a reply the server could not read.`, {
        cause: error,
      });
    throw error;
  }
  if (language) hints?.onLanguage?.(language);
  return words;
}

/** Groups timed words into readable lines, breaking at a new voice or a pause. */
export function linesFrom(words: Word[], start: number = 0, end: number = Infinity): Line[] {
  const lines: Line[] = [];
  for (const word of words) {
    if (word.end <= start || word.start >= end) continue;
    const last = lines[lines.length - 1];
    if (
      last &&
      last.speaker === word.speaker &&
      word.start - last.end < 0.9 &&
      last.text.length < 220 &&
      !/[.!?]$/.test(last.text)
    ) {
      last.text += ' ' + word.word;
      last.end = word.end;
    } else lines.push({ start: word.start, end: word.end, text: word.word, speaker: word.speaker });
  }
  return lines.map((line) => ({ ...line, start: line.start - start, end: line.end - start }));
}

export type Look = {
  file: string;
  seconds: number;
  brief: Brief;
  state: Continuity | null;
  lines: Line[];
  before: Line[];
  /** Server log line per call: tier, provider, finish reason, tokens and cost (no secrets). */
  log?: (message: string) => void;
  /**
   * A section's second look (the engine's re-look after a look that skipped its thinking or
   * crammed its end): it thinks at high effort with room for 48,000 tokens (`planFor`).
   */
  second?: boolean;
};

const declined: ReadonlySet<string> = new Set([
  'SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'RECITATION',
  'IMAGE_SAFETY',
]);

type Choice = z.infer<typeof modelSchema>['choices'][number];

/** How a look asks the model to think (OpenRouter's `reasoning`): an effort, or a token budget. */
type Reasoning = { effort: 'low' | 'medium' | 'high' } | { max_tokens: number };
/**
 * How one look asks: how it thinks, how many output tokens (reasoning included) it may write, how
 * many reasoning tokens it is expected to write, and how long the request may take.
 */
type LookPlan = {
  reasoning: Reasoning;
  maxTokens: number;
  reasoningTokens: number;
  requestMs: number;
};
/**
 * A close look's thinking budget (`reasoning.max_tokens`), and its expected reasoning. In the Road
 * Runner close-look A/B of Sep 26 2026 (22 paid looks on google/gemini-3.8-flash) this budget
 * reasoned 4,703 to 7,248 tokens in 6 of 7 finished looks, all in step, for $0.037 to $0.057 a
 * look, the cheapest setting; the seventh (1,786, AI Studio, $0.019) stretched like production's
 * medium looks and is caught by the engine's `reasoningFloor`. Effort medium ranged from 869 to
 * 18,954 tokens, and every look that stretched the timeline 1.6 times had reasoned 1,125 to 1,786.
 */
const closeReasoningTokens = 8000;
/**
 * Room for a second look, which thinks at high effort. In the same A/B, high effort at 24,000
 * tokens reasoned 21,383 and 23,040 tokens in 2 of 3 looks and was cut off (MAX_TOKENS) with no
 * usable reply; at 48,000 both looks reasoned 12,897 to 18,260 and were in step, for $0.086 to
 * $0.103.
 */
const secondLookTokens = 48000;
/**
 * Reasoning tokens a look asked by effort is expected to write, from the same A/B: high 9,947 to
 * 23,040 (mean about 15,500 over seven looks), medium 869 to 18,954 (mean about 5,800 over seven).
 * Low was not measured: about a fifth of its 12,000 tokens, OpenRouter's share for low effort.
 */
const effortReasoningTokens = { low: 2400, medium: 6000, high: 16000 };
/**
 * How a look asks. A survey (the whole-film first look) thinks at low effort; a close look (slowed)
 * gets the `closeReasoningTokens` budget in 24,000 output tokens; any other look thinks at medium
 * effort in 12,000. A second look (`Look.second`) thinks at high effort in `secondLookTokens`, and,
 * since Vertex writes about 140 tokens a second (a 48,000-token reply takes about 340 s), gets
 * `visionLimits.secondRequestMs` instead of `requestMs`.
 */
function planFor(look: Look): LookPlan {
  const { survey, slowed } = look.brief;
  if (look.second && !survey)
    return {
      reasoning: { effort: 'high' },
      maxTokens: secondLookTokens,
      reasoningTokens: effortReasoningTokens.high,
      requestMs: visionLimits.secondRequestMs,
    };
  const maxTokens = slowed ? 24000 : 12000;
  const requestMs = visionLimits.requestMs;
  if (survey)
    return {
      reasoning: { effort: 'low' },
      maxTokens,
      reasoningTokens: effortReasoningTokens.low,
      requestMs,
    };
  if (slowed)
    return {
      reasoning: { max_tokens: closeReasoningTokens },
      maxTokens,
      reasoningTokens: closeReasoningTokens,
      requestMs,
    };
  return {
    reasoning: { effort: 'medium' },
    maxTokens,
    reasoningTokens: effortReasoningTokens.medium,
    requestMs,
  };
}
/**
 * The most OpenRouter may charge for a look, in USD per million tokens (sent as `max_price`). The
 * reserve is priced at it, never below the real price per token.
 */
const visionPrice = { prompt: 1.5, completion: 7.5 };
/**
 * google/gemini-3.8-flash's standard list price, in USD per million tokens: what a look OpenRouter
 * never priced is expected to have cost (the `:floor` flex tier is about half of it).
 */
const listPrice = { prompt: 0.75, completion: 3.75 };
/**
 * Prompt tokens per second of the clip as sent (a close look's clip is four times the section).
 * Road Runner's looks of Sep 26 2026 had 34,029 prompt tokens (34,644 on Vertex) for an 89 s
 * section at 4x (356 clip seconds, about 96 a second in all) with a 16,614-character prompt
 * text, and 30,043 for the next 74.5 s section (298 clip seconds, 18,132 characters). 85 a second
 * of clip plus the text at 4 characters a token gives 34,400 and 29,856, and within 1.1% for the
 * two half-section looks (18,550 and 20,326 against 18,757 and 20,488).
 */
const clipTokensPerSecond = 85;
/**
 * Output tokens a look writes besides its reasoning: the Sep 26 A/B's 17 finished whole-section
 * looks wrote 1,228 to 3,271 (mean about 2,460).
 */
const answerTokens = 3000;
/** What sending the clip and the prompt can cost: about 400 tokens a second of video, 3 characters a token. */
const promptUSD = (seconds: number, prompt: string): number =>
  ((seconds * 400 + prompt.length / 3) * visionPrice.prompt) / 1e6;
/** The most one look call can cost, which the meter holds while the call is out. */
const reserveFor = (seconds: number, prompt: string, maxTokens: number): number =>
  promptUSD(seconds, prompt) + (maxTokens * visionPrice.completion) / 1e6 + 0.01;
/**
 * What a look call is expected to have cost when OpenRouter never said, at the list price: its
 * clip (`clipTokensPerSecond`) and prompt text, and the reasoning it was expected to write plus
 * `answerTokens`, never more than its reserve. A close look of Road Runner's 74.5 s second section
 * comes to about $0.064 (it really cost $0.048 to $0.051 with this budget), its second look to
 * about $0.094.
 */
const expectedFor = (
  seconds: number,
  prompt: string,
  reasoningTokens: number,
  reserve: number,
): number =>
  Math.min(
    reserve,
    ((seconds * clipTokensPerSecond + prompt.length / 4) * listPrice.prompt +
      (reasoningTokens + answerTokens) * listPrice.completion) /
      1e6,
  );
/**
 * What a look is expected to cost before it is asked (`expectedFor` with its own `planFor`): for a
 * second look of Road Runner's 74.5 s close section about $0.094 (such looks really cost $0.086 to
 * $0.103), far above the thin first looks that call for one (AI Studio's 1,786-token look: $0.019).
 * The engine's re-look gate needs at least this much room.
 */
export function expectedLook(look: Look): number {
  const prompt = analysisPrompt(look.seconds, look.brief, look.state, look.lines, look.before);
  const plan = planFor(look);
  return expectedFor(
    look.seconds,
    prompt,
    plan.reasoningTokens,
    reserveFor(look.seconds, prompt, plan.maxTokens),
  );
}
/**
 * Whether a cut-off reply's reasoning, not its answer, used up its room: it reasoned at least half
 * of what it wrote. Asking that look for fewer cues would not make room.
 */
const filledByReasoning = (reasoning: unknown, output: unknown): boolean =>
  typeof reasoning === 'number' &&
  typeof output === 'number' &&
  output > 0 &&
  reasoning >= output / 2;
/** The largest reply a look may send (4 MiB). */
const replyBytes = 4 * 1024 ** 2;
const chatURL = 'https://openrouter.ai/api/v1/chat/completions';
/**
 * How long one look request may take from sending to the last byte of its reply (axios's own
 * timeout only notices silence, and OpenRouter keeps a slow reply alive with spaces), a second
 * look's longer limit (`planFor`), and when to ask OpenRouter what a failed request cost:
 * milliseconds after the failure, all within `lookupMs`. Tests shorten them.
 */
export const visionLimits: {
  requestMs: number;
  secondRequestMs: number;
  lookupAtMs: number[];
  lookupMs: number;
} = {
  requestMs: 300000,
  secondRequestMs: 420000,
  lookupAtMs: [5000, 15000, 40000],
  lookupMs: 60000,
};
/**
 * What a failed look request tells the meter, set on the error it throws: OpenRouter's generation
 * id; what the request really cost, from OpenRouter's record of it (`costFrom: 'generation'`,
 * possibly 0) or as the reply itself reported; or, when neither said, what it is expected to have
 * cost (never above its reserve). `interrupted` says whether our own stop had already cut the
 * request off when it failed; a stop that comes later, while its cost is being looked up, does not
 * make the failure ours.
 */
export type FailedCall = {
  generation?: string;
  costUSD?: number;
  costFrom?: 'generation';
  expectedUSD?: number;
  interrupted?: boolean;
};

/**
 * OpenRouter's generation id from a reply's headers, which arrive once the clip is uploaded and a
 * provider has taken the request (5 to 53 s in, usually about 10 s, on Sep 26 2026). A request that
 * fails before them has no id and is priced at its expected cost.
 */
function generationOf(headers: unknown): string | undefined {
  const value = (headers as Record<string, unknown> | undefined)?.['x-generation-id'];
  return typeof value === 'string' && /^[\w.:-]{1,200}$/.test(value) ? value : undefined;
}

/**
 * A streamed reply body as text, at most `limit` bytes (more is the error axios gives for
 * `maxContentLength`). The request's own signal (our stop or its deadline) ends the read at once:
 * the read gives up without waiting for the stream to wind down, and the stream and its request
 * (`request`, whose socket may still be open) are destroyed. That matters for a refused request,
 * whose abort axios no longer watches, so a stalled error body would otherwise hold the read open
 * until the connection died. A connection that drops mid-reply is a network failure like any
 * other. A body that is already text or already parsed is taken as it is.
 */
async function bodyOf(
  data: unknown,
  signal: AbortSignal,
  limit: number,
  config?: InternalAxiosRequestConfig,
  request?: unknown,
): Promise<string> {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (!data || typeof data !== 'object' || !(Symbol.asyncIterator in data))
    return JSON.stringify(data ?? null);
  const stream = data as AsyncIterable<Buffer | string> & { destroy?: (error?: Error) => void };
  let halt: (error: Error) => void = () => {};
  const halted = new Promise<never>((_resolve, reject) => {
    halt = reject;
  });
  const cut = () => {
    const error = new axios.CanceledError(undefined, config);
    halt(error);
    stream.destroy?.(error);
    const socket = request as { destroy?: () => void } | undefined;
    if (typeof socket?.destroy === 'function') socket.destroy();
  };
  const read = async (): Promise<string> => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      const part = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      bytes += part.length;
      if (bytes > limit) {
        const error = new axios.AxiosError(
          `maxContentLength size of ${limit} exceeded`,
          'ERR_BAD_RESPONSE',
          config,
        );
        stream.destroy?.(error);
        throw error;
      }
      chunks.push(part);
    }
    return Buffer.concat(chunks).toString('utf8');
  };
  signal.addEventListener('abort', cut, { once: true });
  try {
    if (signal.aborted) cut();
    return await Promise.race([read(), halted]);
  } catch (error) {
    if (axios.isAxiosError(error)) throw error;
    throw axios.AxiosError.from(error, (error as { code?: string }).code || 'ERR_NETWORK', config);
  } finally {
    signal.removeEventListener('abort', cut);
  }
}

/** A refused request's body (at most 64 KiB), read so the error still says what the provider said. */
async function refusalBody(
  data: unknown,
  signal: AbortSignal,
  config?: InternalAxiosRequestConfig,
  request?: unknown,
): Promise<unknown> {
  const text = (await bodyOf(data, signal, 64 * 1024, config, request).catch(() => '')).trim();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * OpenRouter's reply from its text: the spaces it sends to keep a slow request alive are trimmed,
 * and an error it sent inside the reply is thrown as `Upstream`, carrying the cost the reply
 * reported, if any. That is its documented shape (an `error` object and no choices) and the
 * mid-stream one (the error beside a choice that finished with `error`), which is never read as
 * a finished reply. Its code came after the provider took the request, so a 4xx there does not
 * say the request was bad: the typed code decides where it matters. `max_tokens_exceeded` is a
 * reply that ran out of room (`CutOff`, retried shorter once, as a `length` finish is), and a
 * content filter's decline (`content_policy_violation`, `refusal`) is a `Refusal`. Text that is
 * not JSON fails the schema, as it did before the reply was streamed.
 */
function replyData(text: string): z.infer<typeof modelSchema> {
  const trimmed = text.trim();
  let json: unknown = trimmed;
  try {
    json = JSON.parse(trimmed);
  } catch {
    /* left as text, which the schema refuses */
  }
  const reply = (json && typeof json === 'object' ? json : {}) as {
    error?: unknown;
    choices?: unknown;
    usage?: {
      cost?: unknown;
      is_byok?: unknown;
      cost_details?: { upstream_inference_cost?: unknown } | null;
      completion_tokens?: unknown;
      completion_tokens_details?: { reasoning_tokens?: unknown } | null;
    } | null;
  };
  const choice = Array.isArray(reply.choices)
    ? (reply.choices[0] as { error?: unknown; finish_reason?: unknown } | null | undefined)
    : undefined;
  const said = upstreamSchema.safeParse({ error: choice?.error ?? reply.error });
  if (said.success || choice?.finish_reason === 'error') {
    const code = Number(said.data?.error.code);
    const message = (said.data?.error.message || 'The provider reported an error.').slice(0, 1000);
    const type = said.data?.error.metadata?.error_type;
    const failed = (
      type === 'max_tokens_exceeded'
        ? new CutOff(`The visual description came back cut off: ${message}`)
        : type === 'content_policy_violation' || type === 'refusal'
          ? new Refusal(`The video model declined to describe this scene: ${message}`)
          : new Upstream(message, Number.isInteger(code) && code >= 400 && code < 600 ? code : undefined)
    ) as Error & FailedCall & { thinking?: boolean };
    if (failed instanceof CutOff)
      failed.thinking = filledByReasoning(
        reply.usage?.completion_tokens_details?.reasoning_tokens,
        reply.usage?.completion_tokens,
      );
    const cost = reply.usage?.cost;
    const upstream = reply.usage?.cost_details?.upstream_inference_cost;
    /** A BYOK figure without the provider's charge stays unpriced, so it is looked up (`costed`). */
    const priced =
      typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
        ? realCost(
            cost,
            reply.usage?.is_byok === true,
            typeof upstream === 'number' ? upstream : undefined,
          )
        : undefined;
    if (priced !== undefined) failed.costUSD = priced;
    throw failed;
  }
  return modelSchema.parse(json);
}

/**
 * Sends one look request and reads its reply as it streams in, so OpenRouter's generation id (in
 * the headers) is known even when the reply never finishes. The whole request, headers to last
 * byte, must finish within `requestMs` (the look's `planFor`); missing that is a timeout like
 * axios's own. A refused request's body is read so the error still carries it.
 */
async function askModel(
  body: object,
  key: string,
  signal: AbortSignal,
  heard: (generation: string) => void,
  requestMs: number,
): Promise<z.infer<typeof modelSchema>> {
  const request = new AbortController();
  const stop = () => request.abort(signal.reason);
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  let late = false;
  const deadline = setTimeout(() => {
    late = true;
    request.abort();
  }, requestMs);
  let config: InternalAxiosRequestConfig | undefined;
  const note = (headers: unknown) => {
    const generation = generationOf(headers);
    if (generation) heard(generation);
  };
  try {
    const response = await axios.post(chatURL, body, {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: request.signal,
      timeout: requestMs,
      responseType: 'stream',
      maxRedirects: 0,
      maxBodyLength: 60 * 1024 ** 2,
      maxContentLength: replyBytes,
    });
    config = response.config;
    note(response.headers);
    return replyData(
      await bodyOf(response.data, request.signal, replyBytes, config, response.request),
    );
  } catch (error) {
    const refused = axios.isAxiosError(error) && !!error.response;
    if (axios.isAxiosError(error)) {
      config ??= error.config;
      if (error.response) {
        note(error.response.headers);
        error.response.data = await refusalBody(
          error.response.data,
          request.signal,
          config,
          error.request ?? error.response.request,
        );
      }
    }
    if (late && !signal.aborted && !refused)
      throw new axios.AxiosError(
        `The video model did not finish its reply within ${Math.round(requestMs / 1000)} s.`,
        'ETIMEDOUT',
        config,
      );
    throw error;
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', stop);
  }
}

/**
 * OpenRouter's record of a generation, asked for at `visionLimits.lookupAtMs` after a failure (it
 * answers 404 until the record is final) and never past `visionLimits.lookupMs`, with what it says
 * the call cost (`recordedCost`). A BYOK record without the provider's charge is asked for again
 * like a missing one. Undefined when no priced record appeared or the key was refused; our stop
 * ends the wait at once.
 */
async function generationRecord(
  generation: string,
  key: string,
  signal: AbortSignal,
): Promise<(z.infer<typeof generationSchema>['data'] & { costUSD: number }) | undefined> {
  const began = Date.now();
  for (const at of visionLimits.lookupAtMs) {
    if (at >= visionLimits.lookupMs) break;
    const wait = at - (Date.now() - began);
    if (wait > 0) await pause(wait, signal);
    const left = visionLimits.lookupMs - (Date.now() - began);
    if (left <= 0) break;
    try {
      const response = await axios.get(
        `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generation)}`,
        {
          headers: { Authorization: `Bearer ${key}`, 'User-Agent': userAgent },
          signal,
          timeout: Math.min(15000, left),
          maxRedirects: 0,
          maxContentLength: 1024 ** 2,
        },
      );
      const record = generationSchema.safeParse(response.data);
      const costUSD = record.success ? recordedCost(record.data.data) : undefined;
      if (record.success && costUSD !== undefined) return { ...record.data.data, costUSD };
    } catch (error) {
      if (signal.aborted) throw error;
      const status = statusOf(error);
      if (status === 401 || status === 403) return undefined;
    }
  }
  return undefined;
}

/** What a look request needs to be priced when OpenRouter did not report its cost. */
type Pricing = {
  key: string;
  signal: AbortSignal;
  /** What the request is expected to have cost (`expectedFor`). */
  expectedUSD: () => number;
  log?: (message: string) => void;
};

/**
 * Gives a failed look request what the meter needs to settle it (`FailedCall`): its generation id,
 * whether our own stop had already cut it off, and what it really cost by OpenRouter's record
 * (possibly nothing) when that appears in time, otherwise what it is expected to have cost. A
 * stop that comes while the record is awaited ends the wait, and the request is still priced at
 * its expected cost, since it failed on its own. A request our stop cut off, and a failure the
 * provider certainly did not bill, get no price: the meter settles those as it always has.
 */
async function costed(
  error: unknown,
  generation: string | undefined,
  context: Pricing,
): Promise<unknown> {
  if (!(error instanceof Error)) return error;
  const failed = error as Error & FailedCall;
  if (generation) failed.generation = generation;
  failed.interrupted = context.signal.aborted;
  const known =
    typeof failed.costUSD === 'number' && Number.isFinite(failed.costUSD) && failed.costUSD >= 0;
  if (known || failed.interrupted || !billed(error)) return error;
  if (generation) {
    const record = await generationRecord(generation, context.key, context.signal).catch(
      () => undefined,
    );
    if (record) {
      failed.costUSD = record.costUSD;
      failed.costFrom = 'generation';
      context.log?.(
        `vision: the failed request ${generation} cost $${failed.costUSD.toFixed(4)} by OpenRouter's record (provider ${record.provider_name ?? 'unknown'}${record.is_byok === true ? ', BYOK' : ''}, ${record.native_tokens_reasoning ?? '?'} reasoning tokens)`,
      );
      return error;
    }
  }
  const expected = context.expectedUSD();
  failed.expectedUSD = expected;
  context.log?.(
    `vision: ${context.signal.aborted ? 'the job stopped before OpenRouter recorded' : 'no record of'} what the failed request ${generation ?? 'without a generation id'} cost; booked at the expected $${expected.toFixed(4)}`,
  );
  return error;
}

/**
 * The cost of a finished reply that did not report one: OpenRouter's record of its generation
 * when that appears in time, otherwise what it is expected to have cost, marked uncertain. It is
 * never booked at the reserve.
 */
async function unreported(
  generation: string | undefined,
  context: Pricing,
): Promise<{ costUSD: number; uncertain?: boolean }> {
  const record = generation
    ? await generationRecord(generation, context.key, context.signal).catch(() => undefined)
    : undefined;
  if (record) {
    const { costUSD } = record;
    context.log?.(
      `vision: the reply ${generation} did not report its cost; $${costUSD.toFixed(4)} by OpenRouter's record`,
    );
    return { costUSD };
  }
  const expected = context.expectedUSD();
  context.log?.(
    `vision: the reply ${generation ?? 'without a generation id'} did not report its cost and OpenRouter had no record of it; booked as uncertain at the expected $${expected.toFixed(4)}`,
  );
  return { costUSD: expected, uncertain: true };
}

function replyOf(choice: Choice | undefined, look: Look): Analysis {
  const native = (choice?.native_finish_reason ?? '').toUpperCase();
  if (choice?.finish_reason === 'content_filter' || declined.has(native))
    throw new Refusal('The video model declined to describe this scene.');
  if (choice?.finish_reason === 'length' || native === 'MAX_TOKENS')
    throw new CutOff('The visual description came back cut off.');
  if (!choice?.message.content || (choice.finish_reason && choice.finish_reason !== 'stop'))
    throw new SyntaxError('The visual description came back incomplete.');
  return readAnalysis(choice.message.content, look.seconds, look.brief.detail);
}

/**
 * Asks the video model for one clip's description. Retries rate limits, server errors and
 * unreadable replies with growing waits (at most once after a timeout, which may be billed,
 * including a timeout the provider reported inside its reply); a refusal or a bad request is not
 * retried. A reply cut off at its length is asked once more for about half as many cues, or, when
 * its reasoning used up the room (`filledByReasoning`), with its reasoning capped at a third of its
 * output tokens instead (16,000 for a second look, 4,000 for a normal look; a close look's own
 * 8,000 budget is already that low), since fewer cues would not make room. The
 * known cost is settled even when the reply turns out unusable. A request that fails in a way that
 * may be billed, or a reply that did not report its cost, is priced before the meter settles it:
 * by OpenRouter's record of its generation when one appears within a minute, otherwise at what
 * such a look is expected to cost (`costed`, `unreported`, `expectedFor`), never at its whole
 * reserve. How the look thinks, its output tokens (and so its reserve) and its deadline come from
 * `planFor`.
 */
export async function analyze(look: Look, signal: AbortSignal, meter: Meter): Promise<Analysis> {
  const key = process.env.OPENROUTER_KEY;
  if (!key) throw new Plain('Video understanding is not configured.');
  const prompt = analysisPrompt(look.seconds, look.brief, look.state, look.lines, look.before);
  const video = (await readFile(look.file)).toString('base64');
  const plan = planFor(look);
  const reserve = reserveFor(look.seconds, prompt, plan.maxTokens);
  /** How this try thinks, and what it is expected to reason: the plan's, until a retry caps it. */
  let reasoning: Reasoning = plan.reasoning;
  let reasoningTokens = plan.reasoningTokens;
  const pricing: Pricing = {
    key,
    signal,
    expectedUSD: () => expectedFor(look.seconds, prompt, reasoningTokens, reserve),
    log: look.log,
  };
  const model = visionModel();
  let result: Analysis | undefined;
  let previous: unknown;
  let tries = 0;
  let timeouts = 0;
  let cutoffs = 0;
  const calls: VisionCall[] = [];
  const retryable = (error: unknown) => {
    if (error instanceof Refusal) return false;
    if (error instanceof CutOff) return ++cutoffs <= 1;
    if (isTimeout(error) || (error instanceof Upstream && [408, 504].includes(error.status ?? 0)))
      return ++timeouts <= 1;
    return transient(error) || error instanceof z.ZodError;
  };
  await attempt(
    4,
    signal,
    async () => {
      const first = tries++ === 0;
      const loose = previous instanceof SyntaxError && !(previous instanceof CutOff);
      const cut = previous instanceof CutOff ? previous : undefined;
      /** A cap on the reasoning, when a reply's reasoning used up its room and a cap lowers it. */
      const budget = 'max_tokens' in plan.reasoning ? plan.reasoning.max_tokens : Infinity;
      const cap = Math.round(plan.maxTokens / 3);
      const capped = !!cut?.thinking && cap < budget;
      if (capped) {
        reasoning = { max_tokens: cap };
        reasoningTokens = cap;
        look.log?.(
          `vision: the reasoning used up the cut-off reply's room; asking again with reasoning capped at ${cap} tokens`,
        );
      }
      const shorter =
        cut && !capped
          ? '\n\nYour last reply was too long and was cut off. Give about half as many cues this time, and keep every text short.'
          : '';
      let failure: unknown;
      const asked = first ? model : standardModel(model);
      try {
        await meter('vision', reserve, async () => {
          const began = Date.now();
          let generation: string | undefined;
          let data: z.infer<typeof modelSchema>;
          try {
            data = await askModel(
              {
                model: asked,
                max_tokens: plan.maxTokens,
                reasoning,
                provider: { max_price: { ...visionPrice } },
                messages: [
                  {
                    role: 'user',
                    content: [
                      { type: 'video_url', video_url: { url: `data:video/mp4;base64,${video}` } },
                      { type: 'text', text: prompt + shorter },
                    ],
                  },
                ],
                response_format: loose ? { type: 'json_object' } : analysisFormat,
                usage: { include: true },
              },
              key,
              signal,
              (id) => (generation = id),
              plan.requestMs,
            );
          } catch (error) {
            throw await costed(error, generation, pricing);
          }
          const choice = data.choices[0];
          const usage = data.usage;
          const reported =
            usage?.cost === undefined
              ? undefined
              : realCost(usage.cost, usage.is_byok, usage.cost_details?.upstream_inference_cost);
          if (usage?.cost !== undefined && reported === undefined)
            look.log?.(
              `vision: the BYOK reply gave OpenRouter's fee ($${usage.cost.toFixed(4)}) but not the provider's charge, so it is priced as a reply that reported no cost`,
            );
          const output = usage?.completion_tokens;
          const priced =
            reported === undefined
              ? await unreported(generation || data.id || undefined, pricing)
              : { costUSD: reported };
          const cost = priced.costUSD;
          calls.push(visionCall(asked, data, cost, (Date.now() - began) / 1000, generation));
          look.log?.(
            `vision: tier ${data.service_tier ?? 'unknown'}, provider ${data.provider ?? 'unknown'}, finish ${choice?.finish_reason ?? 'none'}${choice?.native_finish_reason ? ` (${choice.native_finish_reason})` : ''}, output ${output ?? '?'} tokens (${data.usage?.completion_tokens_details?.reasoning_tokens ?? '?'} reasoning), $${cost.toFixed(4)}`,
          );
          try {
            result = replyOf(choice, look);
          } catch (error) {
            if (error instanceof CutOff)
              error.thinking = filledByReasoning(
                usage?.completion_tokens_details?.reasoning_tokens,
                output,
              );
            failure = error;
          }
          return priced;
        });
      } catch (error) {
        previous = error;
        throw error;
      }
      if (failure) {
        previous = failure;
        look.log?.(`vision: ${failure instanceof Error ? failure.message : 'unusable reply'}`);
        throw failure;
      }
    },
    retryable,
    backoff(5000),
  );
  if (!result) throw new Plain('No visual description was returned.');
  return { ...result, vision: calls };
}

/** What OpenRouter said about one call: backend, tier, finish reason, tokens, cost and time. */
function visionCall(
  model: string,
  data: z.infer<typeof modelSchema>,
  costUSD: number,
  seconds: number,
  heard?: string,
): VisionCall {
  const choice = data.choices[0];
  const call: VisionCall = { model, costUSD, seconds: Math.round(seconds * 10) / 10 };
  const generation = data.id || heard;
  if (generation) call.generation = generation;
  if (data.model) call.served = data.model;
  if (data.provider) call.provider = data.provider;
  if (data.service_tier) call.tier = data.service_tier;
  if (choice?.finish_reason) call.finish = choice.finish_reason;
  if (choice?.native_finish_reason) call.nativeFinish = choice.native_finish_reason;
  if (data.usage?.prompt_tokens !== undefined) call.promptTokens = data.usage.prompt_tokens;
  if (data.usage?.completion_tokens !== undefined) call.outputTokens = data.usage.completion_tokens;
  const reasoning = data.usage?.completion_tokens_details?.reasoning_tokens;
  if (typeof reasoning === 'number') call.reasoningTokens = reasoning;
  return call;
}

/**
 * The words sent for a voice: fish.audio voices (named in the catalog's `fish` list) get the
 * delivery direction in front; Inworld voices, and any voice when the catalog cannot be read,
 * get the words alone.
 */
export async function voiceInput(words: string, voice: string): Promise<string> {
  const fish = await voices().then(
    (list) => !!list.fish?.includes(voice),
    () => false,
  );
  return fish ? fishDirection + words : words;
}

/**
 * Speaks one description through the platform voice proxy. `speed` is the voice engine's own
 * rate (1 to 1.5), which sounds more natural than stretching the audio afterwards. A failed call
 * is tried up to three times (after 5 s and 20 s, or when the proxy's Retry-After says) before
 * the description is given up, because the words were already paid for. Every byte sent is
 * booked, including a fish voice's direction. Names are sent in their spoken form (`spokenForm`),
 * so a voice sample says them as a description would; the engine has already added its ledger.
 */
export async function synthesize(
  text: string,
  voice: string,
  session: string,
  file: string,
  speed: number,
  signal: AbortSignal,
  meter: Meter,
): Promise<void> {
  const words = spokenForm(speakable(text));
  if (!words) throw new Plain('There was nothing to say for this description.');
  const input = await voiceInput(words, voice);
  const cost = Buffer.byteLength(input, 'utf8') * speechPerByte;
  await attempt(
    3,
    signal,
    () =>
      meter('speech', cost + 0.0005, async () => {
        const response = await axios.post<ArrayBuffer>(
          `${voiceBase()}/v1/audio/speech`,
          {
            input,
            voice,
            model: 'tts-1',
            speed: Math.min(1.5, Math.max(1, Math.round(speed * 100) / 100)),
            delivery: 'STABLE',
            response_format: 'wav',
          },
          {
            headers: {
              'User-Agent': userAgent,
              'Content-Type': 'application/json',
              'x-kade-tts-session': session.slice(0, 64),
            },
            responseType: 'arraybuffer',
            signal,
            timeout: 120000,
            maxRedirects: 0,
            maxContentLength: 16 * 1024 ** 2,
          },
        );
        const body = Buffer.from(response.data);
        if (!String(response.headers['content-type']).startsWith('audio/') || body.length < 100)
          throw new Unplayable('The selected voice did not return playable audio.');
        await writeFile(file, body);
        return { costUSD: cost };
      }),
    (error) => transient(error) || error instanceof Unplayable,
    steps([5000, 20000]),
  );
}
