import axios from 'axios';
import express from 'express';
import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import type { Request, Router } from 'express';
import type { Hooks, Input, InputBody, Output, Provider } from '../audio/jobs';
import { createAudioRouter } from '../audio/jobs';
import { yueFallbackUsdPerSecond, yueGpuRates } from './yue';

/* ----------------------------------------------------------------------------
 * SING IT IN MY VOICE (Sep 27 2026)
 *
 * Her words, after hearing her RVC test: "the RVC files sound great other than
 * the fact that vocal extraction made it say some things weird ... at the very
 * least just create a section on the booth that is sing it in my voice and I
 * would just upload a file. I do like the idea of trying to make it automatic
 * though."
 *
 * So two ways in, one voice worker (a separate RunPod endpoint, repo
 * scenema-audio-runpod branch voice-rvc):
 *   1. an engine of its own, "Sing it in my voice": she imports a song or a dry
 *      vocal and gets it back sung in her voice (createMyVoiceRouter);
 *   2. a YuE2 choice, "Sing it in my voice: Off / On", that re-sings every
 *      finished take and keeps both versions in the project
 *      (createMyVoiceFollowUps).
 *
 * A PERSONAL feature, not a Family pack one. Only an account with a voice model
 * registered for its user id sees anything about it: the guide, the engine, the
 * YuE2 choice, the upload lane. Everyone else, App Review included, gets the
 * booth exactly as before, and a request naming the engine falls through as any
 * unknown engine would. The check is on the server, by user id, every time.
 *
 * The registry: MY_VOICE_MODELS (JSON keyed by user id) seeds hers; a table
 * (KadeVoiceModel) holds voices added later, and only with a consent record.
 * There is no training or sign-up screen: adding a voice is a deliberate act by
 * Kade. Model files live in the private bucket under voice-models/<user id>/,
 * and a key that points into another person's folder is refused.
 *
 * Every word a person reads here says "my voice" or "your voice" and never a
 * name. Behind MY_VOICE_ENABLED=1 plus MY_VOICE_ENDPOINT_ID and RUNPOD_API_KEY;
 * with the flag off nothing in this file shows or runs.
 * -------------------------------------------------------------------------- */

export const myVoiceEngine = 'myvoice';

export function myVoiceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MY_VOICE_ENABLED === '1' && !!env.MY_VOICE_ENDPOINT_ID && !!env.RUNPOD_API_KEY;
}

/* ---------- the registry --------------------------------------------------- */

/** The singer's own low, middle and high notes (MIDI numbers, 5th/50th/95th percentile); private, sent only to the worker. */
export type MyVoiceRange = { p05: number; p50: number; p95: number };
export type MyVoiceModel = {
  user: string;
  label: string;
  model_key: string;
  model_sha256?: string;
  index_key?: string;
  index_sha256?: string;
  range?: MyVoiceRange;
  source: 'env' | 'table';
};
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MODEL_KEY = /^voice-models\/([A-Za-z0-9_-]{1,64})\/[A-Za-z0-9._/-]{1,512}\.pth$/;
const INDEX_KEY = /^voice-models\/([A-Za-z0-9_-]{1,64})\/[A-Za-z0-9._/-]{1,512}\.index$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** One registry entry checked the same way wherever it came from; null when it cannot be trusted. */
export function checkMyVoiceModel(
  user: string,
  raw: unknown,
  source: 'env' | 'table',
): MyVoiceModel | null {
  if (!USER_ID.test(user) || !raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  const key = entry.model_key;
  if (typeof key !== 'string' || key.includes('..') || MODEL_KEY.exec(key)?.[1] !== user)
    return null;
  const model: MyVoiceModel = { user, label: 'My voice', model_key: key, source };
  if (entry.index_key != null) {
    const index = entry.index_key;
    if (typeof index !== 'string' || index.includes('..') || INDEX_KEY.exec(index)?.[1] !== user)
      return null;
    model.index_key = index;
  }
  for (const field of ['model_sha256', 'index_sha256'] as const) {
    const value = entry[field];
    if (value == null) continue;
    if (typeof value !== 'string' || !SHA256.test(value.toLowerCase())) return null;
    model[field] = value.toLowerCase();
  }
  if (model.index_sha256 && !model.index_key) return null;
  if (entry.range != null) {
    const range = entry.range as Record<string, unknown>;
    const notes = [range.p05, range.p50, range.p95];
    if (!notes.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 30 && n <= 100))
      return null;
    const [p05, p50, p95] = notes as number[];
    if (!(p05 <= p50 && p50 <= p95)) return null;
    model.range = { p05, p50, p95 };
  }
  return model;
}

/** MY_VOICE_MODELS: {"<user id>": {"model_key", "model_sha256", "index_key", "index_sha256", "range"}}. Bad entries are left out. */
export function parseMyVoiceModels(raw: string | undefined): Record<string, MyVoiceModel> {
  const out: Record<string, MyVoiceModel> = {};
  if (!raw || !raw.trim()) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const [user, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const model = checkMyVoiceModel(user, entry, 'env');
    if (model) out[user] = model;
  }
  return out;
}

type VoiceModelRow = {
  user: string;
  model_key: string;
  model_sha256?: string;
  index_key?: string;
  index_sha256?: string;
  range?: MyVoiceRange;
  consent: { at: Date; note: string };
  active: boolean;
  createdAt: Date;
};
const voiceModelSchema = new mongoose.Schema<VoiceModelRow>({
  user: { type: String, required: true },
  model_key: { type: String, required: true },
  model_sha256: String,
  index_key: String,
  index_sha256: String,
  range: mongoose.Schema.Types.Mixed,
  consent: { at: Date, note: String },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});
voiceModelSchema.index({ user: 1 }, { unique: true });
function voiceModels(): mongoose.Model<VoiceModelRow> {
  return (
    (mongoose.models.KadeVoiceModel as mongoose.Model<VoiceModelRow>) ||
    mongoose.model<VoiceModelRow>('KadeVoiceModel', voiceModelSchema)
  );
}

/** The voice model this account may use, or null. Null while the feature is off, and null when the lookup itself fails. */
export async function findMyVoiceModel(
  user: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MyVoiceModel | null> {
  if (!myVoiceEnabled(env) || !user) return null;
  const seeded = parseMyVoiceModels(env.MY_VOICE_MODELS)[user];
  if (seeded) return seeded;
  try {
    if (mongoose.connection.readyState !== 1) return null;
    const row = await voiceModels().findOne({ user, active: true }).lean();
    if (!row || !row.consent || !row.consent.at || !String(row.consent.note || '').trim())
      return null;
    return checkMyVoiceModel(user, row, 'table');
  } catch {
    return null;
  }
}

/** Registers a voice for an account that has said yes to it. Nothing in the booth calls this: it is for Kade, by hand, later. */
export async function registerMyVoiceModel(
  user: string,
  entry: Record<string, unknown>,
  consentNote: string,
): Promise<MyVoiceModel> {
  const model = checkMyVoiceModel(user, entry, 'table');
  if (!model)
    throw new Error('That voice model entry does not belong to this account or is not complete.');
  if (!String(consentNote || '').trim())
    throw new Error('Record how the person said yes before adding their voice.');
  const { source: _source, label: _label, ...fields } = model;
  await voiceModels().updateOne(
    { user },
    {
      $set: {
        ...fields,
        active: true,
        consent: { at: new Date(), note: String(consentNote).slice(0, 500) },
      },
    },
    { upsert: true },
  );
  return model;
}

/* ---------- the choices, in the words the screens show ------------------------ */

export const myVoiceSources: { song: string; vocal: string } = {
  song: 'Song with music',
  vocal: 'Just a vocal',
};
export const myVoiceAutoOptions: { off: string; on: string } = { off: 'Off', on: 'On' };
export const myVoiceExtractors: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'hyperace', label: 'BS-RoFormer HyperACE v2' },
  { key: 'bs_roformer', label: 'BS-RoFormer ep 317 (the first test)' },
  { key: 'melband_kim', label: 'Mel-RoFormer Kim' },
  { key: 'melband_becruily', label: 'Mel-RoFormer becruily (slower the first time)' },
  { key: 'demucs', label: 'Demucs' },
];
/* Vocal effects (Sep 27 2026), her words: "adding some reverb/delay/echo type effects to put on my voice if I want it, like
 * optional ... I can always take dry vocals into a daw". The worker's vocal_fx presets (voice/vocalfx.py): studio polish on
 * the converted lead plus a space, matched to the dry lead's loudness. None sends nothing, so the worker's output is exactly
 * what it was; the dry voice on its own is always kept, and an effect adds the voice with the effect as a third file. */
export const myVoiceEffects: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'none', label: 'None' },
  { key: 'studio', label: 'Studio polish' },
  { key: 'plate', label: 'Plate reverb' },
  { key: 'hall', label: 'Hall reverb' },
  { key: 'slapback', label: 'Slapback' },
  { key: 'echo', label: 'Echo' },
  { key: 'dreamy', label: 'Dreamy' },
];
/** The worker's lead vs backing models (voice_request.LEAD_MODELS). Not a screen choice: MY_VOICE_DEFAULTS can switch it. */
const LEAD_MODELS = ['frazer', 'aufr33'] as const;

export type MyVoiceOptions = {
  extractor: string;
  lead_split: boolean;
  lead_model: string;
  dereverb: boolean;
  soft_s: boolean;
  index_rate: number;
  protect: number;
  rms_mix_rate: number;
  /** A myVoiceEffects key; 'none' (or missing, on a job saved before effects existed) sends nothing to the worker. */
  vocal_fx: string;
};
/* The round 2 chain (Sep 27 2026, voice-persona RUNBOOK section 17), measured with Whisper against the lyrics on the three
 * songs with the most backing singers: HyperACE v2 vocals and the frazer & becruily lead split with no dereverb took the lead
 * that reaches RVC from 105 missing words of 591 to 4, and her voice from 322 words right to 494 (the weird words); the
 * input's own S hiss above ~4 kHz (soft_s) matched the original singer's S level within 0.1 dB and its texture (the slightly
 * robotic S). Protect at 0.2 or 0.5 changed nothing measurable. Round 1's chain: MY_VOICE_DEFAULTS
 * {"extractor":"bs_roformer","lead_model":"aufr33","dereverb":true,"soft_s":false}. */
const DEFAULTS: MyVoiceOptions = {
  extractor: 'hyperace',
  lead_split: true,
  lead_model: 'frazer',
  dereverb: false,
  soft_s: false,
  index_rate: 0.5,
  protect: 0.33,
  rms_mix_rate: 0.25,
  vocal_fx: 'none',
};
const RANGES = { index_rate: [0, 1], protect: [0, 0.5], rms_mix_rate: [0, 1] } as const;

/** The round 2 chain with source-hiss restoration off, or explicit MY_VOICE_DEFAULTS. Bad values are ignored. */
export function myVoiceDefaults(env: NodeJS.ProcessEnv = process.env): MyVoiceOptions {
  const out: MyVoiceOptions = { ...DEFAULTS };
  let said: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(env.MY_VOICE_DEFAULTS || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      said = parsed as Record<string, unknown>;
  } catch {
    said = {};
  }
  if (typeof said.extractor === 'string' && myVoiceExtractors.some((e) => e.key === said.extractor))
    out.extractor = said.extractor;
  if (
    typeof said.lead_model === 'string' &&
    (LEAD_MODELS as readonly string[]).includes(said.lead_model)
  )
    out.lead_model = said.lead_model;
  for (const flag of ['lead_split', 'dereverb', 'soft_s'] as const)
    if (typeof said[flag] === 'boolean') out[flag] = said[flag] as boolean;
  if (typeof said.vocal_fx === 'string' && myVoiceEffects.some((e) => e.key === said.vocal_fx))
    out.vocal_fx = said.vocal_fx;
  for (const [key, [low, high]] of Object.entries(RANGES) as Array<
    [keyof typeof RANGES, readonly [number, number]]
  >) {
    const value = said[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high)
      out[key] = value;
  }
  return out;
}

function words(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}
/** "On" (or true) turns the YuE2 choice on; anything else, including nonsense, leaves it off and says nothing. */
export function myVoiceAutoChoice(value: unknown): boolean {
  return value === true || words(value) === 'on';
}
function sourceChoice(value: unknown): 'song' | 'vocal' {
  const said = words(value);
  if (!said || said === 'song' || said === words(myVoiceSources.song) || said.startsWith('song'))
    return 'song';
  if (said === 'vocal' || said === words(myVoiceSources.vocal) || said.startsWith('just'))
    return 'vocal';
  throw new Error('Under What is in the file, choose Song with music or Just a vocal.');
}
function pitchChoice(value: unknown): 'auto' | number {
  if (value == null || value === '' || ['auto', 'automatic'].includes(words(value))) return 'auto';
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < -24 || n > 24)
    throw new Error(
      'Pitch must be empty for automatic, or a whole number of semitones from -24 to 24.',
    );
  return n;
}
function flagChoice(value: unknown, fallback: boolean, label: string): boolean {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const said = words(value);
  if (['on', 'true', 'yes', '1'].includes(said)) return true;
  if (['off', 'false', 'no', '0'].includes(said)) return false;
  throw new Error(`Under ${label}, choose on or off.`);
}
function extractorChoice(value: unknown, fallback: string): string {
  if (value == null || value === '') return fallback;
  const said = words(value);
  /* The exact key or label first. A first word alone ("demucs") counts only when one extractor starts with it: two labels
   * share "bs-roformer" and two share "mel-roformer", and a first-word match used to turn becruily into Kim. */
  const first = (text: string) => text.split(/[\s(]+/)[0];
  const exact = myVoiceExtractors.find((e) => e.key === said || words(e.label) === said);
  const byFirst = myVoiceExtractors.filter((e) => first(words(e.label)) === first(said));
  const found = exact || (byFirst.length === 1 ? byFirst[0] : undefined);
  if (!found) throw new Error('Under Vocal extractor, choose one of the listed extractors.');
  return found.key;
}
function effectChoice(value: unknown, fallback: string): string {
  if (value == null || value === '') return fallback;
  const said = words(value);
  /* The key or the label; every label's first word is its own (Studio, Plate, Hall...), so "plate" is Plate reverb. */
  const found = myVoiceEffects.find(
    (e) => e.key === said || words(e.label) === said || words(e.label).split(' ')[0] === said,
  );
  if (!found) throw new Error('Under Vocal effects, choose one of the listed effects, or None.');
  return found.key;
}
function numberChoice(
  value: unknown,
  fallback: number,
  key: keyof typeof RANGES,
  label: string,
): number {
  if (value == null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  const [low, high] = RANGES[key];
  if (!Number.isFinite(n) || n < low || n > high)
    throw new Error(`${label} must be from ${low} to ${high}.`);
  return n;
}

/* ---------- what a job carries ------------------------------------------------ */

/** The worker's request (scenema-audio-runpod voice/voice_request.py), assembled on the server. */
export type MyVoiceWorkerInput = {
  mode: 'song' | 'vocal';
  audio_url?: string;
  audio_key?: string;
  model_key: string;
  model_sha256?: string;
  index_key?: string;
  index_sha256?: string;
  pitch: 'auto' | number;
  voice_range?: MyVoiceRange;
  options: Omit<MyVoiceOptions, 'vocal_fx'> & {
    fallback: string;
    room: boolean;
    f0_method: string;
  };
  /** Sent only for an effect; a worker from before effects ignores it (the take note then says the voice stayed dry). */
  vocal_fx?: string;
};
/** What the booth keeps on a voice job's input: her choices from the client, and the model the server looked up. */
export type MyVoiceJob = {
  source: 'song' | 'vocal';
  pitch: 'auto' | number;
  options: MyVoiceOptions;
  seconds?: number;
  model?: Pick<MyVoiceModel, 'model_key' | 'model_sha256' | 'index_key' | 'index_sha256' | 'range'>;
};

/** The body of a "Sing it in my voice" render -> the job input. The voice model is added later, by the owner check. */
export function myVoiceInput(body: InputBody, env: NodeJS.ProcessEnv = process.env): Input {
  if (body.referenceExpected && !body.reference_voice_url)
    throw new Error('Wait for the recording to finish importing, or discard the failed import.');
  const url = body.reference_voice_url;
  if (typeof url !== 'string' || !url.startsWith('https://') || url.length > 12000)
    throw new Error('Import the recording to sing under Recording to sing.');
  if (body.title != null && (typeof body.title !== 'string' || body.title.length > 80))
    throw new Error('Use a title up to 80 characters.');
  const defaults = myVoiceDefaults(env);
  const source = sourceChoice(body.voice_source);
  const voice: MyVoiceJob = {
    source,
    pitch: pitchChoice(body.pitch),
    options: {
      extractor: extractorChoice(body.extractor, defaults.extractor),
      lead_split: flagChoice(
        body.lead_split,
        defaults.lead_split,
        'Split the lead from the backing vocals',
      ),
      lead_model: defaults.lead_model,
      dereverb: flagChoice(body.dereverb, defaults.dereverb, 'Take the room off the voice first'),
      soft_s: flagChoice(body.soft_s, defaults.soft_s, 'Keep original singer’s S sounds'),
      index_rate: numberChoice(
        body.index_rate,
        defaults.index_rate,
        'index_rate',
        'Voice likeness',
      ),
      protect: numberChoice(body.protect, defaults.protect, 'protect', 'Protect breaths'),
      rms_mix_rate: numberChoice(
        body.rms_mix_rate,
        defaults.rms_mix_rate,
        'rms_mix_rate',
        'Loudness follows',
      ),
      vocal_fx: effectChoice(body.vocal_fx, defaults.vocal_fx),
    },
  };
  const title = body.title?.trim() || 'Sung in my voice';
  return {
    style: `Sing it in my voice: ${source === 'song' ? myVoiceSources.song : myVoiceSources.vocal}`,
    title,
    count: 1,
    seed: 0,
    reference_voice_url: url,
    voice,
  };
}

/** The owner check inside the job router: adds the model (and the recording's length, for the estimate) or refuses. */
export function myVoicePrepare(
  find: (user: string) => Promise<MyVoiceModel | null>,
  seconds?: (user: string, url: string) => Promise<number | undefined>,
): (user: string, input: Input) => Promise<Input> {
  return async (user, input) => {
    const model = await find(user);
    if (!model || !input.voice) throw new Error('That engine is not available.');
    const length =
      seconds && input.reference_voice_url
        ? await seconds(user, input.reference_voice_url)
        : undefined;
    const { model_key, model_sha256, index_key, index_sha256, range } = model;
    return {
      ...input,
      voice: {
        ...input.voice,
        ...(typeof length === 'number' && length > 0 ? { seconds: length } : {}),
        model: { model_key, model_sha256, index_key, index_sha256, range },
      },
    };
  };
}

function workerOptions(options: Omit<MyVoiceOptions, 'vocal_fx'>): MyVoiceWorkerInput['options'] {
  return {
    ...options,
    /* Round 1's BS-RoFormer backs up every other extractor (and Demucs backs it up), so one extractor's failure never
     * ends the job. */
    fallback: options.extractor === 'bs_roformer' ? 'demucs' : 'bs_roformer',
    room: true, // used only when dereverb took a room off: a matching one goes back on
    f0_method: 'rmvpe',
  };
}
function withModel(
  base: Omit<MyVoiceWorkerInput, 'model_key' | 'options'>,
  model: NonNullable<MyVoiceJob['model']>,
  options: MyVoiceOptions,
): MyVoiceWorkerInput {
  const { vocal_fx, ...chain } = options;
  const out: MyVoiceWorkerInput = {
    ...base,
    model_key: model.model_key,
    options: workerOptions(chain),
  };
  if (vocal_fx && vocal_fx !== 'none') out.vocal_fx = vocal_fx;
  if (model.model_sha256) out.model_sha256 = model.model_sha256;
  if (model.index_key) out.index_key = model.index_key;
  if (model.index_sha256) out.index_sha256 = model.index_sha256;
  if (model.range) out.voice_range = model.range;
  return out;
}
/** A manual job's worker request. */
export function myVoiceWorkerInput(input: Input): MyVoiceWorkerInput {
  const voice = input.voice;
  if (!voice || !voice.model || !input.reference_voice_url)
    throw new Error('The voice job is missing its model or recording.');
  return withModel(
    { mode: voice.source, audio_url: input.reference_voice_url, pitch: voice.pitch },
    voice.model,
    voice.options,
  );
}

/** What the project keeps, in the words the settings show, so Open in the booth restores her choices. Never the model. */
export type MyVoiceProjectOptions = {
  reference_voice_url?: string;
  voice_source: string;
  pitch?: number;
  extractor: string;
  lead_split: boolean;
  dereverb: boolean;
  soft_s: boolean;
  index_rate: number;
  protect: number;
  rms_mix_rate: number;
  vocal_fx: string;
};
export function myVoiceProjectOptions(input: Input): MyVoiceProjectOptions {
  const voice = input.voice;
  const options = voice?.options || DEFAULTS;
  const out: MyVoiceProjectOptions = {
    voice_source: voice?.source === 'vocal' ? myVoiceSources.vocal : myVoiceSources.song,
    extractor: (myVoiceExtractors.find((e) => e.key === options.extractor) || myVoiceExtractors[0])
      .label,
    lead_split: options.lead_split,
    dereverb: options.dereverb,
    soft_s: options.soft_s !== false,
    index_rate: options.index_rate,
    protect: options.protect,
    rms_mix_rate: options.rms_mix_rate,
    vocal_fx: (myVoiceEffects.find((e) => e.key === options.vocal_fx) || myVoiceEffects[0]).label,
  };
  if (input.reference_voice_url) out.reference_voice_url = input.reference_voice_url;
  if (typeof voice?.pitch === 'number') out.pitch = voice.pitch;
  return out;
}
/** A library row's reason line. */
export function myVoiceProjectWhy(options?: { voice_source?: string }): string {
  return options?.voice_source === myVoiceSources.vocal
    ? 'Sung in my voice — a vocal on its own'
    : 'Sung in my voice — a song with music';
}

/* ---------- money --------------------------------------------------------------- */

/** RunPod flex price per second for the voice worker's usual card (RTX 4090, the YuE2 table's row). */
const USUAL_USD_PER_SECOND = 0.000306;
/** GPU seconds of a job, measured on the Sep 27 pod: separation ~15 s a model with its load, RVC ~35 s with its load. A vocal
 * effect adds its CPU work while the card waits: 4 to 11 s for a three-minute song on the PC, so ~0.06 s a second of audio. */
export function myVoiceGpuSeconds(
  mode: 'song' | 'vocal',
  audioSeconds?: number,
  effect?: boolean,
): number {
  const length = typeof audioSeconds === 'number' && audioSeconds > 0 ? audioSeconds : 240;
  return (mode === 'song' ? 45 + 0.45 * length : 30 + 0.2 * length) + (effect ? 0.06 * length : 0);
}
/** What a finished job cost: billed seconds at the rate of the card that ran it (the YuE2 price table). */
export function myVoiceTakeCost(executionMs: number | undefined, gpu?: string | null): number {
  const ms = executionMs || 0;
  const row =
    typeof gpu === 'string' && gpu.trim()
      ? yueGpuRates.find((rate) => rate.pattern.test(gpu))
      : undefined;
  return (ms / 1000) * (row ? row.usdPerSecond : yueFallbackUsdPerSecond);
}
function sayCents(usd: number): string {
  const cents = Math.max(1, Math.round(usd * 100));
  return cents >= 100 ? `$${usd.toFixed(2)}` : `${cents} cent${cents === 1 ? '' : 's'}`;
}
export const myVoiceCost =
  'No fixed price: GPU time is paid by the second at the rate of the card that runs it. A three-minute song is usually three to five cents; startup is extra when the voice worker has to wake up. It does not use your credit balance.';

export function myVoiceEstimate(input: Input): { spoken: string; costUSD: number } {
  const voice = input.voice;
  const mode = voice?.source || 'song';
  const effect = !!voice?.options?.vocal_fx && voice.options.vocal_fx !== 'none';
  const costUSD =
    Math.round(myVoiceGpuSeconds(mode, voice?.seconds, effect) * USUAL_USD_PER_SECOND * 1000) /
    1000;
  const length = voice?.seconds ? 'for a recording this long' : 'for a song of about four minutes';
  return {
    costUSD,
    spoken: `About ${sayCents(costUSD)} of GPU time ${length}, on the card the voice worker usually gets. Startup is extra when it has to wake up, and it does not use your credit balance. Usually back in two to four minutes.`,
  };
}

/* ---------- what the worker said, said back ------------------------------------ */

export type MyVoiceOutput = Output & {
  key?: string;
  wav_key?: string;
  vocal_url?: string;
  vocal_key?: string;
  vocal_wav_url?: string;
  vocal_wav_key?: string;
  /* With a vocal effect: the voice with the effect (the dry one above is always kept), and what the worker did. In vocal
   * mode the take itself is the voice with the effect, so vocal_fx_key is key. */
  vocal_fx_url?: string;
  vocal_fx_key?: string;
  vocal_fx_wav_url?: string;
  vocal_fx_wav_key?: string;
  vocal_fx?: {
    preset?: string;
    label?: string;
    tempo_bpm?: number | null;
    tempo_source?: string | null;
    delay_ms?: number | null;
  } | null;
  pitch?: { shift?: number; source?: string; why?: string; share_above_top?: number } | null;
};
/** The take's link to the voice with its effect, beside the dry voice: only when it is a file of its own. In vocal mode the
 * take itself is the voice with the effect (the worker's key and vocal_fx_key are the same file), and a second link to it
 * would only be one more line for VoiceOver to read. */
export function myVoiceEffectLinks(
  output: MyVoiceOutput | undefined,
): { vocalFxUrl?: string; vocalFxWavUrl?: string } {
  if (!output?.vocal_fx_url) return {};
  if (output.vocal_fx_key && output.vocal_fx_key === output.key) return {};
  return { vocalFxUrl: output.vocal_fx_url, vocalFxWavUrl: output.vocal_fx_wav_url };
}
/** The vocal effect in a sentence: what went on the voice, and the tempo an echo followed. Empty for none. */
function effectNote(output: MyVoiceOutput, input?: Pick<Input, 'voice'>): string {
  const fx = output.vocal_fx;
  const asked = input?.voice?.options?.vocal_fx;
  if (!fx || !fx.label) {
    /* She chose an effect and a worker from before effects sang it dry: say so, so the dry sound is not a mystery. */
    if (asked && asked !== 'none' && !(output.features || []).includes('vocal-fx'))
      return 'The voice worker has no vocal effects yet, so your voice is dry in this version.';
    return '';
  }
  if (typeof fx.delay_ms === 'number' && fx.delay_ms > 0 && fx.preset !== 'slapback') {
    const bpm = typeof fx.tempo_bpm === 'number' ? Math.round(fx.tempo_bpm) : 120;
    return fx.tempo_source === 'detected'
      ? `Vocal effect: ${fx.label}, its repeats in time with the song at about ${bpm} beats a minute.`
      : `Vocal effect: ${fx.label}, its repeats at ${bpm} beats a minute because the recording has no clear beat.`;
  }
  return `Vocal effect: ${fx.label}.`;
}

/** A finished voice job in a sentence or three: the octave, the vocal effect, anything the worker had to work around, and what
 * it cost. input (the job's own) lets it say when an effect was asked for and the worker could not add one. */
export function myVoiceTakeNote(
  output: MyVoiceOutput | undefined,
  input?: Pick<Input, 'voice'>,
): string {
  if (!output) return '';
  const notes: string[] = ['Sung in your voice.'];
  const shift = output.pitch?.shift;
  if (typeof shift === 'number' && shift !== 0)
    notes.push(
      Math.abs(shift) === 12
        ? `Moved ${shift < 0 ? 'down' : 'up'} one octave to sit in your range.`
        : `Moved ${Math.abs(shift)} semitones ${shift < 0 ? 'down' : 'up'}.`,
    );
  else if (typeof output.pitch?.share_above_top === 'number' && output.pitch.share_above_top >= 0.1)
    notes.push('Some high notes sit above your usual top, so listen to those.');
  const effect = effectNote(output, input);
  if (effect) notes.push(effect);
  for (const note of (output.worker_notes || []).slice(0, 3))
    if (typeof note === 'string') notes.push(note);
  if (typeof output.execution_ms === 'number') {
    const card =
      typeof output.gpu === 'string' && output.gpu.trim()
        ? ` on ${output.gpu.replace(/^NVIDIA\s+(GeForce\s+)?/i, '')}`
        : '';
    notes.push(
      `About ${sayCents(myVoiceTakeCost(output.execution_ms, output.gpu))} of GPU time${card}, execution only.`,
    );
  }
  return notes.join(' ');
}

/* ---------- the guide: only ever added for an owner ------------------------------ */

export type MyVoiceGuideSetting = {
  key: string;
  label: string;
  hint: string;
  kind: string;
  options?: string[];
  default?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  /** Shown inside the page's one collapsed "More settings" group (Part 296), never hidden. */
  advanced?: boolean;
};
export type MyVoiceGuideEngine = {
  name: string;
  tagline: string;
  where: string;
  cost: string;
  bestFor: string[];
  notFor: string[];
  howToWrite: string[];
  settings: MyVoiceGuideSetting[];
  /** How a screen runs it: 'upload' has no script box; the recording is the input. */
  flow: 'upload';
  /** The engines whose finished takes can be sung again in this voice. */
  takesFrom: string[];
  ui: {
    render: string;
    select: string;
    /** Said once when a library take has just been attached to sing. */
    fromTake: string;
    needClip: string;
    useTake: string;
    vocal: string;
    /** The voice with its vocal effect, offered beside the dry one when an effect was used. */
    vocalFx: string;
    clip: string;
  };
};

/** The "Sing it in my voice" engine, at today's defaults (or MY_VOICE_DEFAULTS). */
export function myVoiceGuideEngine(env: NodeJS.ProcessEnv = process.env): MyVoiceGuideEngine {
  const d = myVoiceDefaults(env);
  const extractor = myVoiceExtractors.find((e) => e.key === d.extractor) || myVoiceExtractors[0];
  const effect = myVoiceEffects.find((e) => e.key === d.vocal_fx) || myVoiceEffects[0];
  return {
    name: 'Sing it in my voice',
    tagline: 'Import a song or a vocal and hear it sung in your own voice.',
    where:
      'Runs on your private voice worker, a sleeping GPU. Your voice model and recordings stay in your private storage, and nobody else can use your voice.',
    cost: myVoiceCost,
    bestFor: [
      'hearing a YuE2 or Lyria song sung in your voice',
      'a song file with music: the singing is split from the band, sung again in your voice, and put back',
      'a dry vocal with no music, converted as it is',
    ],
    notFor: [
      'recordings over six minutes',
      'fixing words: it re-sings exactly what the recording sings, so a word the split garbled stays garbled',
      'choosing different diction: pronunciation and rhythm still follow the original singer',
      "anybody else's voice",
    ],
    howToWrite: [
      'Import the recording under Recording to sing. A whole song as an MP3 fits, up to twenty megabytes and six minutes.',
      'Under What is in the file, choose Song with music when there is a band or a backing track: the singing is split from the music, the lead singer is sung again in your voice, and it is put back. Choose Just a vocal for singing with nothing else in it, such as a dry vocal you exported.',
      'Pitch is automatic: the melody stays where it is and moves one octave only when the song sits outside your range. To move it yourself, type semitones under More settings; twelve is one octave.',
      'The voice model changes the sound of the singer, while pronunciation and rhythm still follow the original singing. It does not perform the words again with your own diction.',
      'If some words come out strange, vocal separation can be a cause. Under More settings, try another Vocal extractor. Some of it can also be how the original was sung.',
      d.soft_s
        ? 'Keep original singer’s S sounds is on: S, SH, T and F hiss is put back from the original singer after conversion. Turn it off under More settings to keep the converted vocal without that added hiss.'
        : 'Keep original singer’s S sounds is off: original S, SH, T and F hiss is not put back after conversion. If converted S sounds are robotic, this optional setting can soften them using the original singer’s sounds; it does not change pronunciation or rhythm.',
      'Vocal effects puts studio reverb or echo on your voice: Studio polish evens and brightens it, Plate reverb and Hall reverb add a room, Slapback is one quick repeat, Echo repeats in time with the song, and Dreamy is a wide wash of echo and reverb. None keeps it dry.',
      'You get two files: the song in your voice, and your voice on its own, always dry, ready for a DAW. With a vocal effect on a song you also get your voice with the effect; with just a vocal, the take itself is your voice with the effect.',
    ],
    settings: [
      {
        key: 'reference_voice_url',
        label: 'Recording to sing',
        hint: 'A song or a vocal: WAV, MP3, M4A, OGG or FLAC, up to twenty megabytes and six minutes.',
        kind: 'clip',
        max: 1,
      },
      {
        key: 'voice_source',
        label: 'What is in the file',
        hint: 'Song with music splits the singing from the band first and puts it back after. Just a vocal is for singing with nothing else in it.',
        kind: 'choice',
        options: [myVoiceSources.song, myVoiceSources.vocal],
        default: myVoiceSources.song,
      },
      /* A main choice, in view with the recording (her ask: effects if she wants them). */
      {
        key: 'vocal_fx',
        label: 'Vocal effects',
        hint: "Studio reverb or echo on your voice. Echo follows the song's beat. Your dry voice is always kept as its own download.",
        kind: 'choice',
        options: myVoiceEffects.map((e) => e.label),
        default: effect.label,
      },
      /* Part 296 (her ask: the booth was cluttered): the recording and what is in it stay in view; every knob below sits in
       * the one collapsed More settings group, at the defaults the round 2 test measured. */
      {
        key: 'pitch',
        label: 'Pitch (semitones)',
        hint: 'Leave empty for automatic: the melody stays put unless the song sits outside your range, then it moves one octave. Or type a number: 12 is one octave up, -12 one octave down.',
        kind: 'number',
        min: -24,
        max: 24,
        step: 1,
        advanced: true,
      },
      {
        key: 'extractor',
        label: 'Vocal extractor',
        hint: 'What splits the singing from the music. BS-RoFormer HyperACE v2 kept the most words in tests. If words come out strange, try another one. When the chosen one cannot split a song, the BS-RoFormer from the first test takes over.',
        kind: 'choice',
        options: myVoiceExtractors.map((e) => e.label),
        default: extractor.label,
        advanced: true,
      },
      {
        key: 'lead_split',
        label: 'Split the lead from the backing vocals',
        hint: 'On: only the lead singer is sung again in your voice, and the backing vocals stay as they were. Off: every voice is sung together in your voice, and harmonies can wobble.',
        kind: 'toggle',
        default: d.lead_split,
        advanced: true,
      },
      {
        key: 'soft_s',
        label: 'Keep original singer’s S sounds',
        hint: 'Off: keep the converted vocal without adding original S, SH, T and F hiss back. On: restores those sounds from the original singer to soften robotic consonants. Pronunciation and rhythm still follow the original singing.',
        kind: 'toggle',
        default: d.soft_s,
        advanced: true,
      },
      {
        key: 'dereverb',
        label: 'Take the room off the voice first',
        hint: 'Off: the voice is sung with its echo, which kept the most words in tests. On: the echo is taken off before your voice sings it, and a matching room is put back after.',
        kind: 'toggle',
        default: d.dereverb,
        advanced: true,
      },
      {
        key: 'index_rate',
        label: 'Voice likeness',
        hint: 'How strongly the sound of your own recordings is pressed onto the singing. Higher sounds more like you but can blur words; lower keeps words clearer.',
        kind: 'range',
        min: 0,
        max: 1,
        step: 0.05,
        default: d.index_rate,
        advanced: true,
      },
      {
        key: 'protect',
        label: 'Protect breaths',
        hint: 'Protects some source breath and consonant detail during conversion. 0.5 disables protection. This is a clarity setting, not a way to choose different pronunciation or rhythm.',
        kind: 'range',
        min: 0,
        max: 0.5,
        step: 0.01,
        default: d.protect,
        advanced: true,
      },
      {
        key: 'rms_mix_rate',
        label: 'Loudness follows',
        hint: 'Lower follows the loud and soft moments of the original singer; 1 keeps the loudness your voice model gives.',
        kind: 'range',
        min: 0,
        max: 1,
        step: 0.05,
        default: d.rms_mix_rate,
        advanced: true,
      },
    ],
    flow: 'upload',
    takesFrom: ['yue2', 'lyria'],
    ui: {
      render: 'Sing it in my voice',
      select:
        'Sing it in my voice. Import a song or a vocal, choose what is in the file, then choose Sing it in my voice.',
      fromTake:
        'The take is attached to sing. Check What is in the file, then choose Sing it in my voice. The original is kept.',
      needClip: 'Import the recording to sing first, under Recording to sing.',
      useTake: 'Sing this take in my voice',
      vocal: 'Download my voice on its own',
      vocalFx: 'Download my voice with the effect',
      clip: 'Singing: ',
    },
  };
}

/** YuE2's automatic choice. */
export const myVoiceYueSetting: MyVoiceGuideSetting = {
  key: 'my_voice',
  label: 'Sing it in my voice',
  hint: 'On: after each take, the lead singer is sung again in your voice and that version is saved beside the original in this project. Both are kept. It adds a few cents of GPU time a take, and the version in your voice follows a few minutes after the take.',
  kind: 'choice',
  options: [myVoiceAutoOptions.off, myVoiceAutoOptions.on],
  default: myVoiceAutoOptions.off,
};

type Guide = {
  engines: Record<string, unknown> & { yue2?: { settings?: Array<{ key: string }> } };
};
/** The guide for an owner: the engine, and the YuE2 choice just before Number of takes. Anyone else's guide is returned as it was. */
export function withMyVoiceGuide<T extends Guide>(
  guide: T,
  model: MyVoiceModel | null,
  env: NodeJS.ProcessEnv = process.env,
): T {
  if (!model || !guide || !guide.engines) return guide;
  const engines: Record<string, unknown> = {
    ...guide.engines,
    [myVoiceEngine]: myVoiceGuideEngine(env),
  };
  const yue = guide.engines.yue2;
  if (
    yue &&
    Array.isArray(yue.settings) &&
    !yue.settings.some((s) => s.key === myVoiceYueSetting.key)
  ) {
    const at = yue.settings.findIndex((s) => s.key === 'count');
    const settings: Array<{ key: string }> = [...yue.settings];
    settings.splice(at < 0 ? settings.length : at, 0, myVoiceYueSetting);
    engines.yue2 = { ...yue, settings };
  }
  return { ...guide, engines };
}

/* ---------- the worker ---------------------------------------------------------- */

async function provider(
  path: string,
  data?: { input: MyVoiceWorkerInput; policy: { executionTimeout: number; ttl: number } },
): Promise<Provider> {
  const response = await axios.request<Provider>({
    url: `https://api.runpod.ai/v2/${process.env.MY_VOICE_ENDPOINT_ID}/${path}`,
    method: data || path.startsWith('cancel/') ? 'POST' : 'GET',
    data,
    headers: { Authorization: `Bearer ${process.env.RUNPOD_API_KEY}` },
    timeout: 30000,
  });
  return response.data;
}
const POLICY = { executionTimeout: 900000, ttl: 3600000 };
async function workerStatus(providerId: string | undefined): Promise<Provider> {
  const result = await provider(`status/${encodeURIComponent(providerId || '')}`);
  const output = result.output && {
    ...result.output,
    queue_ms: result.delayTime,
    execution_ms: result.executionTime,
  };
  return { ...result, output, costUSD: myVoiceTakeCost(result.executionTime, result.output?.gpu) };
}

export type MyVoiceRouterHooks = Hooks & {
  /** The owner check: the account's voice model, or null. */
  find: (user: string) => Promise<MyVoiceModel | null>;
  /** The imported recording's length in seconds, for the estimate. */
  seconds?: (user: string, url: string) => Promise<number | undefined>;
};

/** The "Sing it in my voice" engine: the booth's job lane (audio/jobs.ts) behind an owner gate. For an account with no voice
 * model a render naming this engine leaves this router untouched and falls through, exactly as an unknown engine does. */
export function createMyVoiceRouter(hooks: MyVoiceRouterHooks): Router {
  const router = express.Router();
  router.post('/render', express.json({ limit: '128kb' }), (req: Request, res, next) => {
    if (req.body?.engine !== myVoiceEngine) return next();
    return hooks.auth(req, res, () => {
      hooks
        .find(hooks.user(req))
        .then((model) => (model ? next() : next('router')))
        .catch(() => next('router'));
    });
  });
  router.use(
    createAudioRouter(
      { ...hooks, prepare: myVoicePrepare(hooks.find, hooks.seconds) },
      {
        engine: myVoiceEngine,
        prefix: 'voice_',
        model: 'KadeVoiceJob',
        name: 'voice',
        configured: () => myVoiceEnabled(),
        parse: (body) => myVoiceInput(body),
        estimate: myVoiceEstimate,
        submit: (input) => provider('run', { input: myVoiceWorkerInput(input), policy: POLICY }),
        status: (take) => workerStatus(take.providerId),
        cancel: async (take) => {
          await provider(`cancel/${encodeURIComponent(take.providerId || '')}`);
        },
        working:
          'Your voice version is being made. It usually takes two to four minutes, longer if the voice worker has to wake up.',
        stopping: 'Stop requested. GPU time already used is still billed.',
        takeNote: (output, input) => myVoiceTakeNote(output, input),
      },
    ),
  );
  return router;
}

/* ---------- automatic: every YuE2 take, again in her voice ------------------------ */

type FollowUp = {
  id: string;
  user: string;
  projectId: string;
  sourceAssetId: string;
  batchId: string;
  title: string;
  providerId?: string;
  state: string;
  input: MyVoiceWorkerInput;
  output?: MyVoiceOutput;
  error?: string;
  costUSD?: number;
  notified?: boolean;
  createdAt: Date;
  leaseUntil?: Date;
};
export type MyVoiceFollowUp = Omit<FollowUp, 'input' | 'leaseUntil'>;
const followUpSchema = new mongoose.Schema<FollowUp>({
  id: { type: String, unique: true },
  user: String,
  projectId: String,
  sourceAssetId: { type: String, unique: true },
  batchId: String,
  title: String,
  providerId: String,
  state: String,
  input: mongoose.Schema.Types.Mixed,
  output: mongoose.Schema.Types.Mixed,
  error: String,
  costUSD: Number,
  notified: Boolean,
  createdAt: Date,
  leaseUntil: Date,
});

export type MyVoiceFollowUpHooks = {
  find: (user: string) => Promise<MyVoiceModel | null>;
  /** Save the finished version: an asset beside the source take, in the same project. */
  complete: (row: MyVoiceFollowUp) => Promise<void>;
  /** Say on the source take that its voice version did not finish. */
  failed?: (row: MyVoiceFollowUp) => Promise<void>;
  /** Once, when every version of one YuE2 request has finished. */
  notify?: (row: MyVoiceFollowUp, done: number, total: number) => Promise<void>;
  /** True while the YuE2 request a version came from can still finish takes (so more versions may be queued): the one
   * notification waits for it. Without this hook, the versions queued so far are the whole request. */
  batchOpen?: (row: MyVoiceFollowUp) => Promise<boolean>;
  log?: (line: string) => void;
};
export type MyVoiceQueue = {
  user: string;
  projectId: string;
  sourceAssetId: string;
  sourceJobId: string;
  audioKey?: string;
  title: string;
};
export type MyVoiceFollowUps = {
  queue: (take: MyVoiceQueue) => Promise<{ queued: boolean; reason?: string }>;
  advance: () => Promise<void>;
  stop: () => void;
};

const ACTIVE = ['submitting', 'queued', 'running', 'saving'];

/** Queues a voice version of each finished YuE2 take whose request asked for one, and walks them to the end on a timer. Idempotent
 * per source take (a take retried after a crash is queued once); a submission whose answer was lost is marked uncertain and never
 * sent again, the same no-paid-retry rule as every other booth lane. */
export function createMyVoiceFollowUps(
  hooks: MyVoiceFollowUpHooks,
  options: { intervalMs?: number } = {},
): MyVoiceFollowUps {
  const Rows =
    (mongoose.models.KadeVoiceFollowUp as mongoose.Model<FollowUp>) ||
    mongoose.model<FollowUp>('KadeVoiceFollowUp', followUpSchema);
  const log = hooks.log || (() => undefined);
  const view = ({ input: _input, leaseUntil: _lease, ...row }: FollowUp): MyVoiceFollowUp => row;
  let indexes: Promise<void> | undefined;

  async function queue(take: MyVoiceQueue): Promise<{ queued: boolean; reason?: string }> {
    if (!myVoiceEnabled()) return { queued: false, reason: 'off' };
    if (!take.audioKey) return { queued: false, reason: 'no audio key' };
    const model = await hooks.find(take.user);
    if (!model) return { queued: false, reason: 'no voice model' };
    const input = withModel(
      { mode: 'song', audio_key: take.audioKey, pitch: 'auto' },
      model,
      myVoiceDefaults(),
    );
    const id = `voiceauto_${randomUUID()}`;
    try {
      indexes ??= Rows.createIndexes(); // the unique source-take index is what makes a retried take queue once
      await indexes;
      await Rows.create({
        id,
        user: take.user,
        projectId: take.projectId,
        sourceAssetId: take.sourceAssetId,
        batchId: String(take.sourceJobId).replace(/_\d+$/, ''),
        title: take.title,
        state: 'submitting',
        input,
        createdAt: new Date(),
        // held while the submission is in flight, so the timer cannot take it for a crashed one; a real crash expires it
        leaseUntil: new Date(Date.now() + 300000),
      });
    } catch (error) {
      const duplicate =
        error instanceof Error && 'code' in error && (error as { code?: number }).code === 11000;
      return { queued: false, reason: duplicate ? 'already queued' : 'queue unavailable' };
    }
    try {
      const response = await provider('run', { input, policy: POLICY });
      if (!response.id) throw new Error('Missing job id');
      await Rows.updateOne(
        { id },
        { $set: { providerId: response.id, state: 'queued' }, $unset: { leaseUntil: 1 } },
      );
      log(`[soundbooth/myvoice] queued ${id} for take ${take.sourceAssetId}`);
      return { queued: true };
    } catch {
      await Rows.updateOne(
        { id },
        {
          $set: {
            state: 'uncertain',
            error:
              'Could not confirm that the version in your voice started. No automatic paid retry was made.',
          },
          $unset: { leaseUntil: 1 },
        },
      );
      const row = await Rows.findOne({ id }).lean();
      if (row && hooks.failed) await hooks.failed(view(row)).catch(() => undefined);
      return { queued: false, reason: 'submission unconfirmed' };
    }
  }

  async function finishBatch(row: FollowUp): Promise<void> {
    if (!hooks.notify) return;
    const batch = await Rows.find({ batchId: row.batchId, user: row.user }).lean();
    if (batch.some((r) => ACTIVE.includes(r.state)) || batch.some((r) => r.notified)) return;
    /* A YuE2 request's takes can finish minutes apart. Without this, the first take's version could be announced as the
     * whole batch ("1 of 1") and the later ones never. advance() comes back to a settled batch once its request ends. */
    if (hooks.batchOpen && (await hooks.batchOpen(view(row)).catch(() => false))) return;
    const claim = await Rows.updateMany(
      { batchId: row.batchId, user: row.user, notified: { $ne: true } },
      { $set: { notified: true } },
    );
    if (!claim.modifiedCount) return;
    await hooks
      .notify(view(row), batch.filter((r) => r.state === 'done').length, batch.length)
      .catch(() => undefined);
  }

  async function step(id: string): Promise<void> {
    const lease = new Date(Date.now() + 300000);
    const row = await Rows.findOneAndUpdate(
      {
        id,
        state: { $in: ACTIVE },
        $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: new Date() } }],
      },
      { $set: { leaseUntil: lease } },
      { new: true },
    ).lean();
    if (!row) return;
    try {
      if (row.state === 'submitting') {
        // A crash between saving the row and hearing back from RunPod: never guess, never resend.
        row.state = 'uncertain';
        row.error =
          'Could not confirm that the version in your voice started. No automatic paid retry was made.';
      } else if (row.state !== 'saving') {
        const response = await workerStatus(row.providerId);
        row.costUSD = response.costUSD || 0;
        if (response.status === 'COMPLETED' && response.output?.url && !response.output.error) {
          row.state = 'saving';
          row.output = response.output as MyVoiceOutput;
        } else if (
          ['FAILED', 'CANCELLED', 'TIMED_OUT', 'COMPLETED'].includes(response.status || '')
        ) {
          row.state = response.status === 'CANCELLED' ? 'cancelled' : 'failed';
          row.error =
            response.output?.error ||
            response.error ||
            'The voice worker did not finish. The original take is kept.';
        } else {
          row.state = response.status === 'IN_PROGRESS' ? 'running' : 'queued';
        }
      }
      await Rows.updateOne(
        { id },
        { $set: { state: row.state, output: row.output, error: row.error, costUSD: row.costUSD } },
      );
      if (row.state === 'saving') {
        await hooks.complete(view(row));
        row.state = 'done';
        await Rows.updateOne({ id }, { $set: { state: 'done' } });
        log(`[soundbooth/myvoice] saved ${id} beside take ${row.sourceAssetId}`);
      } else if (['failed', 'cancelled', 'uncertain'].includes(row.state) && hooks.failed) {
        await hooks.failed(view(row)).catch(() => undefined);
      }
      if (!ACTIVE.includes(row.state)) await finishBatch(row);
    } catch {
      /* Keep it where it was; the next pass tries again. A failed save is retried, a finished job is never re-run. */
    } finally {
      await Rows.updateOne({ id, leaseUntil: lease }, { $unset: { leaseUntil: 1 } });
    }
  }

  let polling = false;
  async function advance(): Promise<void> {
    if (polling || mongoose.connection.readyState !== 1 || !myVoiceEnabled()) return;
    polling = true;
    try {
      const rows = await Rows.find({ state: { $in: ACTIVE } })
        .select('id')
        .lean();
      for (const row of rows) await step(row.id).catch(() => undefined);
      /* Settled batches not yet announced (their YuE2 request was still running when the last version finished). */
      if (hooks.notify && hooks.batchOpen) {
        const settled = await Rows.find({
          state: { $nin: ACTIVE },
          notified: { $ne: true },
          createdAt: { $gt: new Date(Date.now() - 2 * 86400000) },
        }).lean();
        const seen = new Set<string>();
        for (const row of settled) {
          const key = `${row.user}|${row.batchId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          await finishBatch(row).catch(() => undefined);
        }
      }
    } catch {
      /* the database is away; the rows stay durable until it is back */
    } finally {
      polling = false;
    }
  }
  const timer = setInterval(() => void advance(), options.intervalMs || 20000);
  timer.unref();
  return { queue, advance, stop: () => clearInterval(timer) };
}
