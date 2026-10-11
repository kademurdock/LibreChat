import axios from 'axios';
import type { Router } from 'express';
import type { Hooks, Input, InputBody, Output, Provider } from '../audio/jobs';
import type { LibraryAccount } from '../library/access';
import type { YueGuideSetting } from './yue';
import { yueInstrumentalChoice, yueSinging, yueTakeCost } from './yue';
import { createAudioRouter } from '../audio/jobs';
import { libraryReviewSeat } from '../library/access';
import { FAMILY_PACK_NOTE } from '../family/pack';

/* ACE-Step 1.5 XL: the booth's second song engine, beside YuE2. It runs on its own RunPod endpoint
 * (ACE_ENDPOINT_ID) and is off until ACE_ENABLED=1. While ACE_ADMIN_ONLY is on (the default) only an
 * admin account sees it or may start a take. With the flag unset nothing here changes a guide, a
 * request or an answer. The worker's request and answer shapes are in the ACE contract; take 0 of its
 * answer sits at the top level, so the shared audio router reads it exactly like a YuE2 answer.
 *
 * Trained styles (the Style choice: Soul and Suno, see aceStyles) are one flag further in: ACE_STYLES_ENABLED=1, off by
 * default. With it unset the card, every request and every answer are exactly what they were without styles. */

export type AceModel = 'xl-turbo' | 'xl-sft';
export type AceUser = LibraryAccount | null | undefined;
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
  /** The planner's sampling temperature, 0.0 to 2.0. Sent only when Creative variation is off its default (see aceLmTemperature). */
  lm_temperature?: number;
  /** The DiT guidance scale. Sent only for Best, and only when Prompt guidance is off its default (see aceGuidanceScale). */
  guidance_scale?: number;
  /** A styled take only (see aceStyles): the adapter's B2 prefix, how strongly the worker folds it in, and the language it was taught in. */
  lora_key?: string;
  lora_scale?: number;
  vocal_language?: string;
};

/** The settings as saved on the project, in the words the guide shows, so Open in the booth restores them. */
export type AceProjectOptions = {
  quality: string;
  length: string;
  singing: string;
  lyrics: string;
  weirdness: number;
  guidance: number;
  seed: number;
  /** The Style choice and its strength, saved only when she set them (ACE_STYLES_ENABLED), like the YuE2 project does. */
  band?: string;
  style_strength?: number;
};

/** What the worker reported about the adapter it applied; every field optional because only what the worker really said is kept. */
export type AceStyleReport = {
  key?: string;
  name?: string;
  scale?: number;
  tag?: string;
  sha256?: string;
};

/**
 * What the asset keeps about a finished take. The card, checkpoint and planner choices are only what the worker
 * really reported; the two dials are what she set, and the last two are what the worker was actually sent for them
 * (absent when a dial was left alone, and no guidance_scale for a Fast take, which ignores it).
 */
export type AceTakeFacts = {
  gpu?: string;
  model?: string;
  instrumental?: boolean;
  bpm?: number;
  keyscale?: string;
  weirdness?: number;
  guidance?: number;
  lm_temperature?: number;
  guidance_scale?: number;
  /** A styled take: the Style and strength she set, what the worker was sent, what it said it applied, and one plain sentence. */
  band?: string;
  style_strength?: number;
  lora_key?: string;
  lora_scale?: number;
  style?: AceStyleReport;
  takeNote?: string;
};

/** `locked` is the Family feature pack's note on a setting an account outside the pack sees greyed out (see aceStyleAccess). */
export type AceGuideSetting = YueGuideSetting & {
  min?: number;
  max?: number;
  step?: number;
  locked?: string;
};
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
/* The two dials, with the same keys, labels and ranges as the YuE2 card. 50 and 1 are "normal": a request at either
 * default adds nothing to the worker job. */
const WEIRDNESS_DEFAULT = 50;
const WEIRDNESS_MIN = 0;
const WEIRDNESS_MAX = 100;
const GUIDANCE_DEFAULT = 1;
const GUIDANCE_MIN = 1;
const GUIDANCE_MAX = 3;
/* Upstream (acestep/inference.py GenerationParams, pinned ca1e85f): lm_temperature 0.0 to 2.0, default 0.85; the sft
 * checkpoint's guidance_scale default is 7.0. */
const LM_TEMPERATURE_LOW = 0.4;
const LM_TEMPERATURE_NORMAL = 0.85;
const LM_TEMPERATURE_HIGH = 1.3;
const SFT_GUIDANCE_NORMAL = 7;
const SFT_GUIDANCE_PER_STEP = 3;
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

/* ---------- trained styles: the Style choice (ACE_STYLES_ENABLED, off by default) ---------- */

export type AceStyle = { key: string; scale: number };

/* Each row is a LoRA taught to the Best (xl-sft) decoder from real recordings, kept in the private bucket under `key` (a B2
 * prefix) and folded in by the worker for one song. The worker owns the trigger word: it reads it from the adapter's own files,
 * plans on the plain Music direction, and hands the decoder the tagged one. So nothing here puts a word in front of Music
 * direction, and a song's saved direction is exactly what she typed. Every adapter was taught on English words, so a styled
 * request names that language (aceStyleFields). A row, and a clause in aceStyleHint (a test holds the hint to saying every row),
 * is all the booth needs to add a style: the Style options, the strength product, the quote, the notes, the library line and
 * the asset facts all read the row's name and nothing else.
 * Soul (Oct 11 2026): taught from real soul and R&B records (PEFT rank 64, alpha 128). Trained on commercial records, so the
 * whole Style choice is part of the Family feature pack (aceStyleAccess), as the YuE2 Style choice is.
 * Suno (Oct 11 2026): taught from 375 songs made with Suno. It stays behind the same pack as Soul: one gate for the whole Style
 * choice, not one per style. Smoke-tested on the live worker through the same fields as Soul, so the worker needs no change.
 * These styles are not YuE2's: a different model, a different adapter, even where the two menus use the same name (both have a
 * soul, and they are different files), which is why a style never crosses between the engines (see the carry module, which
 * drops the Style fields by key and never compares names).
 * The key must match the worker's ^ace-loras/[A-Za-z0-9._-]{1,60}$ and `scale` stays inside its 0.0 to 1.5. Nothing here names
 * a person or a private folder: this menu is read by everyone who uses the booth. */
export const aceStyles: Record<string, AceStyle> = {
  soul: { key: 'ace-loras/soul-real-v1', scale: 1 },
  suno: { key: 'ace-loras/suno-v1', scale: 1 },
};
export function aceStylesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ACE_STYLES_ENABLED === '1';
}

/** The Style choice's hint on the card (the `band` setting): what each style was taught from, in registry order. It names no
 * person and no folder, and a test holds it to saying every style the registry has. */
export const aceStyleHint: string =
  'A singing style taught to ACE-Step XL. Soul learned from real soul and R&B records; Suno from songs made with Suno. Uses the Best quality. None is plain ACE-Step XL.';
/** Added to the Style hints for an account outside the Family feature pack, so a client that does not read `locked` yet still says why the choice does nothing there. */
export const aceStyleLockedSentence: string =
  ' Part of the Family feature pack, so songs on this account use None, plain ACE-Step XL.';
const STYLE_STRENGTH_HINT =
  'Lower it to blend the style with plain ACE-Step XL. 0 is plain; 1 is the full style. Applies only when a Style is selected.';
const STYLE_QUALITY_HINT = ' A Style always uses Best.';
const STYLE_GUIDANCE_HINT = ' A Style always uses Best, so this applies to it.';
const STYLE_INSTRUMENTAL_HINT = ' Choose None under Style for an instrumental.';
const STYLE_UNAVAILABLE = 'That trained style is not available. Choose None or another style.';
const STYLE_SINGING =
  'Styles are for singing, so an instrumental cannot use one. Set Style to None, or choose Sung under Singing or instrumental.';
const STYLE_STRENGTH_DEFAULT = 1;
const STYLE_STRENGTH_MIN = 0;
const STYLE_STRENGTH_MAX = 1;
/** The language every adapter was taught in; a styled request names it so the planner and the decoder both read English. */
const STYLE_LANGUAGE = 'en';

/** Whether this account may use ACE-Step XL now, and the plain sentence when it may not. The App Review seat never may. */
export function aceAccess(user: AceUser, env: NodeJS.ProcessEnv = process.env): AceVerdict {
  if (!aceEnabled(env)) return { ok: false, error: ACE_OFF };
  if (!user || libraryReviewSeat(user)) return { ok: false, error: ACE_CLOSED };
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

/** "2 minutes 50 seconds" for 170: in words, since a screen reader reads "2:50" as digits. */
function spokenLength(seconds: number): string {
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  const parts = [
    minutes ? `${minutes} minute${minutes === 1 ? '' : 's'}` : '',
    rest ? `${rest} second${rest === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return parts.join(' ') || '0 seconds';
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

/* ---------- Creative variation (weirdness) and Prompt guidance ---------- */

function roundedTo(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

/**
 * Creative variation (weirdness), 0 to 100, as the planner's sampling temperature. It sets the planner and nothing
 * else (the DiT, its steps and its guidance are untouched). Piecewise linear through three points:
 *
 *    weirdness   0 -> 0.40   (predictable)
 *    weirdness  50 -> 0.85   (upstream's default, so 50 changes nothing)
 *    weirdness 100 -> 1.30   (surprising)
 *
 * which is 0.009 a point on both sides, to three decimals; upstream accepts 0.0 to 2.0, so the whole dial is inside
 * it. A value outside 0 to 100 is held at the nearest end; one that is not a number is the default.
 */
export function aceLmTemperature(weirdness: number): number {
  if (!Number.isFinite(weirdness)) return LM_TEMPERATURE_NORMAL;
  const at = Math.min(WEIRDNESS_MAX, Math.max(WEIRDNESS_MIN, weirdness));
  const lower = at <= WEIRDNESS_DEFAULT;
  const [fromAt, from] = lower
    ? [WEIRDNESS_MIN, LM_TEMPERATURE_LOW]
    : [WEIRDNESS_DEFAULT, LM_TEMPERATURE_NORMAL];
  const [toAt, to] = lower
    ? [WEIRDNESS_DEFAULT, LM_TEMPERATURE_NORMAL]
    : [WEIRDNESS_MAX, LM_TEMPERATURE_HIGH];
  return roundedTo(from + ((to - from) * (at - fromAt)) / (toAt - fromAt), 3);
}

/**
 * Prompt guidance, 1 to 3, as the DiT's guidance_scale for the sft ("Best") checkpoint only:
 *
 *    guidance_scale = 7 + 3 x (guidance - 1)      1 -> 7 (upstream's default), 2 -> 10, 3 -> 13
 *
 * The turbo ("Fast") checkpoint has no guidance in upstream, so it is never sent one (see aceRequest). A value outside
 * 1 to 3 is held at the nearest end; one that is not a number is the default.
 */
export function aceGuidanceScale(guidance: number): number {
  if (!Number.isFinite(guidance)) return SFT_GUIDANCE_NORMAL;
  const at = Math.min(GUIDANCE_MAX, Math.max(GUIDANCE_MIN, guidance));
  return roundedTo(SFT_GUIDANCE_NORMAL + SFT_GUIDANCE_PER_STEP * (at - GUIDANCE_DEFAULT), 3);
}

function moved(value: number | undefined, normal: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value !== normal;
}

/** The checkpoint a job really runs on. A styled job (one with a lora_key) is always Best: the adapter was taught on that decoder. */
function effectiveModel(input: Input): AceModel {
  return input.lora_key ? 'xl-sft' : (input.model ?? 'xl-turbo');
}

/**
 * The worker fields the two dials set. Each is there only when its dial is off the default, and the guidance only
 * when the take is Best, so a request at the defaults carries neither and is the job it always was.
 */
function aceDialFields(
  model: AceModel,
  input: Input,
): Pick<AceRequest, 'lm_temperature' | 'guidance_scale'> {
  return {
    ...(moved(input.weirdness, WEIRDNESS_DEFAULT)
      ? { lm_temperature: aceLmTemperature(input.weirdness) }
      : {}),
    ...(model === 'xl-sft' && moved(input.guidance, GUIDANCE_DEFAULT)
      ? { guidance_scale: aceGuidanceScale(input.guidance) }
      : {}),
  };
}

/** A dial's value, or its default when she left it alone; refused in a plain sentence (the same ones YuE2 gives) when it is not a number in range. */
function dial(
  value: number | undefined,
  fallback: number,
  low: number,
  high: number,
  label: string,
  whole: boolean,
): number {
  if (value == null) return fallback;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < low ||
    value > high ||
    (whole && !Number.isInteger(value))
  )
    throw new Error(`${label} must be ${whole ? 'a whole number ' : ''}from ${low} to ${high}.`);
  return value;
}

/* ---------- the Style choice ---------- */

/** The word the Style choice shows for a registry name: "Soul" for `soul`, "Suno" for `suno`. */
function styleLabel(band: string | undefined): string {
  const word = String(band ?? '').trim();
  return word ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : 'chosen';
}

/**
 * The Style she chose, when styles are on and it is not None. A name the registry does not have is refused in YuE2's
 * sentence. With ACE_STYLES_ENABLED unset a `band` is ignored, which is what ACE always did with it.
 */
function styleChoice(band: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (!aceStylesEnabled(env) || !band || band === 'none') return undefined;
  if (typeof band !== 'string' || !Object.prototype.hasOwnProperty.call(aceStyles, band))
    throw new Error(STYLE_UNAVAILABLE);
  return band;
}

/**
 * The strength the worker is sent: the registry's scale times the strength she set, to four places. The worker reads a
 * strength of 0 as a plain song, so a product that rounds to 0 (a strength of 0.00004, say) is no style here either,
 * and is never sent as Best with an adapter that does nothing.
 */
function styleScale(row: AceStyle, strength: number): number {
  return roundedTo(row.scale * strength, 4);
}

/** What the request carries for a styled job, and nothing for any other. */
function aceStyleFields(
  input: Input,
): Pick<AceRequest, 'lora_key' | 'lora_scale' | 'vocal_language'> {
  if (!input.lora_key) return {};
  return {
    lora_key: input.lora_key,
    lora_scale: input.lora_scale ?? STYLE_STRENGTH_DEFAULT,
    vocal_language: STYLE_LANGUAGE,
  };
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
  /* The two dials, as YuE2 reads them: nothing sent is the default, and an out-of-range number is refused, never held to the end. */
  const weirdness = dial(
    body.weirdness,
    WEIRDNESS_DEFAULT,
    WEIRDNESS_MIN,
    WEIRDNESS_MAX,
    'Creative variation',
    true,
  );
  const guidance = dial(
    body.guidance,
    GUIDANCE_DEFAULT,
    GUIDANCE_MIN,
    GUIDANCE_MAX,
    'Prompt guidance',
    false,
  );
  /* The Style choice, read only while styles are on. Strength 0 is plain ACE-Step XL, as at YuE2: no adapter, so no Best. So is
   * a strength so small that the scale sent to the worker would round to 0, which the worker reads as plain too. */
  const styles = aceStylesEnabled(env);
  const band = styleChoice(body.band, env);
  const strength = styles
    ? dial(
        body.style_strength,
        STYLE_STRENGTH_DEFAULT,
        STYLE_STRENGTH_MIN,
        STYLE_STRENGTH_MAX,
        'Style strength',
        false,
      )
    : STYLE_STRENGTH_DEFAULT;
  const row = band ? aceStyles[band] : undefined;
  const scale = row ? styleScale(row, strength) : 0;
  const trained = row && scale > 0 ? row : undefined;
  if (trained && instrumental) throw new Error(STYLE_SINGING);
  const direction = body.script.trim();
  const asked = aceModelChoice(body.quality, env);
  /* A style is taught on the Best decoder, so a styled take is a Best take whatever Quality says; the quote says so. */
  const model: AceModel = trained ? 'xl-sft' : asked;
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
    weirdness,
    guidance,
    seed: body.seed ?? Math.floor(Math.random() * SEED_LIMIT),
    ...(band ? { band } : {}),
    ...(styles && body.style_strength != null ? { style_strength: strength } : {}),
    ...(trained ? { lora_key: trained.key, lora_scale: scale } : {}),
  };
}

/**
 * The worker job for one take. The sheet goes through whole (never cut); an instrumental sends the tag the worker reads.
 * lm_temperature and guidance_scale come after bpm and only when a dial was moved (guidance only for Best); a job saved
 * before the dials existed has neither dial and is the request it always was.
 * A styled job adds lora_key, lora_scale and vocal_language last, and is always sent as Best. The caption stays Music
 * direction as she wrote it: the worker plans on it as it is, and puts the adapter's trigger word in front for the decoder.
 * A job with no lora_key, which is every job unless ACE_STYLES_ENABLED is on and a Style was chosen, is the request it was.
 */
export function aceRequest(input: Input): AceRequest {
  const sung = input.instrumental ? '' : (input.lyrics ?? '');
  const model = effectiveModel(input);
  return {
    model,
    caption: aceCaption(input.style).caption,
    lyrics: input.instrumental ? INSTRUMENTAL_TAG : sung,
    duration: input.duration ?? aceLyricSeconds(sung),
    seed: input.seed,
    batch_size: 1,
    ...(input.bpm ? { bpm: input.bpm } : {}),
    ...aceDialFields(model, input),
    ...aceStyleFields(input),
  };
}

/** What is said before anything is spent: the length, the quality, a note if the direction was cut or a dial will do nothing, then the cost. */
export function aceEstimate(input: Input): string {
  const model = effectiveModel(input);
  const quality = model === 'xl-sft' ? aceQuality.best : aceQuality.fast;
  const cut = aceCaption(input.style).trimmed
    ? ` Only the first part of Music direction fits; ACE-Step XL reads ${CAPTION_LIMIT} characters.`
    : '';
  const idle =
    model !== 'xl-sft' && moved(input.guidance, GUIDANCE_DEFAULT)
      ? ` Prompt guidance only works with Quality ${aceQuality.best}, so ${aceQuality.fast} ignores it.`
      : '';
  /* A style is said first, with the quality it forces. Strength 0 (or one too small to count) is a plain take, and says that it is. */
  const length = spokenLength(input.duration ?? 0);
  const lead = input.lora_key
    ? `About ${length} of music in the ${styleLabel(input.band)} style, which always uses ${quality.toLowerCase()} quality.`
    : `About ${length} of music, ${quality.toLowerCase()} quality.`;
  const plain =
    input.band && !input.lora_key
      ? ` Style strength is ${input.style_strength === 0 ? '0' : 'too low'}, so the ${styleLabel(input.band)} style is not used.`
      : '';
  return `${lead}${plain}${cut}${idle} ${aceCost}`;
}

/* ---------- the project row and the library asset ---------- */

export function aceProjectOptions(input: Input): AceProjectOptions {
  return {
    quality: effectiveModel(input) === 'xl-sft' ? aceQuality.best : aceQuality.fast,
    length: input.length_choice ?? aceMatchLyrics,
    singing: input.instrumental ? yueSinging.instrumental : yueSinging.sung,
    lyrics: input.lyrics ?? '',
    weirdness: input.weirdness ?? WEIRDNESS_DEFAULT,
    guidance: input.guidance ?? GUIDANCE_DEFAULT,
    seed: input.seed,
    ...(input.band ? { band: input.band } : {}),
    ...(typeof input.style_strength === 'number' ? { style_strength: input.style_strength } : {}),
  };
}

/** A library row's reason line; a take made in a style says which. */
export function aceProjectWhy(options?: Partial<AceProjectOptions>): string {
  const made = options?.singing === yueSinging.instrumental ? 'an instrumental' : 'a song';
  const best = options?.quality === aceQuality.best ? ', best quality' : '';
  const band = options?.band;
  const said = options?.style_strength;
  const strength =
    typeof said === 'number' && Number.isFinite(said) ? said : STYLE_STRENGTH_DEFAULT;
  const styled =
    typeof band === 'string' &&
    Object.prototype.hasOwnProperty.call(aceStyles, band) &&
    styleScale(aceStyles[band], strength) > 0
      ? `, in the ${styleLabel(band)} style`
      : '';
  return `ACE-Step XL — ${made} made on the sleeping music GPU${best}${styled}`;
}

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The adapter the worker says it applied, field by field as it said them; undefined when it said nothing usable. */
function styleReport(output: Output | undefined): AceStyleReport | undefined {
  const said = output?.style;
  if (!said || typeof said !== 'object') return undefined;
  const report: AceStyleReport = {};
  if (typeof said.key === 'string') report.key = said.key;
  if (typeof said.name === 'string') report.name = said.name;
  const scale = finiteNumber(said.scale);
  if (scale !== undefined) report.scale = scale;
  if (typeof said.tag === 'string') report.tag = said.tag;
  if (typeof said.sha256 === 'string') report.sha256 = said.sha256;
  return Object.keys(report).length ? report : undefined;
}

/**
 * One plain sentence about a styled take, from what the worker reported: made in the style (and how strongly, when she
 * turned it down), or that the worker did not confirm the adapter it was asked for, so the take may be plain. Nothing for
 * any other take, which keeps a plain take's notes exactly as they were.
 */
export function aceTakeNote(output: Output | undefined, input: Input): string {
  if (!output || !input.lora_key) return '';
  const name = styleLabel(input.band);
  const report = styleReport(output);
  if (!report || (report.key !== undefined && report.key !== input.lora_key))
    return `The ${name} style was not confirmed for this take, so it may sound like plain ACE-Step XL.`;
  const softer =
    typeof input.style_strength === 'number' && input.style_strength < STYLE_STRENGTH_DEFAULT
      ? ` at strength ${input.style_strength}`
      : '';
  return `Made in the ${name} style${softer}.`;
}

/**
 * What the asset keeps about a finished take: the card, the checkpoint and what the planner chose, when the worker said;
 * then the two dials as she set them and the worker fields they became (only the ones that were sent). A styled take
 * also keeps the Style and strength she set, the adapter and scale that were sent, what the worker said it applied, and
 * the one-sentence note.
 */
export function aceTakeFacts(output: Output | undefined, input: Input): AceTakeFacts {
  if (!output) return {};
  const facts: AceTakeFacts = {};
  const bpm = finiteNumber(output.plan?.bpm);
  const sent = aceDialFields(effectiveModel(input), input);
  if (typeof output.gpu === 'string') facts.gpu = output.gpu;
  if (typeof output.model === 'string') facts.model = output.model;
  if (typeof output.instrumental === 'boolean') facts.instrumental = output.instrumental;
  else if (input.instrumental === true) facts.instrumental = true;
  if (bpm !== undefined) facts.bpm = bpm;
  if (typeof output.plan?.keyscale === 'string') facts.keyscale = output.plan.keyscale;
  facts.weirdness = input.weirdness ?? WEIRDNESS_DEFAULT;
  facts.guidance = input.guidance ?? GUIDANCE_DEFAULT;
  if (sent.lm_temperature !== undefined) facts.lm_temperature = sent.lm_temperature;
  if (sent.guidance_scale !== undefined) facts.guidance_scale = sent.guidance_scale;
  /* Only a take that was sent an adapter keeps the Style fields. Style None with a strength she moved, and a Style at strength 0,
   * are plain takes: the project remembers what she set, but the asset must not read as if a style had been used. */
  if (!input.lora_key) return facts;
  if (input.band) facts.band = input.band;
  if (typeof input.style_strength === 'number') facts.style_strength = input.style_strength;
  facts.lora_key = input.lora_key;
  if (typeof input.lora_scale === 'number') facts.lora_scale = input.lora_scale;
  const report = styleReport(output);
  if (report) facts.style = report;
  facts.takeNote = aceTakeNote(output, input);
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

/**
 * The Style choice for one person. With the Family feature pack (`allowed`) the settings come back unchanged. Without it
 * the `band` and `style_strength` settings stay, with every option, and gain `locked` (the pack's note, "Part of the Family
 * feature pack") plus a sentence on their hints: clients show them greyed out, never hidden (Apple's 2.3.1). It is
 * yueStyleAccess for the ACE card, with ACE-Step XL's own words. The booth route refuses a style from such an account on
 * its own (kadeSoundBooth.js), so an older client that shows the choice live gets a plain answer instead of a song.
 */
export function aceStyleAccess<T extends { key: string; hint: string }>(
  settings: T[],
  allowed: boolean,
  note: string = FAMILY_PACK_NOTE,
): Array<T | (T & { locked: string })> {
  if (allowed || !settings.some((setting) => setting.key === 'band')) return settings;
  return settings.map((setting) =>
    setting.key === 'band' || setting.key === 'style_strength'
      ? { ...setting, hint: `${setting.hint}${aceStyleLockedSentence}`, locked: note }
      : setting,
  );
}

/** The two settings of the Style choice, with the keys, labels and ranges of the YuE2 card so every screen draws them alike. */
function aceStyleSettings(): AceGuideSetting[] {
  return [
    {
      key: 'band',
      label: 'Style',
      hint: aceStyleHint,
      kind: 'choice',
      options: ['none', ...Object.keys(aceStyles)],
      default: 'none',
    },
    {
      key: 'style_strength',
      label: 'Style strength',
      hint: STYLE_STRENGTH_HINT,
      kind: 'number',
      min: STYLE_STRENGTH_MIN,
      max: STYLE_STRENGTH_MAX,
      step: 0.1,
      default: STYLE_STRENGTH_DEFAULT,
      advanced: true,
    },
  ];
}

/**
 * The ACE-Step XL card for the booth guide: the settings in the order they are shown. With ACE_STYLES_ENABLED unset it is
 * the card it always was. With it set, Style (and Style strength, under More settings) follow Quality, and
 * `stylesAllowed` (the Family feature pack) decides whether the choice is live: left out, it is greyed out. Only someone
 * who can use a Style is told, in the Singing, Quality and Prompt guidance hints, what a Style does to them.
 */
export function aceGuide(
  env: NodeJS.ProcessEnv = process.env,
  stylesAllowed: boolean = false,
): AceGuideEntry {
  const max = aceMaxSeconds(env);
  const minutes = Array.from({ length: Math.floor(max / 60) }, (_, index) =>
    clock((index + 1) * 60),
  );
  const styles = aceStylesEnabled(env);
  /* The hints that speak of a Style are for someone who can use one; an account outside the pack sees the plain hints. */
  const hinted = styles && stylesAllowed;
  const card: AceGuideEntry = {
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
      'Describe the style, instruments and singing voice in Music direction. A tempo such as 88 BPM is picked out and sent on its own.',
      'Put the exact words under Lyrics, with [Verse] and [Chorus] tags. Words in (parentheses) are sung as backing vocals.',
      'Leave Length on Match my lyrics, or choose a length. Quality Best is slower and costs more.',
    ],
    settings: [
      {
        key: 'singing',
        label: 'Singing or instrumental',
        hint: `Instrumental plays the tune on instruments and ignores any lyrics.${hinted ? STYLE_INSTRUMENTAL_HINT : ''}`,
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
        hint: `Fast is quick. Best is slower and costs more.${hinted ? STYLE_QUALITY_HINT : ''}`,
        kind: 'choice',
        options: [aceQuality.fast, aceQuality.best],
        default: aceDefaultModel(env) === 'xl-sft' ? aceQuality.best : aceQuality.fast,
      },
      ...(styles ? aceStyleSettings() : []),
      {
        key: 'length',
        label: 'Length',
        hint: 'Match my lyrics sizes the song from your lyric lines.',
        kind: 'choice',
        options: [aceMatchLyrics, ...minutes],
        default: aceMatchLyrics,
      },
      /* The same two dials, keys and labels as the YuE2 card, so every screen draws them alike. Both sit under More settings. */
      {
        key: 'weirdness',
        label: 'Creative variation (weirdness)',
        hint: '50 is normal. Lower is more predictable; higher is more surprising and can lose its way.',
        kind: 'range',
        min: WEIRDNESS_MIN,
        max: WEIRDNESS_MAX,
        step: 1,
        default: WEIRDNESS_DEFAULT,
        advanced: true,
      },
      {
        key: 'guidance',
        label: 'Prompt guidance',
        hint: `Only for Quality Best; Fast ignores it. Higher follows your direction and lyrics more strictly but can sound less natural.${hinted ? STYLE_GUIDANCE_HINT : ''}`,
        kind: 'range',
        min: GUIDANCE_MIN,
        max: GUIDANCE_MAX,
        step: 0.1,
        default: GUIDANCE_DEFAULT,
        advanced: true,
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
  return styles ? { ...card, settings: aceStyleAccess(card.settings, stylesAllowed) } : card;
}

/**
 * The guide for one person. Someone who may use ACE-Step XL gets its card last; everyone else gets
 * the very same object back, so with ACE_ENABLED unset the guide is untouched. `stylesAllowed` is whether
 * this person has the Family feature pack (the booth asks familyFeatures); a caller that does not say gets
 * the Style choice greyed out, never live.
 */
export function withAceGuide<T extends { engines: Record<string, object> }>(
  guide: T,
  user: AceUser,
  env: NodeJS.ProcessEnv = process.env,
  stylesAllowed: boolean = false,
): T {
  if (!guide || !guide.engines || !aceAllowed(user, env)) return guide;
  return { ...guide, engines: { ...guide.engines, ace: aceGuide(env, stylesAllowed === true) } };
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
    takeNote: aceTakeNote,
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
