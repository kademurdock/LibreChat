import axios from 'axios';
import type { Router } from 'express';
import type { Hooks, Input, InputBody, Output, Provider } from '../audio/jobs';
import { createAudioRouter } from '../audio/jobs';

export const yueCost =
  'No reliable per-song cost estimate yet. YuE2 currently does not deduct from your credit balance. GPU time is paid by the second, at the rate of whichever graphics card runs the song, including startup and ten minutes awake after the last job. Up to two GPUs can run together; extra takes and higher settings use more GPU time.';

/* Part 295: what a take costs depends on the card that ran it. RunPod serverless flex prices
 * per second (runpod.io/pricing, updated Sep 13 2026), matched against the worker's `gpu`
 * output (torch.cuda.get_device_name, for example "NVIDIA GeForce RTX 5090"). First match wins. */
export const yueGpuRates: ReadonlyArray<{ card: string; pattern: RegExp; usdPerSecond: number }> = [
  { card: 'B200', pattern: /\bB200\b/i, usdPerSecond: 0.0024 },
  { card: 'H200', pattern: /\bH200\b/i, usdPerSecond: 0.001647 },
  { card: 'H100', pattern: /\bH100\b/i, usdPerSecond: 0.001331 },
  { card: 'RTX PRO 6000', pattern: /\bRTX PRO 6000\b/i, usdPerSecond: 0.000969 },
  { card: 'A100', pattern: /\bA100\b/i, usdPerSecond: 0.000756 },
  { card: 'RTX 6000 Ada, L40 or L40S', pattern: /\bRTX 6000 Ada\b|\bL40S?\b/i, usdPerSecond: 0.000486 },
  { card: 'RTX 5090', pattern: /\bRTX 5090\b/i, usdPerSecond: 0.000439 },
  { card: 'RTX 4090', pattern: /\bRTX 4090\b/i, usdPerSecond: 0.000306 },
  { card: 'A40 or RTX A6000', pattern: /\bA40\b|\bRTX A6000\b/i, usdPerSecond: 0.000339 },
];
/** An unknown card is priced as the A40, the endpoint's long-standing pool. */
export const yueFallbackUsdPerSecond = 0.000339;

/** One take's GPU cost: billed seconds at its card's rate. A worker that does not name its
 * card (before Part 295) keeps the old figure, $1.22 an hour, exactly as before. */
export function yueTakeCost(executionMs: number | undefined, gpu?: string | null): number {
  const ms = executionMs || 0;
  if (typeof gpu !== 'string' || !gpu.trim()) return (ms / 3600000) * 1.22;
  const row = yueGpuRates.find((rate) => rate.pattern.test(gpu));
  return (ms / 1000) * (row ? row.usdPerSecond : yueFallbackUsdPerSecond);
}

/* Trained styles: each is an AR LoRA trained on a folder of real songs, kept in the private
 * bucket and folded into the composer by the worker for one song. The lead sentence is the
 * caption its LoRA was trained under, trigger word first, so it has to open the style text.
 * They were trained score-free, so a new song in a style asks the worker for cot off.
 * Chosen by ear on the stock decoder (Part 239): kids step 1200, soul the sonauto step 1800,
 * which replaced the first soul LoRA because it sings one steady voice instead of drifting
 * between a man and a woman. Nothing here names a person or a private folder: this menu is
 * read by everyone who uses the booth. */
export const yueStyles: Record<string, { key: string; scale: number; lead: string }> = {
  kids: {
    key: 'yue2-loras/kids-step1200.pt',
    scale: 1,
    lead: "kdkids, in the style of kdkids. English, children's choir, a group of young voices singing together, bright and clear.",
  },
  soul: {
    key: 'yue2-loras/soul-sona1800.pt',
    scale: 1,
    lead: 'kdsona, in the style of kdsona. English, female lead vocal.',
  },
};
export function yueStylesEnabled(): boolean {
  return process.env.YUE_STYLES_ENABLED === '1';
}

/* Part 295: the official cover recipe (chords kept) and instrumentals, behind YUE_COVERS_V2=1.
 * With the flag unset every request, guide and answer is exactly as before. The live worker
 * must run the Part 295 image before the flag goes on: an older worker would ignore
 * `instrumental` and sing wordless takes. The two choices below are real guide settings, so the
 * web page and the iPhone render them without an update; their option values are the words
 * each client reads out. A client that sends nothing gets the server defaults. */
export function yueCoversEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.YUE_COVERS_V2 === '1';
}
/** YUE_COVER_KEEP_CHORDS_DEFAULT: 1 (the default) keeps a recording's chords, 0 drops them. */
export function yueKeepChordsDefault(env: NodeJS.ProcessEnv = process.env): boolean {
  const said = String(env.YUE_COVER_KEEP_CHORDS_DEFAULT ?? '1').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(said);
}
export const yueSinging: { sung: string; instrumental: string } = {
  sung: 'Sung, with my lyrics',
  instrumental: 'Instrumental, no singing',
};
export const yueKeepChords: { yes: string; no: string } = {
  yes: 'Yes: sound closer to the original song',
  no: 'No: a new accompaniment that fits my style',
};
const NAMES_BPM = /\b\d{2,3}(?:\.\d+)?\s*bpm\b/i;

/** A choice's first word, lower case: "Instrumental, no singing" is "instrumental". */
function firstWord(value: string | boolean | undefined): string | boolean | undefined {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value !== 'string') return '?';
  return value.trim().toLowerCase().split(/[\s,:.]+/)[0] || undefined;
}
export function yueInstrumentalChoice(value: string | boolean | undefined): boolean {
  const word = firstWord(value);
  if (word === undefined || word === false || word === 'sung') return false;
  if (word === true || word === 'instrumental') return true;
  throw new Error('Under Singing or instrumental, choose Sung or Instrumental.');
}
export function yueKeepChordsChoice(
  value: string | boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const word = firstWord(value);
  if (word === undefined) return yueKeepChordsDefault(env);
  if (word === true || word === 'yes') return true;
  if (word === false || word === 'no') return false;
  throw new Error('Under Keep the original chords, choose Yes or No.');
}

export function yueInput(body: InputBody, env: NodeJS.ProcessEnv = process.env): Input {
  const covers = yueCoversEnabled(env);
  const instrumental = covers && yueInstrumentalChoice(body.singing);
  if (typeof body.script !== 'string' || body.script.trim().length < 3 || body.script.length > 3000)
    throw new Error('Describe the music in 3 to 3000 characters.');
  if (instrumental) {
    if (body.lyrics != null && (typeof body.lyrics !== 'string' || body.lyrics.length > 8000))
      throw new Error('Keep Lyrics to 8000 characters. An instrumental sings none of them.');
  } else if (typeof body.lyrics !== 'string' || !body.lyrics.trim() || body.lyrics.length > 8000)
    throw new Error(
      covers
        ? 'Add the words to sing in Lyrics, up to 8000 characters, or choose Instrumental under Singing or instrumental.'
        : 'Add the words to sing in Lyrics, up to 8000 characters.',
    );
  if (body.abc != null && (typeof body.abc !== 'string' || body.abc.length > 40000))
    throw new Error('The score must be ABC text, up to 40000 characters.');
  if (
    body.seed != null &&
    (!Number.isInteger(body.seed) || body.seed < 0 || body.seed > 2147483647)
  )
    throw new Error('Seed must be a whole number from 0 to 2147483647.');
  if (body.referenceExpected && !body.reference_voice_url)
    throw new Error(
      'Wait for the cover recording to finish importing, or discard the failed import.',
    );
  if (
    body.reference_voice_url &&
    (typeof body.reference_voice_url !== 'string' ||
      !body.reference_voice_url.startsWith('https://') ||
      body.reference_voice_url.length > 12000)
  )
    throw new Error('Import the source recording again.');
  if (body.reference_voice_url && body.abc)
    throw new Error(
      'Use an imported recording or a composition score. Remove one before generating.',
    );
  if (body.title != null && (typeof body.title !== 'string' || body.title.length > 80))
    throw new Error('Use a title up to 80 characters.');
  const band = body.band && body.band !== 'none' ? body.band : undefined;
  if (band && (!yueStylesEnabled() || !Object.prototype.hasOwnProperty.call(yueStyles, band)))
    throw new Error('That trained style is not available. Choose None or another style.');
  const trained = band ? yueStyles[band] : undefined;
  /* The worker refuses an instrumental without a score, and trained styles are singing styles
   * sent score-free, so the booth says so here instead of quietly changing either one. */
  if (trained && instrumental)
    throw new Error(
      'Styles are for singing, so an instrumental cannot use one. Set Style to None, or choose Sung under Singing or instrumental.',
    );
  function number(
    value: number | undefined,
    fallback: number,
    low: number,
    high: number,
    label: string,
    integer = true,
  ): number {
    if (value == null) return fallback;
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < low ||
      value > high ||
      (integer && !Number.isInteger(value))
    )
      throw new Error(
        `${label} must be ${integer ? 'a whole number ' : ''}from ${low} to ${high}.`,
      );
    return value;
  }
  const recording = !!body.reference_voice_url;
  const keepChords = covers && recording ? yueKeepChordsChoice(body.keep_chords, env) : undefined;
  return {
    style: trained ? `${trained.lead} ${body.script.trim()}`.slice(0, 3000) : body.script.trim(),
    title: body.title?.trim() || body.script.trim().split(/\s+/).slice(0, 7).join(' ').slice(0, 80),
    count: number(body.count, 1, 1, 4, 'Number of takes'),
    weirdness: number(body.weirdness, 50, 0, 100, 'Creative variation'),
    steps: number(body.steps, 32, 16, 64, 'Inference steps'),
    guidance: number(body.guidance, 1, 1, 3, 'Prompt guidance', false),
    lyrics: (body.lyrics || '').trim(),
    abc: body.abc || undefined,
    reference_voice_url: body.reference_voice_url || undefined,
    cot:
      keepChords !== undefined
        ? keepChords
          ? 'full'
          : 'melody'
        : body.reference_voice_url || (body.abc && body.cot !== 'full')
          ? 'melody'
          : trained && !body.abc
            ? 'off'
            : 'full',
    band,
    lora_key: trained?.key,
    lora_scale: trained?.scale,
    seed: body.seed ?? Math.floor(Math.random() * 2147483647),
    ...(covers ? coverFields(body, instrumental, keepChords) : {}),
  };
}

/** The Part 295 worker fields for one request; none for a sung new song or a sung score. */
function coverFields(
  body: InputBody,
  instrumental: boolean,
  keepChords: boolean | undefined,
): Pick<Input, 'instrumental' | 'keep_harmony' | 'match_score_tempo' | 'length_guard'> {
  const fields: Pick<Input, 'instrumental' | 'keep_harmony' | 'match_score_tempo' | 'length_guard'> = {};
  const score = !!body.abc && instrumental;
  const keep = keepChords !== undefined ? keepChords : score ? body.cot === 'full' : undefined;
  if (instrumental) fields.instrumental = true;
  if (keepChords !== undefined || score) fields.keep_harmony = keep;
  /* Upstream: keep the style's tempo consistent with the score's. Her own BPM always wins. */
  if (keep && !NAMES_BPM.test(String(body.script))) fields.match_score_tempo = true;
  if (Object.keys(fields).length) fields.length_guard = true;
  return fields;
}

export type YueCoverOptions = { singing?: string; keep_chords?: string };
/** The two choices as saved on the project, in the words the settings show, so Open in the
 * booth restores them. Empty for a request that sent no Part 295 field. */
export function yueCoverOptions(input: Input): YueCoverOptions {
  if (input.length_guard !== true) return {};
  const options: YueCoverOptions = {
    singing: input.instrumental ? yueSinging.instrumental : yueSinging.sung,
  };
  if (input.reference_voice_url && typeof input.keep_harmony === 'boolean')
    options.keep_chords = input.keep_harmony ? yueKeepChords.yes : yueKeepChords.no;
  return options;
}

/** A library row's reason line; a project from before Part 295 keeps its old one. */
export function yueProjectWhy(options?: YueCoverOptions & { reference_voice_url?: string }): string {
  const song = 'YuE2 — a song made on the sleeping music GPU';
  if (!options || typeof options.singing !== 'string') return song;
  const what =
    options.singing === yueSinging.instrumental
      ? 'YuE2 — an instrumental made on the sleeping music GPU'
      : song;
  if (!options.reference_voice_url || typeof options.keep_chords !== 'string') return what;
  return (
    what +
    (options.keep_chords === yueKeepChords.yes
      ? ', a cover keeping the original chords'
      : ', a cover with a new accompaniment')
  );
}

function sectionWords(name: string | null | undefined): string {
  const said = String(name || '')
    .replace(/[[\]]/g, '')
    .trim()
    .toLowerCase();
  return said ? `The ${said} words` : 'Some words';
}

/** A short spoken note about one finished take, from what the worker reported. Reads `features`
 * first, so a worker older than Part 295 never gets a note. */
export function yueTakeNote(output: Output | undefined, input: Input): string {
  if (!output || !Array.isArray(output.features)) return '';
  const notes: string[] = [];
  if (
    input.keep_harmony === true &&
    input.reference_voice_url &&
    output.features.includes('chord-check') &&
    output.cover_mode === 'melody'
  )
    notes.push(
      'No chords were heard in the recording, so the cover used its melody with a new accompaniment.',
    );
  if (!output.instrumental && output.features.includes('lyric-fit') && output.lyric_fit) {
    const rows = (output.lyric_fit.sections || []).filter(
      (row) =>
        (row.fit === 'short' || row.fit === 'long') &&
        typeof row.syllables === 'number' &&
        typeof row.sung_notes === 'number',
    );
    for (const row of rows.slice(0, 2))
      notes.push(
        `${sectionWords(row.lyrics_section || row.score_section)} look ${row.fit} for its tune: ${row.syllables} syllables for ${row.sung_notes} notes.`,
      );
    if (rows.length > 2)
      notes.push(`Words in ${rows.length - 2} more section${rows.length === 3 ? '' : 's'} may not fit their tune either.`);
  }
  return notes.join(' ');
}

export type YueTakeFacts = {
  instrumental?: boolean;
  coverMode?: string;
  gpu?: string;
  takeNote?: string;
};
/** What the asset keeps about a finished take; nothing for a worker older than Part 295. */
export function yueTakeFacts(output: Output | undefined, input: Input): YueTakeFacts {
  if (!output || !Array.isArray(output.features)) return {};
  const facts: YueTakeFacts = {};
  if (typeof output.instrumental === 'boolean') facts.instrumental = output.instrumental;
  if (typeof output.cover_mode === 'string') facts.coverMode = output.cover_mode;
  if (typeof output.gpu === 'string') facts.gpu = output.gpu;
  const note = yueTakeNote(output, input);
  if (note) facts.takeNote = note;
  return facts;
}

export type YueGuideSetting = {
  key: string;
  label: string;
  hint: string;
  kind: string;
  options?: string[];
  default?: string | number | boolean;
};
const COT_HINT_V2 =
  'This does nothing for a brand new song. With an ABC score, Melody follows the tune and frees the arrangement; Full keeps the chords too. For a recording, use Keep the original chords instead.';

/** The YuE2 guide settings with the two Part 295 choices; unchanged while the flag is off. */
export function yueCoverSettings<T extends { key: string; hint: string }>(
  settings: T[],
  env: NodeJS.ProcessEnv = process.env,
): Array<T | YueGuideSetting> {
  if (!yueCoversEnabled(env)) return settings;
  const styles =
    env.YUE_STYLES_ENABLED === '1'
      ? ' Styles are for singing, so choose None under Style for an instrumental.'
      : '';
  const singing: YueGuideSetting = {
    key: 'singing',
    label: 'Singing or instrumental',
    hint: `Instrumental plays the tune a singer would sing on instruments instead, for a new song or for a cover of a recording. Lyrics are optional then and nothing is sung; for a new song, section tags such as [Verse] and [Chorus] or a few words only guide its shape. It can still hum or sing a little now and then, so listen to check.${styles}`,
    kind: 'choice',
    options: [yueSinging.sung, yueSinging.instrumental],
    default: yueSinging.sung,
  };
  const chords: YueGuideSetting = {
    key: 'keep_chords',
    label: 'Keep the original chords',
    hint: "Used only for a cover of a recording. Yes reads the recording's chords as well as its melody, so the cover sounds closer to the original song, and YuE2 is told the recording's tempo unless Music direction already names a BPM. No keeps only the melody and writes a new accompaniment that fits your style. In YuE2's published test on 948 songs, keeping the chords made covers easier to recognise; leaving them out fit the new style better and scored higher for musicality. A recording with no chords, such as one voice singing alone, uses its melody either way.",
    kind: 'choice',
    options: [yueKeepChords.yes, yueKeepChords.no],
    default: yueKeepChordsDefault(env) ? yueKeepChords.yes : yueKeepChords.no,
  };
  return settings.flatMap((setting): Array<T | YueGuideSetting> => {
    if (setting.key === 'lyrics') return [singing, setting];
    if (setting.key === 'reference_voice_url') return [setting, chords];
    if (setting.key === 'cot') return [{ ...setting, hint: COT_HINT_V2 }];
    return [setting];
  });
}

export function yueConfigured(): boolean {
  return !!(process.env.YUE_ENDPOINT_ID && process.env.RUNPOD_API_KEY);
}
async function provider(
  path: string,
  data?: { input: Input; policy: { executionTimeout: number; ttl: number } },
): Promise<Provider> {
  const base = `https://api.runpod.ai/v2/${process.env.YUE_ENDPOINT_ID}`;
  const response = await axios.request<Provider>({
    url: `${base}/${path}`,
    method: data || path.startsWith('cancel/') ? 'POST' : 'GET',
    data,
    headers: { Authorization: `Bearer ${process.env.RUNPOD_API_KEY}` },
    timeout: 30000,
  });
  return response.data;
}

export function createYueRouter(hooks: Hooks): Router {
  return createAudioRouter(hooks, {
    engine: 'yue2',
    prefix: 'yue_',
    model: 'KadeYueJob',
    name: 'YuE2',
    configured: yueConfigured,
    parse: yueInput,
    estimate: (input) => ({
      spoken: `${input.count} take${input.count === 1 ? '' : 's'}. ${yueCost}`,
    }),
    submit: (input) =>
      provider('run', { input, policy: { executionTimeout: 1200000, ttl: 7200000 } }),
    status: async (take) => {
      const result = await provider(`status/${encodeURIComponent(take.providerId || '')}`);
      /* RunPod reports how long the job waited for a GPU (delayTime) and how long
       * it ran. Keeping both beside the take is what tells a cold wake from a
       * slow run; the booth used to discard them. */
      const output = result.output && {
        ...result.output,
        queue_ms: result.delayTime,
        execution_ms: result.executionTime,
      };
      return { ...result, output, costUSD: yueTakeCost(result.executionTime, result.output?.gpu) };
    },
    cancel: async (take) => {
      await provider(`cancel/${encodeURIComponent(take.providerId || '')}`);
    },
    working: 'YuE2 is composing. Up to two takes can run together when GPUs are available.',
    stopping:
      'Stop requested for unfinished takes. Finished takes are kept. GPU time already used is still billed.',
    takeNote: yueTakeNote,
  });
}
