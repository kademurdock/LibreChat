import axios from 'axios';
import type { Router } from 'express';
import type { Hooks, Input, InputBody, Output, Provider } from '../audio/jobs';
import { createAudioRouter } from '../audio/jobs';

export const yueCost =
  'YuE2 does not deduct from your credit balance yet, and there is no per-song estimate. GPU time is billed by the second, including startup and two minutes awake after the last job; extra takes and higher settings use more.';

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

/* Trained styles: each is an AR LoRA trained on recordings, kept in the private
 * bucket and folded into the composer by the worker for one song. The lead sentence is the
 * caption its LoRA was trained under, trigger word first, so it has to open the style text.
 * They were trained score-free, so a new song in a style asks the worker for cot off.
 * Kids: step 1200, chosen by ear on the stock decoder (Part 239), trained on recordings of
 * children's choirs.
 * Soul (Part 295, Sep 27 2026): the composer LoRA taught from real soul and R&B records
 * (trigger kdsoulr, step 1000, the steadiest words of the pilot), chosen in a blind test over
 * the first Sona, a September style taught from songs made with Sonauto (yue2-loras/soul-sona1800.pt,
 * lead "kdsona, in the style of kdsona. English, female lead vocal."). That file stays in storage
 * but is not used: Sona is back as a style of its own (below) on a retrained file. Soul's training
 * captions were "kdsoulr, in the style of kdsoulr.
 * English, <era> <sub-genre>, <pace>, <female|male> lead vocal, ...", one per song, so the
 * lead names the genre and leaves the singer to Music direction. Trained on commercial
 * records, so the whole Style choice is part of the Family feature pack (yueStyleAccess).
 * Suno (Oct 2026): the composer LoRA taught from a collection of songs made with Suno (trigger
 * kdsuno, step 600: the checkpoint that was listened to and kept, which the training run's own
 * screen also ranked best).
 * Its training captions were "kdsuno, in the style of kdsuno. English, <genre>, <pace>,
 * <female|male|both> lead vocal, <sound words>, <N> BPM.", one per song (female lead 220, male
 * lead 89, both 25, no singer named 36). The lead stops at the language, comma included, so
 * Music direction carries the caption on the way the captions did, and the genre and the
 * singer are hers to choose.
 * These songs are AI-made, so the commercial-records reason above does not cover them. This
 * style sits behind the Family feature pack for a different reason: Suno's terms are read as
 * restricting use of its output to build competing models, so it is a private style tool for
 * the family. The pack gate must stay for it (yueStyleAccess and the render refusal gate every
 * row at once); do not open the Style choice to every account. Removing its row is the rollback.
 * Sona (Oct 2026): the composer LoRA retrained from female-lead pop songs made with Sonauto,
 * their lyrics written by Gemini (trigger kdsona, step 800, yue2-loras/sona-step800.pt, 279,028,157
 * bytes). Its training captions were "kdsona, in the style of kdsona. English, female lead vocal,
 * <N> BPM.", one per song. The lead stops at the language, comma included, like Suno's, so Music
 * direction carries the caption on. Nothing in the lead picks a voice: every song it was taught
 * from has a female lead, which is what the hint tells people to expect. The first Sona
 * (soul-sona1800.pt, above) is retired for good: this row has a different key, and the old lead
 * is recognised only to clean up older saved songs (yueMusicDirection). These songs are AI-made
 * too, so Sona sits behind the same Family feature pack gate as every other row. Removing its row
 * is the rollback.
 * Nothing here names a person or a private folder: this menu is read by everyone who uses the
 * booth. */
export const yueStyles: Record<string, { key: string; scale: number; lead: string }> = {
  kids: {
    key: 'yue2-loras/kids-step1200.pt',
    scale: 1,
    lead: "kdkids, in the style of kdkids. English, children's choir, a group of young voices singing together, bright and clear.",
  },
  soul: {
    key: 'yue2-loras/soul-real-step1000.pt',
    scale: 1,
    lead: 'kdsoulr, in the style of kdsoulr. English, contemporary R&B and soul.',
  },
  suno: {
    key: 'yue2-loras/suno-step600.pt',
    scale: 1,
    lead: 'kdsuno, in the style of kdsuno. English,',
  },
  sona: {
    key: 'yue2-loras/sona-step800.pt',
    scale: 1,
    lead: 'kdsona, in the style of kdsona. English,',
  },
};
/** The lead the first Sona (September, soul-sona1800.pt, retired) put in front of a saved song's music direction. Not a style any
 * more; kept only so an older saved song still opens without its trigger word. It begins with the current Sona lead. */
const retiredSonaLead = 'kdsona, in the style of kdsona. English, female lead vocal.';
/** Older saved songs stored the worker's training trigger in the editable music direction. */
export function yueMusicDirection(style: string): string {
  /* Longest lead first, so the retired Sona lead is taken whole. Were the current Sona lead tried first (it is the front of
   * the retired one), an older Sona song would open with "female lead vocal." left in front of its words as if they were
   * written there, and two retired leads in a row would stop after the first. */
  const leads = [retiredSonaLead, ...Object.values(yueStyles).map((row) => row.lead)].sort(
    (a, b) => b.length - a.length,
  );
  let direction = style.trim();
  let prefix = leads.find((lead) => direction === lead || direction.startsWith(`${lead} `));
  while (prefix) {
    direction = direction.slice(prefix.length).trimStart();
    prefix = leads.find((lead) => direction === lead || direction.startsWith(`${lead} `));
  }
  return direction;
}
/**
 * The Music direction as a trained style's caption continues it. "Describe the sound of the recording" writes a line in the
 * shape "English, <genre>, <pace>, <voice>, <sound words>", but every trained lead already says English and the Soul and Kids
 * leads already name their genre, so the line would repeat the language ("English, English, folk") or argue with the style's
 * own genre. The language is dropped, and the genre too when the lead names one; a lead that stops at "English," (Suno) leaves
 * the genre to the direction, as its training captions did, so only the language goes. A recording in two languages gives the
 * describer "English and Spanish" or "Spanish and English"; English is in the lead already, so that whole language part goes
 * the same way. A single other language ("Spanish, bolero, ...") is kept: the lead cannot speak for that recording. Only a
 * line of exactly that shape is touched: anything she wrote herself is sent as it is.
 */
export function yueStyleDirection(direction: string, lead: string): string {
  const described = /^(?:English(?: and [a-z]+)?|[a-z]+ and English),\s*([^,]+),\s*((?:slow tempo|mid-tempo|up-tempo)\b[\s\S]*)$/i.exec(direction);
  if (!described) return direction;
  return /English,$/.test(lead) ? `${described[1]}, ${described[2]}` : described[2];
}
export function yueStylesEnabled(): boolean {
  return process.env.YUE_STYLES_ENABLED === '1';
}

/** The Style choice's hint in the booth guide (the `band` setting). Kids and Soul were taught from
 * real recordings, Suno from songs made with Suno and Sona from songs made with Sonauto, so the
 * opening says only "recordings"; it names no person and no folder. The first sentence gives each
 * style one clause. The voice sentence names the styles whose training captions named a singer
 * song by song, Soul and Suno, and says to write it. Sona is not in it: every song Sona was
 * taught from has a female lead, so its clause says so and there is no singer to choose. */
export const yueStyleHint: string =
  'A singing style taught to YuE2 from recordings: Soul from soul and R&B records, Suno from songs made with Suno, Sona from female-led pop songs made with Sonauto, Kids from a children’s choir. For Soul or Suno, write female lead vocal or male lead vocal in Music direction. None is plain YuE2. Works for new songs and covers.';
/** Added to the Style hint for an account outside the Family feature pack, so a client that
 * does not read `locked` yet still says why the choice does nothing there. */
export const yueStyleLockedSentence: string =
  ' Part of the Family feature pack, so songs on this account use None, plain YuE2.';

/**
 * The Style choice for one person. With the Family feature pack (`allowed`) the settings come
 * back unchanged. Without it the `band` setting stays, with every option, and gains `locked`
 * (the pack's note, "Part of the Family feature pack") plus a sentence on its hint: clients show
 * it greyed out, never hidden (Apple's 2.3.1). The booth route refuses a style from such an
 * account on its own (kadeSoundBooth.js), so an older client that shows the choice live gets a
 * plain answer instead of a song.
 */
export function yueStyleAccess<T extends { key: string; hint: string }>(
  settings: T[],
  allowed: boolean,
  note: string,
): Array<T | (T & { locked: string })> {
  if (allowed || !settings.some((setting) => setting.key === 'band')) return settings;
  return settings.map((setting) =>
    setting.key === 'band' || setting.key === 'style_strength'
      ? { ...setting, hint: `${setting.hint}${yueStyleLockedSentence}`, locked: note }
      : setting,
  );
}

/* Part 295: the official cover recipe (chords kept) and instrumentals, behind YUE_COVERS_V2=1.
 * With the flag unset every request, guide and answer is exactly as before. The live worker
 * must run the Part 295 image before the flag goes on: an older worker would ignore
 * `instrumental` and sing wordless takes. The two choices below are real guide settings, so the
 * web page and the iPhone render them without an update; their option values are the words
 * each client reads out. A client that sends nothing gets the server defaults.
 * Part 296 (Sep 27 2026, her ask to streamline the booth): Keep the original chords is also the
 * chords choice for an ABC score, so the old "Following a score" setting (`cot`) leaves the guide
 * while the flag is on. A request that still sends `cot` with a score (an older client) is read
 * exactly as before; otherwise Yes is cot full and No is cot melody, for a score as for a
 * recording, and a score now starts on the same default as a recording. */
export function yueCoversEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.YUE_COVERS_V2 === '1';
}
/** YUE_COVER_KEEP_CHORDS_DEFAULT: 1 (the default) keeps a recording's chords, 0 drops them. */
export function yueKeepChordsDefault(env: NodeJS.ProcessEnv = process.env): boolean {
  const said = String(env.YUE_COVER_KEEP_CHORDS_DEFAULT ?? '1').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(said);
}
/* Lyric sync (the Part 295 follow-up; worker features lyric-sync and fit-score), behind
 * YUE_FIT_LYRICS=1 and YUE_MEASURE_FIT=1. YuE2 lines lyrics up with a cover's score by itself,
 * with every line end and comma on a phrase end of the tune, so lines that break inside the
 * tune's phrases let held notes slip onto the next word. YUE_FIT_LYRICS asks the worker to
 * re-break the lines to the recording's phrases from measured word timing (her words and their
 * order never change); YUE_MEASURE_FIT asks it to score each take by which words landed on the
 * long notes (about a tenth more GPU time per take). With both unset every request is exactly
 * as before. The live worker must run an image that lists these features first: an older
 * worker ignores both fields. */
export function yueFitLyricsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.YUE_FIT_LYRICS === '1';
}
export function yueMeasureFitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.YUE_MEASURE_FIT === '1';
}
/** YUE_SCORE_TOUCHUP=1, A/B only and only with YUE_FIT_LYRICS: the worker may fold a quick note
 * sliding into a held note into it, so the held word keeps that note. The melody changes a
 * little there, so it stays off until Kade has heard it. */
export function yueScoreTouchupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.YUE_SCORE_TOUCHUP === '1';
}
/** YUE_FIT_TEMPO=1 (worker feature fit-tempo): a cover of a recording asks the worker to sing a
 * song too long for YuE2's six minutes a little faster to fit instead of cutting it: its score's
 * tempo line only, so the same notes in the same key, never more than 20% faster. music/lyrics.ts
 * reads the same flag for a YuE2 cover's longer import limit (musicReferenceMaxSeconds, 6:40).
 * With it unset every request is exactly as before; an older worker would refuse a recording over
 * six minutes. */
export function yueFitTempoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.YUE_FIT_TEMPO === '1';
}
const TAG_LINE = /^\s*\[[^\]\n]+\]\s*$/;
/** Whether lyrics hold any word to sing outside [section] tag lines. */
function hasSungWords(lyrics: string): boolean {
  return lyrics.split(/\r?\n/).some((line) => !TAG_LINE.test(line) && /\p{L}/u.test(line));
}
/** The lyric sync fields for one request: only a sung cover of a recording, with words to sing. */
function syncFields(
  lyrics: string,
  recording: boolean,
  instrumental: boolean,
  env: NodeJS.ProcessEnv,
): Pick<Input, 'fit_lyrics' | 'measure_fit' | 'fit_score_touchup'> {
  const fields: Pick<Input, 'fit_lyrics' | 'measure_fit' | 'fit_score_touchup'> = {};
  if (!recording || instrumental || !hasSungWords(lyrics)) return fields;
  if (yueFitLyricsEnabled(env)) fields.fit_lyrics = 'timing';
  if (yueMeasureFitEnabled(env)) fields.measure_fit = true;
  if (fields.fit_lyrics && yueScoreTouchupEnabled(env)) fields.fit_score_touchup = true;
  return fields;
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
  const direction = yueMusicDirection(body.script);
  if (direction.length < 3) throw new Error('Describe the music in 3 to 3000 characters.');
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
  const strength = number(body.style_strength, 1, 0, 1, 'Style strength', false);
  const trained = band && strength > 0 ? yueStyles[band] : undefined;
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
  /* A score reads an older client's `cot` first, so what it sends renders as it always did. */
  const keepChords = !covers
    ? undefined
    : recording
      ? yueKeepChordsChoice(body.keep_chords, env)
      : body.abc
        ? body.cot != null
          ? body.cot === 'full'
          : yueKeepChordsChoice(body.keep_chords, env)
        : undefined;
  /* Sing it in my voice (music/myVoice.ts): "On" asks for a version of every take in the owner's voice. Only set when chosen,
   * so every other request is exactly as before; the booth's owner check clears it for an account with no voice model, and
   * it never reaches the music worker (createYueRouter's submit leaves it out).
   * Sep 29 2026: an instrumental has no singer to sing again, so it is cleared there too; it used to queue a paid voice
   * version of every instrumental take. */
  const myVoice =
    !instrumental &&
    (body.my_voice === true || String(body.my_voice ?? '').trim().toLowerCase() === 'on');
  return {
    style: trained ? `${trained.lead} ${yueStyleDirection(direction, trained.lead)}`.slice(0, 3000) : direction,
    title: body.title?.trim() || direction.split(/\s+/).slice(0, 7).join(' ').slice(0, 80),
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
    ...(body.style_strength != null ? { style_strength: strength } : {}),
    lora_key: trained?.key,
    lora_scale: trained ? trained.scale * strength : undefined,
    seed: body.seed ?? Math.floor(Math.random() * 2147483647),
    ...(covers ? coverFields(body, instrumental, keepChords, recording) : {}),
    ...syncFields((body.lyrics || '').trim(), recording, instrumental, env),
    ...(recording && yueFitTempoEnabled(env) ? { fit_tempo: true } : {}),
    ...(myVoice ? { my_voice: true } : {}),
  };
}

/** The Part 295 worker fields for one request; none for a sung new song or a sung score. */
function coverFields(
  body: InputBody,
  instrumental: boolean,
  keepChords: boolean | undefined,
  recording: boolean,
): Pick<Input, 'instrumental' | 'keep_harmony' | 'match_score_tempo' | 'length_guard'> {
  const fields: Pick<Input, 'instrumental' | 'keep_harmony' | 'match_score_tempo' | 'length_guard'> = {};
  const score = !!body.abc && instrumental;
  const keep = recording || score ? keepChords : undefined;
  if (instrumental) fields.instrumental = true;
  if (keep !== undefined) fields.keep_harmony = keep;
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

/** A saved project's options as the booth opens them. A score's chords choice is saved as its
 * `cot` (full or melody), so while the flag is on a score project opens with the same answer
 * under Keep the original chords, including one saved before Part 296. */
export function yueSavedOptions<T extends { abc?: unknown; cot?: unknown; keep_chords?: unknown; reference_voice_url?: unknown }>(
  options: T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  if (
    !yueCoversEnabled(env) ||
    !options ||
    typeof options.abc !== 'string' ||
    !options.abc ||
    options.reference_voice_url ||
    typeof options.keep_chords === 'string' ||
    (options.cot !== 'full' && options.cot !== 'melody')
  )
    return options;
  return { ...options, keep_chords: options.cot === 'full' ? yueKeepChords.yes : yueKeepChords.no };
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

type FitRow = { lyrics_section?: string | null; score_section?: string | null };
/** 'The second verse words': a lyric_fit row's section, with an ordinal when that name repeats among the rows. Since Nov 10
 * 2026 the tags reach YuE2 without their numbers, so "[Verse 1]" and "[Verse 2]" both come back named "verse"; without the
 * ordinal two notes would say "the verse words" and she could not tell which verse to mend. */
function fitRowWords(all: FitRow[], row: FitRow): string {
  if (!row.lyrics_section) return sectionWords(row.score_section);
  const name = sectionName(row.lyrics_section);
  const same = all.filter((other) => other.lyrics_section && sectionName(other.lyrics_section) === name);
  const nth = same.indexOf(row);
  return same.length > 1 && nth >= 0 && nth < ORDINALS.length
    ? `The ${ORDINALS[nth]} ${name} words`
    : sectionWords(row.lyrics_section);
}
function sectionWords(name: string | null | undefined): string {
  const said = String(name || '')
    .replace(/[[\]]/g, '')
    .trim()
    .toLowerCase();
  return said ? `The ${said} words` : 'Some words';
}

/** Why the worker kept her line breaks, by its lyric_sync reason key. */
export const yueSyncReasons: Record<string, string> = {
  score: "the score's phrases could not be read",
  notes: "the recording's note timing could not be read",
  heard: 'too few of your words could be heard clearly in the recording',
  words: 'your words did not line up with the tune',
  empty: 'there are no words to sing',
  align: 'your words could not be timed against the recording this time',
  error: 'your words could not be fitted to the tune this time',
};

function sectionName(name: string | null | undefined): string {
  return (
    String(name || '')
      .replace(/[[\]]/g, '')
      .trim()
      .toLowerCase() || 'untitled'
  );
}
function joinAnd(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
type SyncSection = NonNullable<NonNullable<Output['lyric_sync']>['sections']>[number];
/** 'the bridge', 'the second verse': one of her sections, with an ordinal when its name repeats. */
function sectionCalled(all: SyncSection[], section: SyncSection): string {
  const name = sectionName(section.section);
  const same = all.filter((s) => sectionName(s.section) === name);
  const nth = same.indexOf(section);
  return same.length > 1 && nth >= 0 && nth < ORDINALS.length ? `the ${ORDINALS[nth]} ${name}` : `the ${name}`;
}

/** The lyric sync part of a take note: what moved, what was left out or kept as written, and
 * how many long notes kept their words. The fit score is saved on the take, never spoken. */
function syncNotes(sync: NonNullable<Output['lyric_sync']>, input: Input): string[] {
  const notes: string[] = [];
  if (sync.lyrics_fitted) {
    const gone = (sync.words_without_tune || []).filter((g) => typeof g.lines === 'number' && g.lines > 0);
    const lines = gone.reduce((sum, g) => sum + (g.lines || 0), 0);
    const said = gone.map((g) => `${g.lines} ${sectionName(g.section)} line${g.lines === 1 ? '' : 's'}`);
    const left = said.length
      ? `; ${joinAnd(said)} ${lines === 1 ? 'was' : 'were'} left out, because the recording has no sung tune there`
      : '';
    notes.push(`Your lines were re-broken to follow the tune's phrases: your words keep their order${left}.`);
    const all = sync.sections || [];
    const kept = all.filter((s) => s.fitted === false);
    if (kept.length) {
      const who = joinAnd(kept.map((s) => sectionCalled(all, s)));
      notes.push(
        `${who.charAt(0).toUpperCase()}${who.slice(1)} ${kept.length === 1 ? 'keeps' : 'keep'} your own line breaks: too few of ${kept.length === 1 ? 'its' : 'their'} words could be heard clearly in the recording.`,
      );
    }
    const touch = sync.score_touchup;
    if (touch && touch.applied) {
      const places = Array.isArray(touch.places) ? touch.places.length : 0;
      notes.push(
        places > 0
          ? `The score was touched up in ${places} place${places === 1 ? '' : 's'} so each held word keeps its long note; the rest of the melody is unchanged.`
          : 'The score was touched up so each held word keeps its long note; the rest of the melody is unchanged.',
      );
    }
  } else if (input.fit_lyrics === 'timing' && sync.reason && yueSyncReasons[sync.reason])
    notes.push(`Your line breaks were kept as written: ${yueSyncReasons[sync.reason]}.`);
  const held = sync.held_words_on_note;
  if (held && typeof held.hits === 'number' && typeof held.of === 'number' && held.of > 0)
    notes.push(`${held.hits} of ${held.of} long notes kept their words.`);
  return notes;
}

/** How much faster a cover was sung to fit YuE2's six minutes (worker feature fit-tempo), as a
 * whole percentage; undefined when it was not sped up or the report is not one to trust. */
function tempoPercent(output: Output, input: Input): number | undefined {
  const fit = output.tempo_fit;
  if (input.fit_tempo !== true || !output.features?.includes('fit-tempo') || !fit || fit.applied !== true)
    return undefined;
  const percent = fit.percent;
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 1 || percent > 20)
    return undefined;
  return Math.round(percent);
}
/** Each BPM Music direction named, sped up by the same amount as the song, said once. */
function bpmNotes(fit: Output['tempo_fit']): string[] {
  const notes: string[] = [];
  const said = new Set<string>();
  for (const pair of Array.isArray(fit?.style_bpm) ? fit.style_bpm : []) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [was, now] = pair;
    if (typeof was !== 'number' || typeof now !== 'number' || !Number.isFinite(was) || !Number.isFinite(now))
      continue;
    if (said.has(`${was}>${now}`)) continue;
    said.add(`${was}>${now}`);
    notes.push(`Music direction's ${was} BPM was sung as ${now} BPM to match.`);
  }
  return notes;
}
/** Where a take that ran out of room stops: "six minutes" at YuE2's cap, "3 minutes 40 seconds"
 * when the length guard stopped a cover sooner, '' when the worker did not say. */
function stoppedAt(output: Output): string {
  const seconds = output.duration_s;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds >= 359) return 'six minutes';
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const minutes = m ? `${m} minute${m === 1 ? '' : 's'}` : '';
  const rest = s ? `${s} second${s === 1 ? '' : 's'}` : '';
  return [minutes, rest].filter(Boolean).join(' ');
}
/**
 * The length part of a take note. A cover sped up to fit YuE2's six minutes says so, with any BPM
 * Music direction named. A take the worker reports `truncated` says so for EVERY YuE2 take, sped
 * up or not and from any worker, which has always reported it, and a sped take that was still cut
 * never says "to fit". The worker reports YuE2's two limits apart (`truncation_flags`, from every
 * worker since Sep 17): the song itself (semantic) reaching its length limit stops the take dead,
 * but when only the score YuE2 wrote for a new song (abc) ran out of room, the song ended by
 * itself and may only end early, so that one is said as a "may". A cut without the flags is taken
 * as the song's. '' parts for anything else.
 */
function lengthNotes(output: Output, input: Input): string[] {
  const percent = tempoPercent(output, input);
  const cut = output.truncated === true;
  const flags = output.truncation_flags;
  const scoreOnly = cut && !!flags && flags.abc === true && flags.semantic === false;
  const stopped = cut && !scoreOnly;
  const at = stoppedAt(output);
  const notes: string[] = [];
  if (percent !== undefined) {
    notes.push(
      stopped
        ? `Sped up ${percent}%, but YuE2 still ran longer than the song, so this take stops at ${at || 'six minutes'}.`
        : cut
          ? `Sped up ${percent}%, in the same key.`
          : `Sped up ${percent}% to fit YuE2's six-minute limit, in the same key.`,
    );
    notes.push(...bpmNotes(output.tempo_fit));
  } else if (stopped)
    notes.push(
      `YuE2 had not finished when it reached its length limit, so this take stops abruptly${at ? ` at ${at}` : ''}.`,
    );
  if (scoreOnly) notes.push("YuE2 ran out of room writing this song's score, so this take may end early.");
  if (cut) notes.push('Try another take.');
  return notes;
}

const METER_SAID = /^(?:\d{1,2}\/\d{1,2}|waltz)$/;
/** A style that names a meter the score contradicts (worker feature meter-check). */
function meterNote(output: Output): string {
  const check = output.meter_check;
  if (!check || typeof check.style_meter !== 'string' || typeof check.score_meter !== 'string') return '';
  if (!METER_SAID.test(check.style_meter) || !/^\d{1,2}\/\d{1,2}$/.test(check.score_meter)) return '';
  const asked = check.style_meter === 'waltz' ? 'a waltz' : `a ${check.style_meter} feel`;
  return `Your style asks for ${asked}, but the song's score is in ${check.score_meter}, so the phrasing may sit off the beat. Leave the meter out of the style, or describe a ${check.score_meter} feel.`;
}

/** Whether this request asked for lyric sync (YUE_FIT_LYRICS or YUE_MEASURE_FIT, both off): only
 * then are the worker's lyric sync report and its round-2 notes (the meter note, the tuneless
 * intro) said or kept, so with those flags off every note is as before whatever the worker sends. */
function syncAsked(input: Input): boolean {
  return input.fit_lyrics === 'timing' || input.measure_fit === true;
}

/** A short spoken note about one finished take, from what the worker reported. A take that stopped
 * at its length limit is said for any worker; everything else reads `features` first, so a worker
 * older than Part 295 gets no other note. */
export function yueTakeNote(output: Output | undefined, input: Input): string {
  if (!output) return '';
  const notes: string[] = lengthNotes(output, input);
  if (!Array.isArray(output.features)) return notes.join(' ');
  const sync = syncAsked(input);
  if (
    input.keep_harmony === true &&
    input.reference_voice_url &&
    output.features.includes('chord-check') &&
    output.cover_mode === 'melody'
  )
    notes.push(
      'No chords were heard in the recording, so the cover used its melody with a new accompaniment.',
    );
  if (sync && !output.instrumental && output.features.includes('lyric-sync') && output.lyric_sync)
    /* The timing report replaces the rough per-section syllable rows, which pair sections by
     * position and misread a recording whose intro has words but no sung tune. */
    notes.push(...syncNotes(output.lyric_sync, input));
  else if (!output.instrumental && output.features.includes('lyric-fit') && output.lyric_fit) {
    const rows = (output.lyric_fit.sections || []).filter(
      (row) =>
        (row.fit === 'short' || row.fit === 'long') &&
        typeof row.syllables === 'number' &&
        typeof row.sung_notes === 'number',
    );
    for (const row of rows.slice(0, 2))
      notes.push(
        `${fitRowWords(output.lyric_fit.sections || [], row)} look ${row.fit} for its tune: ${row.syllables} syllables for ${row.sung_notes} notes.`,
      );
    if (rows.length > 2)
      notes.push(`Words in ${rows.length - 2} more section${rows.length === 3 ? '' : 's'} may not fit their tune either.`);
    /* Worker feature lyric-fit-v2 pairs sections by name, so a "no tune" row is real: words
     * under [Intro] where the recording's intro has no sung tune. Older rows are skipped. */
    if (sync && output.features.includes('lyric-fit-v2')) {
      const tuneless = (output.lyric_fit.sections || []).filter(
        (row) => row.fit === 'no tune' && row.lyrics_section,
      );
      for (const row of tuneless.slice(0, 1))
        notes.push(
          `${fitRowWords(output.lyric_fit.sections || [], row)} have no sung tune in the recording, so YuE2 may skip them or sing them somewhere else.`,
        );
    }
  }
  if (sync && output.features.includes('meter-check')) {
    const meter = meterNote(output);
    if (meter) notes.push(meter);
  }
  if (input.my_voice === true)
    notes.push('A version in your voice follows a few minutes after each take, beside it in this project.');
  return notes.join(' ');
}

export type YueTakeFacts = {
  instrumental?: boolean;
  coverMode?: string;
  gpu?: string;
  takeNote?: string;
  /** Lyric sync: the lines YuE2 actually sang, when the worker re-broke them. */
  lyricsUsed?: string;
  fitScore?: number;
  /** Fit by tempo: how much faster the take was sung than the recording's own tempo. */
  tempoFit?: { percent: number; fromBpm?: number; toBpm?: number };
};
/** What the asset keeps about a finished take; for a worker older than Part 295 only the note of a
 * take that stopped at its length limit. */
export function yueTakeFacts(output: Output | undefined, input: Input): YueTakeFacts {
  if (!output) return {};
  if (!Array.isArray(output.features)) {
    const note = yueTakeNote(output, input);
    return note ? { takeNote: note } : {};
  }
  const facts: YueTakeFacts = {};
  if (typeof output.instrumental === 'boolean') facts.instrumental = output.instrumental;
  if (typeof output.cover_mode === 'string') facts.coverMode = output.cover_mode;
  if (typeof output.gpu === 'string') facts.gpu = output.gpu;
  const note = yueTakeNote(output, input);
  if (note) facts.takeNote = note;
  if (syncAsked(input) && output.features.includes('lyric-sync') && output.lyric_sync) {
    if (output.lyric_sync.lyrics_fitted && typeof output.lyrics_used === 'string')
      facts.lyricsUsed = output.lyrics_used;
    if (typeof output.lyric_sync.fit_score === 'number') facts.fitScore = output.lyric_sync.fit_score;
  }
  const fit = output.tempo_fit;
  const percent = tempoPercent(output, input);
  if (percent !== undefined && fit) {
    facts.tempoFit = { percent };
    if (typeof fit.from_bpm === 'number') facts.tempoFit.fromBpm = fit.from_bpm;
    if (typeof fit.to_bpm === 'number') facts.tempoFit.toBpm = fit.to_bpm;
  }
  return facts;
}

export type YueGuideSetting = {
  key: string;
  label: string;
  hint: string;
  kind: string;
  options?: string[];
  default?: string | number | boolean;
  /** Shown inside the one collapsed "More settings" group (Part 296). */
  advanced?: boolean;
};

/** The YuE2 guide settings with the two Part 295 choices; unchanged while the flag is off. Keep
 * the original chords also covers an ABC score, so the score's own `cot` choice is left out. */
export function yueCoverSettings<T extends { key: string; hint: string }>(
  settings: T[],
  env: NodeJS.ProcessEnv = process.env,
): Array<T | YueGuideSetting> {
  if (!yueCoversEnabled(env)) return settings;
  const styles =
    env.YUE_STYLES_ENABLED === '1' ? ' Choose None under Style for an instrumental.' : '';
  const singing: YueGuideSetting = {
    key: 'singing',
    label: 'Singing or instrumental',
    hint: `Instrumental plays the tune on instruments, for a new song or a cover. Lyrics are optional then; tags like [Verse] and [Chorus] only guide the shape. It may still hum or sing a little, so listen to check.${styles}`,
    kind: 'choice',
    options: [yueSinging.sung, yueSinging.instrumental],
    default: yueSinging.sung,
  };
  const chords: YueGuideSetting = {
    key: 'keep_chords',
    label: 'Keep the original chords',
    hint: 'For a cover or an ABC score; it does nothing for a brand-new song. Yes keeps the chords as well as the melody, and a cover keeps its tempo unless Music direction names a BPM. No keeps only the melody.',
    kind: 'choice',
    options: [yueKeepChords.yes, yueKeepChords.no],
    default: yueKeepChordsDefault(env) ? yueKeepChords.yes : yueKeepChords.no,
  };
  return settings.flatMap((setting): Array<T | YueGuideSetting> => {
    if (setting.key === 'weirdness' && yueSamplingMap(env) === 'v2') return [{ ...setting, hint: yueVariationHint }];
    if (setting.key === 'guidance' && env.YUE_STYLES_ENABLED === '1')
      return [{ ...setting, hint: `${setting.hint}${yueGuidanceStyleSentence}` }];
    if (setting.key === 'lyrics') return [singing, setting];
    if (setting.key === 'reference_voice_url') return [setting, chords];
    if (setting.key === 'cot') return [];
    return [setting];
  });
}

/* ---- Nov 10 2026: clearer words with trained styles, covers that hold their tune, a dial that varies the right thing ----
 * Read from her last 160 YuE2 songs and from YuE2's own code, with nothing rendered:
 *  - 100 of the 160 were a trained style on a cover. The styles were taught score-free, and no listening test ever put one on
 *    a score.
 *  - YuE2's sound stage reads the singing tokens through the composer's attention. A trained style is folded into the composer
 *    for the whole take, so the sound stage was reading through weights it was never trained against.
 *  - Creative variation above 50 raised the temperature of the SINGING tokens (1.12 at 70, 1.3 at 100; YuE2's default is 1.0).
 *    A styled new song has no score and a cover's score is fixed, so for those two the dial did nothing else: it only slurred.
 *  - Her sheets say [Verse 1], [Final Chorus], [Post-Chorus], [Prechorus]. YuE2's own examples know [Verse] and [Chorus]; every
 *    trained style was taught on sheets that say [verse], [prechorus], [chorus] and nothing else.
 * Each fix below is made when the request is SENT (yueWorkerInput), so what the job, the project and the library keep is still
 * exactly what she typed and chose, and each has its own switch back:
 *   YUE_PREFORMAT=0             section tags and a doubled "English" go to YuE2 as typed
 *   YUE_SAMPLING_V2=0           Creative variation drives the singing temperature as before
 *   YUE_COVER_TEMPO_ALWAYS=0    a cover with a new accompaniment does not name its score's tempo in the style
 * And four that do nothing until they are set, because only her ear can choose:
 *   YUE_STYLE_SOUND_STAGE=plain a trained style writes the singing tokens, then the plain weights go back before the sound
 *                               stage reads them. Review, Nov 10: OFF until it has been heard, because it has never run on a
 *                               GPU and that this is what garbles words is a reading of the code, not a heard result. It also
 *                               folds the style in again on every styled take (a few GPU seconds). The worker can also save
 *                               both masters of one take (lora_sound_stage "both"), but the booth has nowhere to show the
 *                               second one, so that is asked for straight from the endpoint in a listening test, never here.
 *   YUE_STYLE_GUIDANCE=1.3      Prompt guidance for a styled new song she left on 1 (costs no extra GPU time: a score-free
 *                               take already runs YuE2's guidance pass)
 *   YUE_STYLE_COVER_GUIDANCE=1.2  the same for a styled cover or score (about a third more composing time per take)
 *   YUE_STYLE_MODULES=mlp, YUE_STYLE_LAYERS=8-27 (and YUE_STYLE_COVER_MODULES / _LAYERS for covers only): fold the style into
 *                               part of the composer only
 * A worker older than these fields ignores every one of them and renders as it always did. */
function switchedOff(value: string | undefined): boolean {
  return ['0', 'false', 'no', 'off'].includes(String(value ?? '').trim().toLowerCase());
}
export function yuePreformatEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !switchedOff(env.YUE_PREFORMAT);
}
export function yueSamplingMap(env: NodeJS.ProcessEnv = process.env): 'v1' | 'v2' {
  return switchedOff(env.YUE_SAMPLING_V2) ? 'v1' : 'v2';
}
export function yueStyleSoundStage(env: NodeJS.ProcessEnv = process.env): 'styled' | 'plain' {
  return String(env.YUE_STYLE_SOUND_STAGE ?? '').trim().toLowerCase() === 'plain' ? 'plain' : 'styled';
}
export function yueCoverTempoAlways(env: NodeJS.ProcessEnv = process.env): boolean {
  return !switchedOff(env.YUE_COVER_TEMPO_ALWAYS);
}
/** A guidance number from the environment: 1 to 3, as the dial allows; anything else is "not set". */
function guidanceFrom(value: string | undefined): number | undefined {
  const said = String(value ?? '').trim();
  if (!/^\d(?:\.\d{1,2})?$/.test(said)) return undefined;
  const number = Number(said);
  return number > 1 && number <= 3 ? number : undefined;
}
/** Part of the composer for a trained style: modules "attn" or "mlp", layers "first-last" counted from 0. */
function scopeFrom(
  modules: string | undefined,
  layers: string | undefined,
): { lora_modules?: 'attn' | 'mlp'; lora_layers?: [number, number] } {
  const scope: { lora_modules?: 'attn' | 'mlp'; lora_layers?: [number, number] } = {};
  const part = String(modules ?? '').trim().toLowerCase();
  if (part === 'attn' || part === 'mlp') scope.lora_modules = part;
  const range = /^(\d{1,3})\s*-\s*(\d{1,3})$/.exec(String(layers ?? '').trim());
  if (range && Number(range[1]) <= Number(range[2]) && Number(range[2]) <= 255)
    scope.lora_layers = [Number(range[1]), Number(range[2])];
  return scope;
}

/* The section names YuE2 sheets use, and the other spellings that mean one of them. A tag that is none of these (a
 * direction such as [spoken] or [drums drop out]) is never touched, and neither is a tag that says more than a section name
 * and its number ("[Final Chorus - belting]", "[Verse 2: spoken]", "[Chorus x2]"): renaming it would drop her direction.
 * [Instrumental] is one of upstream's own section names (compile_score.py), so plain YuE2 gets it as typed; the trained styles'
 * sheets had seven tags and no instrumental, so a styled song gets [interlude]. */
const NATIVE_SECTIONS: Record<string, string> = {
  intro: 'intro', introduction: 'intro',
  verse: 'verse',
  prechorus: 'prechorus',
  chorus: 'chorus', hook: 'chorus', refrain: 'chorus', postchorus: 'chorus', finalchorus: 'chorus', lastchorus: 'chorus',
  bridge: 'bridge', middle8: 'bridge', middleeight: 'bridge',
  outro: 'outro', ending: 'outro', coda: 'outro',
  interlude: 'interlude', instrumental: 'instrumental', instrumentalbreak: 'interlude', solo: 'interlude', break: 'interlude',
};
const SECTION_TITLES: Record<string, string> = {
  intro: 'Intro', verse: 'Verse', prechorus: 'Pre-Chorus', chorus: 'Chorus', bridge: 'Bridge', outro: 'Outro',
  interlude: 'Interlude',
};
const SECTION_LINE = /^(\s*)\[([^\]\n]{1,60})\](\s*)$/;
/** The YuE2 section a tag names ("Verse 2", "Final Chorus", "Guitar Solo"), or undefined for anything else, including a
 * section name followed by a direction or a repeat. */
function nativeSection(tag: string): string | undefined {
  const head = tag
    .toLowerCase()
    .replace(/[\s_]+/g, ' ')
    .trim();
  /* "Middle 8" is a name with its number; "Verse 2" is a name and a count. */
  for (const name of [head, head.replace(/\s*\d+$/, '').trim()]) {
    const key = name.replace(/[-\s]/g, '');
    if (Object.prototype.hasOwnProperty.call(NATIVE_SECTIONS, key)) return NATIVE_SECTIONS[key];
    if (/^[a-z ]{1,24} solo$/.test(name)) return 'interlude';
  }
  return undefined;
}
/**
 * The lyric sheet with its section tags in the spelling YuE2 was taught: "[Verse 2]" is "[Verse]", "[Final Chorus]" and
 * "[Post-Chorus]" are "[Chorus]", "[Prechorus]" is "[Pre-Chorus]". For a trained style the tags are the lower-case ones every
 * style's training sheets used ("[verse]", "[prechorus]", "[chorus]"). Only a line that is a section name (with or without
 * its number) and nothing else changes; every sung word, every blank line and every other bracket, a section tag with a
 * direction in it included, stays exactly as written.
 */
export function yueNativeLyrics(lyrics: string, trained = false): string {
  return lyrics
    .split('\n')
    .map((line) => {
      const tag = SECTION_LINE.exec(line.replace(/\r$/, ''));
      const section = tag && nativeSection(tag[2]);
      if (!tag || !section || (section === 'instrumental' && !trained)) return line;
      const taught = section === 'instrumental' ? 'interlude' : section;
      return `${tag[1]}[${trained ? taught : SECTION_TITLES[section]}]${tag[3]}${line.endsWith('\r') ? '\r' : ''}`;
    })
    .join('\n');
}
/** A style whose lead already ends "English," followed by a direction that opens with the language again ("English slow jam",
 * "American-English, contemporary R&B") says it once. Anything else is returned as it is. */
export function yueTidyStyle(style: string, band?: string): string {
  const lead = band && Object.prototype.hasOwnProperty.call(yueStyles, band) ? yueStyles[band].lead : '';
  if (!lead || !/English,$/.test(lead) || !style.startsWith(`${lead} `)) return style;
  const rest = style.slice(lead.length + 1);
  const again = /^(?:American[- ])?English(?:,\s*|\s+)(?=\S)/i.exec(rest);
  return again ? `${lead} ${rest.slice(again[0].length)}` : style;
}

/** Creative variation's hint while the v2 sampling map is on (YUE_SAMPLING_V2): what the dial now changes, and where it
 * has nothing to change. */
export const yueVariationHint: string =
  '50 is normal. Lower is more predictable. Higher makes a new song’s melody and chords bolder, while the singing stays clear. Above 50 a cover keeps its tune as it is, and a trained Style changes only a little.';
/** Added to Prompt guidance's hint while trained styles are on. Nov 10 2026: ONE pair of takes of the same styled new song
 * kept 88 of its 94 words at guidance 1 and 42 at 1.3, where it fell into repeating single words until the six-minute limit.
 * The two takes ran on different GPU models, so the same seed did not mean the same sampling: this suggests guidance was
 * the cause, it does not prove it. Hence a cautious hint and no change to what is sent. */
export const yueGuidanceStyleSentence: string =
  ' With a trained Style on a new song, leave it at 1: higher can make the song lose its words.';

/* ---- Nov 10 2026, round two: a cleaner sheet for a trained style, a guard against a runaway take, a cover that names its key ----
 * Her words: with style LoRAs the words get garbled. Round one fixed what the request asked the model to do; this looks at
 * what the SHEET hands it. YuE2 puts the lyrics into its prompt as plain text, word for word (protocol.py: "[Tags]\n{style}\n
 * [Lyrics]\n{lyrics}"), with no parsing of brackets or parentheses, so what it does with them is whatever its training sheets
 * taught. Every trained style was taught on sheets with seven lower-case section tags, no other bracket and no parenthesis
 * at all. Her sheets carry bracketed directions ("[drums drop out, atmospheric pads]", "[belting]", "[spoken]") and up to 25
 * parenthesised backing phrases, which YuE2 has no backing voice for and sings as extra lead words.
 *
 * What four test songs said (Nov 10 2026: Soul at full strength, one 21-line sheet with six directions and 13 backing
 * phrases, one seed, all four on the same GPU model, the plain sound stage; a small speech model counted the 122 lead words):
 *   as the booth sends it today, directions and all 13 phrases left in      115 to 117 heard, 3:19, NO direction was sung
 *   directions lifted and added to the style, all 13 phrases                 24 heard, ran the full six minutes: unusable
 *   lifted and added to the style, phrases thinned to 8                      111 heard, 3:49
 *   the same with a long layered direction of the kind the desk now writes   108 heard, 2:43
 * So a bracketed direction left in the sheet is not sung, taking it out gained nothing, and one of the three takes that
 * carried the directions in the style fell apart. Thinning did not make the lead clearer on this sheet either, and backing
 * phrases are layers she asked for more of. One take each is thin evidence, so both are BUILT AND OFF, ready for her ear on
 * one of her own long sheets, and nothing about the sheet changes by default.
 * All of it happens in yueWorkerInput, when the request is SENT. The job, the project and the library keep her sheet and her
 * Music direction exactly as typed. The switches:
 *   YUE_LIFT_DIRECTIONS=styled   off unless set: bracketed directions are lifted out of the lyrics for a trained style.
 *                                "all": for plain YuE2 too (its own guide says a tag such as [saxophone solo] can help there).
 *   YUE_LIFT_FOLD=1              off unless set, and only with lifting: the lifted directions are added to the style as
 *                                "arrangement: bridge - drums drop out; ...". The take that fell apart had this.
 *   YUE_STYLE_BACKING_MAX=8      off unless set to a number: a trained style gets at most that many parenthesised backing
 *                                phrases, echoes of the lead line going first and replies that carry new words last.
 *   YUE_STYLE_LENGTH_CAP=1       off unless set to 1 (review, Nov 10: it was on, and its ceiling sat only 17 percent above
 *                                a good take of the test sheet, 229 s against 267 s, while one sheet's takes are known to
 *                                spread 1.9 times): a styled NEW song of 22 sung lines or fewer carries a ceiling
 *                                (max_seconds), so a take that falls into repeating stops there instead of at six minutes.
 *                                The ceiling is now 1.3 times wider. Her usual sheets (45 lines and more) never get one.
 *                                Needs a worker that knows max_seconds; an older worker ignores it.
 *   YUE_LANGUAGE_ONCE=0          ON unless set to 0: a styled direction that opens "English," or "English vocals," does not
 *                                say the language a second time after the style's own lead.
 *   YUE_COVER_KEY=0              ON unless set to 0, for plain YuE2 only: a cover or score keeping its chords names its
 *                                score's key in the style beside the tempo (match_score_key), as upstream's own example
 *                                style does, unless Music direction names a key. "all": trained styles (whose captions
 *                                never named a key) and covers with a new accompaniment (where a misread key could steer
 *                                the new chords) too; that waits for her ear.
 *   YUE_COVER_SCORE_TAGS=1       off unless set: a cover's lyric section tags take the names the score's own sections have,
 *                                only when both have the same number of sung sections (score_section_tags). Needs her ear.
 * A worker older than max_seconds, match_score_key and score_section_tags ignores all three. */
export type YueLift = 'off' | 'styled' | 'all';
export function yueLiftDirections(env: NodeJS.ProcessEnv = process.env): YueLift {
  const said = String(env.YUE_LIFT_DIRECTIONS ?? '').trim().toLowerCase();
  return said === 'all' ? 'all' : said === 'styled' || said === '1' ? 'styled' : 'off';
}
export function yueFoldDirectionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.YUE_LIFT_FOLD ?? '').trim() === '1';
}
/** The most parenthesised backing phrases a trained style is sent; undefined (the default) for "send them all". */
export function yueBackingMax(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const said = String(env.YUE_STYLE_BACKING_MAX ?? '').trim();
  return /^\d{1,3}$/.test(said) && Number(said) > 0 ? Number(said) : undefined;
}
export function yueLengthCapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.YUE_STYLE_LENGTH_CAP ?? '').trim() === '1';
}
export function yueLanguageOnceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !switchedOff(env.YUE_LANGUAGE_ONCE);
}
export function yueCoverKey(env: NodeJS.ProcessEnv = process.env): 'off' | 'plain' | 'all' {
  if (switchedOff(env.YUE_COVER_KEY)) return 'off';
  return String(env.YUE_COVER_KEY ?? '').trim().toLowerCase() === 'all' ? 'all' : 'plain';
}
export function yueCoverScoreTags(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.YUE_COVER_SCORE_TAGS ?? '').trim() === '1';
}

export type YueDirection = { section: string; text: string };
const BRACKET_GROUP = /\[([^\]\n]*)\]/g;
const LETTER = /\p{L}/u;
/** A line with something to sing on it once its brackets are set aside. */
function sungLine(line: string): boolean {
  return !SECTION_LINE.test(line.replace(/\r$/, '')) && LETTER.test(line.replace(BRACKET_GROUP, ' '));
}
/** "Final Chorus - belting", "Verse 2: spoken", "Outro, fading", "Chorus (big)", "Final Chorus belting" and "Rap Verse":
 * the section name she wrote and the direction beside it. Undefined when no part of the tag is a section name, and for a
 * repeat such as "Chorus x2", which stays as typed. */
function sectionWithDirection(tag: string): { head: string; rest: string } | undefined {
  const bare = (text: string): string => text.replace(/^[\s\-–—:,(]+|[\s\-–—:,()]+$/g, '');
  const cut = /^([^\-–—:,(]+?)\s*(?:[-–—:,(])\s*(.*)$/.exec(tag.trim());
  if (cut && nativeSection(cut[1]) && LETTER.test(cut[2])) return { head: cut[1].trim(), rest: bare(cut[2]) };
  const words = tag.trim().split(/\s+/);
  if (words.length < 2 || words.length > 6 || sectionRepeat(tag)) return undefined;
  for (let n = words.length - 1; n >= 1; n -= 1) {
    const head = bare(words.slice(0, n).join(' '));
    const rest = bare(words.slice(n).join(' '));
    if (head && LETTER.test(rest) && nativeSection(head)) return { head, rest };
  }
  for (let n = 1; n < words.length; n += 1) {
    const head = bare(words.slice(n).join(' '));
    const rest = bare(words.slice(0, n).join(' '));
    if (head && LETTER.test(rest) && nativeSection(head)) return { head, rest };
  }
  return undefined;
}
/** "Chorus x2", "Verse 2x": a section name with a repeat count. It stays as typed. */
function sectionRepeat(tag: string): boolean {
  const repeat = /^(.*?)\s*(?:[x×]\s*\d+|\d+\s*[x×])$/i.exec(tag.trim());
  return !!repeat && !!nativeSection(repeat[1]);
}
/**
 * The lyric sheet without its bracketed directions, and the directions with the section each one stood in.
 * A section tag stays ("[Verse 2]", "[Final Chorus]", "[Guitar Solo]"). A tag that is a section name with a direction
 * ("[Final Chorus - belting]") keeps the section name and gives up the direction. A bracket line that is no section at all
 * ("[drums drop out, atmospheric pads]", "[belting]") is taken out.
 * Review, Nov 10 2026: the first version also took out any bracket inside a sung line and any unknown bracket line, and
 * that dropped sung words and fused sections. Only a bracket that stands ALONE on its line can be lifted now, and these
 * stay exactly as typed: a line with anything beside the bracket ("I said [whoa] baby", "[Verse 1] Walking down the line",
 * "[Chorus] x2", "[Hold me] [hold me]"); a bracket that is sung ("[Oh-oh-oh]", "[Hey!]"); a one-word tag that is not a
 * known delivery word ("[Rap]", "[Drop]"), which is doing a section's job; a section name with what reads as a name or a
 * label beside it ("[Verse 1 - Maria]", "[Rap Verse]"); and an unknown tag that opens a block of sung words after a blank
 * line. A sheet with nothing to lift comes back unchanged, character for character.
 */
const DELIVERY_WORD =
  /^(?:belt(?:ing|ed)?|spoken(?: word)?|whisper(?:ed|ing)?|shout(?:ed|ing)?|scream(?:ed|ing)?|soft(?:ly|er)?|quiet(?:ly|er)?|loud(?:ly|er)?|big(?:ger)?|falsetto|harmon(?:y|ies|ized)|a ?cappella|stripped|building|builds?|slow(?:ly|er)?|fast(?:er)?|fad(?:e|es|ing)(?: out)?|half[- ]time|double[- ]time)$/i;
/** A bracket that is sung, not a direction: a shout or a question, or nothing but sounds such as oh, hey, na. */
function sungBracket(text: string): boolean {
  const words = wordsOf(text);
  return /[!?]/.test(text) || (words.length > 0 && words.every((word) => VOCABLE.test(word)));
}
/** What stands beside a section name reads as a name or a label, not a direction: every word capitalised, and not a
 * delivery word. Such a tag stays as typed, so a singer's name never reaches the style. */
function labelBeside(rest: string): boolean {
  const words = rest.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && !DELIVERY_WORD.test(rest.trim()) && words.every((word) => /^\p{Lu}/u.test(word));
}
export function yueLiftedLyrics(lyrics: string): { lyrics: string; directions: YueDirection[] } {
  const lines = lyrics.split('\n');
  const out: string[] = [];
  const found: Array<{ at: number; text: string }> = [];
  const sections: string[] = [];
  let changed = false;
  const note = (text: string): void => {
    const clean = text
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-–—:,;.]+|[\s\-–—:,;.]+$/g, '');
    if (clean && LETTER.test(clean)) found.push({ at: sections.length - 1, text: clean });
  };
  const open = (name: string): void => {
    sections.push(name.toLowerCase().replace(/\s+/g, ' ').trim());
  };
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const cr = raw.endsWith('\r') ? '\r' : '';
    const line = cr ? raw.slice(0, -1) : raw;
    const tag = SECTION_LINE.exec(line);
    if (tag) {
      if (nativeSection(tag[2])) {
        open(tag[2]);
        out.push(raw);
        continue;
      }
      const split = sectionWithDirection(tag[2]);
      if (split && labelBeside(split.rest)) {
        open(split.head);
        out.push(raw);
        continue;
      }
      if (split) {
        open(split.head);
        out.push(`${tag[1]}[${split.head}]${tag[3]}${cr}`);
        note(split.rest);
        changed = true;
        continue;
      }
      if (sungBracket(tag[2])) {
        out.push(raw);
        continue;
      }
      const opensBlock = out.length === 0 || out[out.length - 1].trim() === '';
      const oneWord = wordsOf(tag[2]).length === 1 && !DELIVERY_WORD.test(tag[2].trim());
      if (sectionRepeat(tag[2]) || oneWord || (opensBlock && i + 1 < lines.length && sungLine(lines[i + 1]))) {
        open(tag[2]);
        out.push(raw);
        continue;
      }
      /* A direction standing alone between blank lines belongs to no section's words: it is a break, or the ending. */
      if (opensBlock) {
        const later = lines.slice(i + 1).some((next) => sungLine(next));
        const where = !sections.length ? 'opening' : later ? 'break' : 'ending';
        if (sections[sections.length - 1] !== where) open(where);
      }
      note(tag[2]);
      changed = true;
      continue;
    }
    /* Anything else, a bracket inside a sung line included, is hers and stays as typed. */
    out.push(raw);
  }
  if (!changed) return { lyrics, directions: [] };
  const uses = new Map<string, number>();
  for (const name of sections) uses.set(name, (uses.get(name) ?? 0) + 1);
  const seen = new Map<string, number>();
  const named = sections.map((name) => {
    const nth = (seen.get(name) ?? 0) + 1;
    seen.set(name, nth);
    return (uses.get(name) ?? 0) > 1 ? `${name} ${nth}` : name;
  });
  return {
    lyrics: out
      .join('\n')
      .replace(/\n(?:[ \t]*\r?\n){2,}/g, '\n\n')
      .replace(/^(?:[ \t]*\r?\n)+/, '')
      .trimEnd(),
    directions: found.map(({ at, text }) => ({ section: at < 0 ? 'opening' : named[at], text })),
  };
}
/** The style with the lifted directions after it, section by section, in the order they stood: "..., arrangement: intro -
 * strummed guitar; bridge - drums drop out". At most `room` characters of them, whole sections only, and never past the
 * 3000 characters a style may have. */
export function yueFoldedStyle(style: string, directions: YueDirection[], room = 320): string {
  const order: string[] = [];
  const bySection = new Map<string, string[]>();
  for (const { section, text } of directions) {
    if (!bySection.has(section)) {
      bySection.set(section, []);
      order.push(section);
    }
    const said = bySection.get(section) as string[];
    if (!said.some((other) => other.toLowerCase() === text.toLowerCase())) said.push(text);
  }
  const parts: string[] = [];
  let used = 0;
  for (const section of order) {
    const part = `${section} - ${(bySection.get(section) as string[]).join(', ')}`;
    if (used + part.length + 2 > room) break;
    parts.push(part);
    used += part.length + 2;
  }
  if (!parts.length) return style;
  const folded = `${style.replace(/[\s.,;]+$/, '')}, arrangement: ${parts.join('; ')}`;
  return folded.length <= 3000 ? folded : style;
}

const PAREN_GROUP = /\(([^()\n]*)\)/g;
const VOCABLE =
  /^(?:o+h*|a+h+|aa+|ye+a*h*|yeah+|he+y+|na+h?|la+|m+h*m*|hm+|who+a+h?|wo+a*h+|u+h+|hu+h|wo+|ha+|da+|doo+|sha+|a+y+e*|yo+|ba+|bop|doo+wop|ooh+|oo+|ee+|eh+)$/;
const wordsOf = (text: string): string[] => text.toLowerCase().match(/[\p{L}]+(?:['’][\p{L}]+)*/gu) ?? [];
/**
 * The sheet with at most `keep` parenthesised backing phrases. YuE2 has no backing voice: it sings each one as more lead
 * words, and the trained styles' sheets had none. What goes first is what adds no word: an echo of its own lead line (or,
 * on a line of its own, of the line before), verses before choruses; then wordless fills (ooh, yeah, na na); a reply that
 * says something new goes last. A phrase that comes back with the same line (a repeated chorus) is kept or dropped
 * everywhere together, so repeated choruses still match. Section tags, sung words and their order are untouched, and a sheet
 * already at or under `keep` comes back unchanged, character for character.
 */
export function yueThinnedBacking(
  lyrics: string,
  keep: number,
): { lyrics: string; total: number; removed: number } {
  const lines = lyrics.split('\n');
  type Hit = { line: number; group: number; rank: number; chorus: boolean; key: string };
  const hits: Hit[] = [];
  let chorus = false;
  let before: string[] = [];
  lines.forEach((raw, index) => {
    const line = raw.replace(/\r$/, '');
    const tag = SECTION_LINE.exec(line);
    if (tag) {
      const section = nativeSection(tag[2]) ?? (sectionWithDirection(tag[2]) ? nativeSection(sectionWithDirection(tag[2])?.head ?? '') : undefined);
      if (section) chorus = section === 'chorus';
      return;
    }
    const lead = wordsOf(line.replace(PAREN_GROUP, ' ').replace(BRACKET_GROUP, ' '));
    const against = new Set(lead.length ? lead : before);
    let group = 0;
    for (const match of line.matchAll(PAREN_GROUP)) {
      const words = wordsOf(match[1]);
      if (words.length) {
        const said = words.filter((word) => !VOCABLE.test(word));
        const rank = !said.length ? 1 : said.every((word) => against.has(word)) ? 0 : 2;
        /* Review, Nov 10 2026: "You (never) call" is an aside inside the lead line, not a backing vocal. Dropping it
         * changes what the line means, so a parenthesis with new words and lead words on both sides is never counted. */
        const at = match.index ?? 0;
        const sides = [line.slice(0, at), line.slice(at + match[0].length)].map((side) =>
          LETTER.test(side.replace(PAREN_GROUP, ' ').replace(BRACKET_GROUP, ' ')),
        );
        if (rank === 2 && sides[0] && sides[1]) {
          group += 1;
          continue;
        }
        hits.push({ line: index, group, rank, chorus, key: `${line.trim().toLowerCase()}|${group}` });
      }
      group += 1;
    }
    const all = wordsOf(line.replace(BRACKET_GROUP, ' '));
    if (all.length) before = all;
  });
  const total = hits.length;
  if (total <= keep) return { lyrics, total, removed: 0 };
  const byKey = new Map<string, Hit[]>();
  for (const hit of hits) byKey.set(hit.key, [...(byKey.get(hit.key) ?? []), hit]);
  const order = [...byKey.values()].sort(
    (a, b) =>
      a[0].rank - b[0].rank ||
      Number(a.some((hit) => hit.chorus)) - Number(b.some((hit) => hit.chorus)) ||
      b[0].line - a[0].line,
  );
  const drop = new Set<string>();
  let left = total;
  for (const same of order) {
    if (left <= keep) break;
    for (const hit of same) drop.add(`${hit.line}|${hit.group}`);
    left -= same.length;
  }
  const out: string[] = [];
  lines.forEach((raw, index) => {
    const cr = raw.endsWith('\r') ? '\r' : '';
    const line = cr ? raw.slice(0, -1) : raw;
    let group = -1;
    let touched = false;
    const kept = line.replace(PAREN_GROUP, (whole: string) => {
      group += 1;
      if (!drop.has(`${index}|${group}`)) return whole;
      touched = true;
      return ' ';
    });
    if (!touched) {
      out.push(raw);
      return;
    }
    const tidy = kept
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .trim();
    if (/[\p{L}\d]/u.test(tidy)) out.push(`${tidy}${cr}`);
  });
  return { lyrics: out.join('\n'), total, removed: total - left };
}

/**
 * A length ceiling in seconds for a score-free song, from its sung lines, or undefined when the sheet is long enough that
 * six minutes is the only sensible limit. Her score-free takes (Nov 2026, 113 of them): sheets of 57 to 77 lines ran 1:48
 * to 5:20 and the two runaways hit 6:00; a 16-line test sheet ran 2:38 and its runaway 6:00. The ceiling is 1.3 times the
 * larger of 150 s + 4.5 s a line and 60 s + 9 s a line (a slow ballad singing one line every two bars at 60 BPM, plus a
 * minute of intro, breaks and outro), which is 4:49 for 16 lines and 5:24 for 21. From 23 lines up it would pass 5:40, so
 * none is sent. Review, Nov 10 2026: without the 1.3 a good take of a 21-line sheet (229 s) sat at 86 percent of its
 * ceiling, and it counts sung lines only, not an instrumental break or a slow tempo. It is still a guess from line counts,
 * which is why it is off unless YUE_STYLE_LENGTH_CAP=1.
 */
export function yueLengthCapSeconds(lyrics: string): number | undefined {
  const sung = lyrics.split('\n').filter((line) => sungLine(line)).length;
  if (!sung) return undefined;
  const cap = Math.round(1.3 * Math.max(150 + 4.5 * sung, 60 + 9 * sung));
  return cap < 340 ? cap : undefined;
}
/** "kdsoulr, in the style of kdsoulr. English, contemporary R&B and soul. English, 1990s R&B, ..." says the language once:
 * a lead that names English, followed by a direction that opens with the language again ("English," or "English vocals,",
 * which is how the writing desk opened its first rich direction). */
export function yueLanguageOnce(style: string, band?: string): string {
  const lead = band && Object.prototype.hasOwnProperty.call(yueStyles, band) ? yueStyles[band].lead : '';
  if (!lead || !/\bEnglish\b/.test(lead) || !style.startsWith(`${lead} `)) return style;
  const rest = style.slice(lead.length + 1);
  /* "English vocals," is the language again under any lead. A bare "English," is too, after a lead that ends its sentence;
   * after a lead that stops at "English," that one is round one's rule (yueTidyStyle) and is left to it. */
  const again = (
    /English,$/.test(lead)
      ? /^(?:American[- ])?English (?:vocals?|lyrics|language|singing),\s*(?!(?:then|and|but|or)\b)(?=\S)/i
      : /^(?:American[- ])?English(?: (?:vocals?|lyrics|language|singing))?,\s*(?!(?:then|and|but|or)\b)(?=\S)/i
  ).exec(rest);
  return again ? `${lead} ${rest.slice(again[0].length)}` : style;
}
const NAMES_KEY =
  /\b[A-G](?:#|b|♯|♭|[- ]?(?:sharp|flat))?[- ]?(?:major|minor|maj|min)\b|\bkey of [A-G]\b/i;

export type YueWorkerInput = Omit<Input, 'my_voice'> & {
  sampling_map?: 'v2';
  lora_sound_stage?: 'plain';
  lora_modules?: 'attn' | 'mlp';
  lora_layers?: [number, number];
  max_seconds?: number;
  match_score_key?: true;
  score_section_tags?: true;
};
/**
 * The request as the music worker gets it: the saved job input (`yueInput`) with the Nov 10 2026 fixes applied. Pure: the job
 * itself is not changed, so the project, the library and Open in the booth keep her own words, tags and numbers.
 */
export function yueWorkerInput(
  { my_voice: _myVoice, ...input }: Input,
  env: NodeJS.ProcessEnv = process.env,
): YueWorkerInput {
  const sent: YueWorkerInput = { ...input };
  const styled = !!input.lora_key;
  const fixedScore = !!(input.reference_voice_url || input.abc);
  /* Round two: lifting and thinning, both off unless switched on. An instrumental sings no words, so its tags are left. */
  let sheet = input.lyrics;
  let lifted: YueDirection[] = [];
  const lift = yueLiftDirections(env);
  if (typeof sheet === 'string' && !input.instrumental) {
    if (lift === 'all' || (lift === 'styled' && styled)) ({ lyrics: sheet, directions: lifted } = yueLiftedLyrics(sheet));
    const most = yueBackingMax(env);
    if (styled && most !== undefined) sheet = yueThinnedBacking(sheet, most).lyrics;
    if (sheet !== input.lyrics) sent.lyrics = sheet;
  }
  if (styled && yueLanguageOnceEnabled(env)) sent.style = yueLanguageOnce(input.style, input.band);
  if (yuePreformatEnabled(env)) {
    if (typeof sheet === 'string') sent.lyrics = yueNativeLyrics(sheet, styled);
    if (styled) sent.style = yueTidyStyle(sent.style, input.band);
  }
  if (lifted.length && yueFoldDirectionsEnabled(env)) sent.style = yueFoldedStyle(sent.style, lifted);
  if (yueSamplingMap(env) === 'v2') sent.sampling_map = 'v2';
  if (styled) {
    const stage = yueStyleSoundStage(env);
    if (stage !== 'styled') sent.lora_sound_stage = stage;
    /* Only a guidance she left on the dial's default is replaced; a number she chose is hers. */
    const guidance = guidanceFrom(fixedScore ? env.YUE_STYLE_COVER_GUIDANCE : env.YUE_STYLE_GUIDANCE);
    if (guidance !== undefined && (input.guidance ?? 1) === 1) sent.guidance = guidance;
    Object.assign(
      sent,
      scopeFrom(env.YUE_STYLE_MODULES, env.YUE_STYLE_LAYERS),
      fixedScore ? scopeFrom(env.YUE_STYLE_COVER_MODULES, env.YUE_STYLE_COVER_LAYERS) : {},
    );
  }
  /* Upstream: describe the tempo in the style consistently with the score. A cover that keeps its chords already does
   * (coverFields); one with a new accompaniment still sings a score with a tempo of its own, and every trained style's
   * training captions ended with the song's BPM. Her own BPM always wins. */
  if (
    yueCoverTempoAlways(env) &&
    input.reference_voice_url &&
    input.keep_harmony === false &&
    !input.instrumental &&
    input.match_score_tempo === undefined &&
    !NAMES_BPM.test(input.style)
  )
    sent.match_score_tempo = true;
  /* Round two. A styled new song has no score to measure a length against, so a short sheet carries its own ceiling. */
  if (styled && !fixedScore && input.cot === 'off' && typeof sent.lyrics === 'string' && yueLengthCapEnabled(env)) {
    const cap = yueLengthCapSeconds(sent.lyrics);
    if (cap !== undefined) sent.max_seconds = cap;
  }
  /* Upstream's own example style names the key beside the tempo ("G major, 96 BPM"). With the chords kept the key is the
   * one the score's chords already spell, so naming it can only agree with them. Plain YuE2 only, unless "all" is asked for:
   * no trained style's captions named a key. */
  const key = yueCoverKey(env);
  const keepsChords = input.keep_harmony === true || (!!input.abc && input.cot === 'full');
  if (fixedScore && !NAMES_KEY.test(input.style) && (key === 'all' || (key === 'plain' && !styled && keepsChords)))
    sent.match_score_key = true;
  if (input.reference_voice_url && !input.instrumental && yueCoverScoreTags(env)) sent.score_section_tags = true;
  return sent;
}

export function yueConfigured(): boolean {
  return !!(process.env.YUE_ENDPOINT_ID && process.env.RUNPOD_API_KEY);
}
async function provider(
  path: string,
  data?: { input: YueWorkerInput; policy: { executionTimeout: number; ttl: number } },
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

const YUE_PROVIDER_TTL_MS = 7200000;

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
    /* yueWorkerInput leaves my_voice out (it never reaches the music worker) and applies the Nov 10 2026 fixes. */
    submit: (input) =>
      provider('run', { input: yueWorkerInput(input), policy: { executionTimeout: 1200000, ttl: YUE_PROVIDER_TTL_MS } }),
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
    providerTtlMs: YUE_PROVIDER_TTL_MS,
    working: 'YuE2 is composing. Up to two takes can run together when GPUs are available.',
    stopping:
      'Stop requested for unfinished takes. Finished takes are kept. GPU time already used is still billed.',
    takeNote: yueTakeNote,
    notesTruncated: true,
  });
}
