import { z } from 'zod';
import axios from 'axios';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import type { Analysis, Chapter, Continuity, FailureClass, Line, Meter, Word } from './types';
import type { Brief } from './prompt';
import { analysisFormat, analysisPrompt, readAnalysis, speakable } from './prompt';
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
 * Delivery direction for the narrator. The voice proxy lifts a leading [tag] into Inworld's
 * instruction field, which Inworld does not bill, but Fish voices are billed for it as text, so
 * it is counted with the spoken words.
 */
const direction = '[clear engaged audio description] ';
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
export type VoiceCatalog = {
  voices: string[];
  describe?: Record<string, string>;
  categories?: { name: string; voices: string[] }[];
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
    })
    .parse(response.data);
  catalog = { at: Date.now(), data };
  hung = undefined;
  return data;
}

/** The video model declined a clip (a safety filter); the same clip will be declined again. */
export class Refusal extends Error {}
/** The model's reply ran out of room; one more try asks for fewer, shorter cues. */
class CutOff extends SyntaxError {}
/** The voice service answered, but not with audio; worth one more try. */
class Unplayable extends Error {}
/** A failure whose message is already a plain sentence for Kade (the provider error is its cause). */
export class Plain extends Error {}

const statusOf = (error: unknown): number | undefined =>
  axios.isAxiosError(error) ? error.response?.status : undefined;
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

/** A provider failure that is worth another try: no answer, a timeout, rate limit or 5xx. */
export function transient(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return error instanceof SyntaxError;
  const status = error.response?.status;
  return !status || [408, 409, 425, 429, 500, 502, 503, 504, 529].includes(status);
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
 * any work (any 4xx, including 429), or the connection never opened. Anything else may be billed.
 */
export function billed(error: unknown): boolean {
  if (error instanceof Halt) return false;
  const cause = root(error);
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
  if (!axios.isAxiosError(cause)) return cause instanceof Error ? cause.message.slice(0, 300) : '';
  const body = cause.response?.data;
  let text: string;
  if (typeof body === 'string') text = body;
  else if (Buffer.isBuffer(body)) text = body.toString('utf8', 0, 600);
  else if (body instanceof ArrayBuffer) text = Buffer.from(body).toString('utf8', 0, 600);
  else text = JSON.stringify(body ?? '');
  return `${cause.response?.status ?? cause.code ?? ''} ${text}`
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
 * unreadable replies with growing waits (at most once after a timeout, which may be billed);
 * a refusal or a bad request is not retried. The known cost is settled even when the reply
 * turns out unusable.
 */
export async function analyze(look: Look, signal: AbortSignal, meter: Meter): Promise<Analysis> {
  const key = process.env.OPENROUTER_KEY;
  if (!key) throw new Plain('Video understanding is not configured.');
  const prompt = analysisPrompt(look.seconds, look.brief, look.state, look.lines, look.before);
  const video = (await readFile(look.file)).toString('base64');
  const maxTokens = look.brief.slowed ? 24000 : 12000;
  const reserve = (look.seconds * 400 * 1.5 + prompt.length * 0.5 + maxTokens * 7.5) / 1e6 + 0.01;
  const model = visionModel();
  let result: Analysis | undefined;
  let previous: unknown;
  let tries = 0;
  let timeouts = 0;
  let cutoffs = 0;
  const retryable = (error: unknown) => {
    if (error instanceof Refusal) return false;
    if (error instanceof CutOff) return ++cutoffs <= 1;
    if (isTimeout(error)) return ++timeouts <= 1;
    return transient(error) || error instanceof z.ZodError;
  };
  await attempt(
    4,
    signal,
    async () => {
      const first = tries++ === 0;
      const loose = previous instanceof SyntaxError && !(previous instanceof CutOff);
      const shorter =
        previous instanceof CutOff
          ? '\n\nYour last reply was too long and was cut off. Give about half as many cues this time, and keep every text short.'
          : '';
      let failure: unknown;
      try {
        await meter('vision', reserve, async () => {
          const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
              model: first ? model : standardModel(model),
              max_tokens: maxTokens,
              reasoning: { effort: look.brief.survey ? 'low' : 'medium' },
              provider: { max_price: { prompt: 1.5, completion: 7.5 } },
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
            {
              headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
              signal,
              timeout: 300000,
              maxRedirects: 0,
              maxBodyLength: 60 * 1024 ** 2,
              maxContentLength: 4 * 1024 ** 2,
            },
          );
          const data = modelSchema.parse(response.data);
          const choice = data.choices[0];
          const cost = data.usage?.cost ?? reserve;
          look.log?.(
            `vision: tier ${data.service_tier ?? 'unknown'}, provider ${data.provider ?? 'unknown'}, finish ${choice?.finish_reason ?? 'none'}${choice?.native_finish_reason ? ` (${choice.native_finish_reason})` : ''}, output ${data.usage?.completion_tokens ?? '?'} tokens (${data.usage?.completion_tokens_details?.reasoning_tokens ?? '?'} reasoning), $${cost.toFixed(4)}`,
          );
          try {
            result = replyOf(choice, look);
          } catch (error) {
            failure = error;
          }
          return { costUSD: cost };
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
  return result;
}

/**
 * Speaks one description through the platform voice proxy. `speed` is the voice engine's own
 * rate (1 to 1.5), which sounds more natural than stretching the audio afterwards. A failed call
 * is tried up to three times (after 5 s and 20 s, or when the proxy's Retry-After says) before
 * the description is given up, because the words were already paid for.
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
  const words = speakable(text);
  if (!words) throw new Plain('There was nothing to say for this description.');
  const input = direction + words;
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
