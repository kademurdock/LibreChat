import axios from 'axios';
import express from 'express';
import FormData from 'form-data';
import mongoose from 'mongoose';
import { logger } from '@librechat/data-schemas';
import type { Request, RequestHandler, Response, Router } from 'express';
import type { MediaSite } from '../description/links';

/* A new request for an imported recording should use the backing-vocal notation prompt instead
 * of returning a lyric draft cached before that instruction existed. */
const transcriptVersion = 'gemini38-tags-backing-scribe2-lyrics-v3';
/* Flash on low thinking: the Sep 25 check found no word-accuracy gain from medium or Pro, and
 * medium once spent 7,863 thought tokens and hit MAX_TOKENS. */
const geminiModel = 'gemini-3.8-flash';
/* The tag instruction is TAG_PROMPT from the Sep 25 check (no accuracy loss detected; every
 * chorus tagged), with [Post-Chorus] added to the allowed labels. */
const lyricPrompt =
  'Transcribe the complete sung lyrics from this audio, from beginning to end, in the original language. Use only words audibly present in this recording. Preserve repeated choruses, repetitions, contractions, and audible vocalizations. Do not summarize, translate, improve the writing, or fill gaps from memory. Mark genuinely unintelligible words [unclear]. Put each sung phrase on its own line, with a blank line between sections. Write the lead vocal without parentheses. Put the words of a clearly separate backing, harmony, response, or secondary vocal phrase in parentheses. If it overlaps a lead phrase, put its parentheses after that lead phrase; if it sings alone, use its own line. Do not add another copy of the lead words merely because the lead is doubled or harmonized. When the voices cannot be distinguished, leave the words unparenthesized. Do not infer or invent backing words. Do not use vocal-role labels in the lyric transcript. Put a section label on its own line before a section only where the music audibly marks a new section: [Verse], [Pre-Chorus], [Chorus], [Post-Chorus], [Bridge], [Intro] or [Outro]. A block whose words come back as a refrain is [Chorus]. Do not number the labels. Return only the lyric transcript with those labels, with no commentary or timestamps.';
type Transcript = {
  transcript: string;
  seconds: number;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
};
type ScribeResult = { text: string };
type GeminiResult = {
  promptFeedback?: { blockReason?: string };
  candidates?: {
    finishReason?: string;
    content?: { parts?: { text?: string; thought?: boolean }[] };
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
};

function audioMime(buffer: Buffer, declared: string): string {
  const prefix = buffer.subarray(0, 12).toString('latin1');
  if (prefix.startsWith('RIFF') && prefix.slice(8) === 'WAVE') return 'audio/wav';
  if (prefix.startsWith('fLaC')) return 'audio/flac';
  if (prefix.startsWith('OggS')) return 'audio/ogg';
  if (prefix.slice(4, 8) === 'ftyp') return 'audio/mp4';
  if (prefix.startsWith('ID3') || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0))
    return 'audio/mpeg';
  return declared.startsWith('audio/') ? declared.split(';')[0] : 'application/octet-stream';
}

/** The only section labels a draft may carry; YuE2 reads the lyrics word for word. */
const sectionTags = ['Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Post-Chorus', 'Bridge', 'Outro'];
const sectionTagByName = new Map(
  sectionTags.map((tag) => [tag.toLowerCase().replace(/[^a-z]/g, ''), `[${tag}]`]),
);
const backingRole = '(?:backing|background|secondary|harmony)\\s+vocals?';
const backingCue = new RegExp(`^\\s*(?:\\[\\s*)?${backingRole}\\s*(?:\\])?\\s*:?\\s*$`, 'i');
const backingPhrase = new RegExp(
  `^\\s*(?:\\[\\s*)?${backingRole}\\s*(?:\\])?\\s*:\\s*(.+?)\\s*$`,
  'i',
);
const bracketedBackingPhrase = new RegExp(`^\\s*\\[\\s*${backingRole}\\s*:\\s*(.+)\\]\\s*$`, 'i');
const parenthesizeBacking = (words: string): string => {
  const phrase = words.trim();
  return /^\(.+\)$/.test(phrase) ? phrase : `(${phrase})`;
};

/**
 * Keeps Gemini's labels to the allowed list: "[verse 2]" becomes "[Verse]", a label outside the
 * list ("[Interlude]") is dropped, and "[unclear]" on its own line stays. An explicit backing-
 * vocal cue from the model is rendered as parentheses without changing the sung words.
 */
export function tidySectionTags(transcript: string): string {
  let nextBackingLine = false;
  return transcript
    .split('\n')
    .flatMap((line) => {
      const rolePhrase = bracketedBackingPhrase.exec(line) || backingPhrase.exec(line);
      if (rolePhrase) {
        nextBackingLine = false;
        return [parenthesizeBacking(rolePhrase[1])];
      }
      if (backingCue.test(line)) {
        nextBackingLine = true;
        return [];
      }
      if (!line.trim()) {
        nextBackingLine = false;
        return [line];
      }
      const label = /^\s*\[([^\]\n]{1,40})\]\s*$/.exec(line);
      if (!label) {
        if (!nextBackingLine) return [line];
        nextBackingLine = false;
        return [parenthesizeBacking(line)];
      }
      nextBackingLine = false;
      const name = label[1]
        .toLowerCase()
        .replace(/\s*(?:x\s*\d+|\d+\s*x|\d+)$/, '')
        .replace(/[^a-z]/g, '');
      if (name === 'unclear') return [line];
      const tag = sectionTagByName.get(name);
      return tag ? [tag] : [];
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Why Gemini gave no draft, as one short countable word for the log ("finish:RECITATION"). */
class GeminiMiss extends Error {
  reason: string;
  skipped: boolean;
  constructor(reason: string, skipped = false) {
    super(`No Gemini lyric transcript (${reason}).`);
    this.name = 'GeminiMiss';
    this.reason = reason;
    this.skipped = skipped;
  }
}

/**
 * The reason in a Gemini failure, for the log: finish:<finishReason>, blocked:<blockReason>,
 * http:<status>[:<API status>], error:<axios code>, skip:<why>. Never the request, its headers or
 * the key.
 */
export function geminiFailureReason(error: unknown): string {
  if (error instanceof GeminiMiss) return error.reason;
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const body = error.response?.data as { error?: { status?: unknown } } | undefined;
    const apiStatus = typeof body?.error?.status === 'string' ? body.error.status : '';
    if (status) return `http:${status}${apiStatus ? `:${apiStatus.slice(0, 40)}` : ''}`;
    return `error:${error.code || 'network'}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `error:${message.replace(/\s+/g, ' ').trim().slice(0, 160) || 'unknown'}`;
}

async function geminiLyrics(buffer: Buffer, mime: string, seconds: number): Promise<Transcript> {
  const key = process.env.GEMINI_API_KEY || process.env.KADE_EMBED_GEMINI_KEY;
  if (!key) throw new GeminiMiss('skip:no-key', true);
  if (buffer.length > 14 * 1024 * 1024) throw new GeminiMiss('skip:over-14MiB', true);
  if (!mime.startsWith('audio/')) throw new GeminiMiss('skip:not-audio', true);
  const { data } = await axios.post<GeminiResult>(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`,
    {
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: mime, data: buffer.toString('base64') } },
            { text: lyricPrompt },
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingLevel: 'low' },
      },
    },
    {
      headers: { 'x-goog-api-key': key },
      timeout: 60000,
      maxRedirects: 0,
      maxBodyLength: 20 * 1024 * 1024,
      maxContentLength: 128 * 1024,
    },
  );
  const candidate = data.candidates?.[0];
  if (!candidate) {
    const blocked = data.promptFeedback?.blockReason;
    throw new GeminiMiss(blocked ? `blocked:${blocked}` : 'finish:no-candidate');
  }
  if (candidate.finishReason !== 'STOP')
    throw new GeminiMiss(`finish:${candidate.finishReason || 'none'}`);
  const transcript = tidySectionTags(
    (candidate.content?.parts ?? [])
      .filter((part) => !part.thought && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n'),
  );
  if (!transcript) throw new GeminiMiss('finish:STOP-empty');
  const usage = data.usageMetadata;
  return {
    transcript,
    seconds,
    model: geminiModel,
    usage: usage
      ? {
          inputTokens: usage.promptTokenCount || 0,
          outputTokens: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
        }
      : undefined,
  };
}

/**
 * `onGeminiError` (Part 295) hears every Gemini HTTP failure before the scribe_v2 fallback, so
 * the fork's Google key alarm can tell an empty prepaid balance from a refused song. It never
 * changes the fallback and a throw inside it is ignored.
 */
export async function transcribeMusicLyrics(
  buffer: Buffer,
  mime: string,
  seconds: number,
  onGeminiError?: (error: unknown) => void,
): Promise<Transcript> {
  mime = audioMime(buffer, mime);
  try {
    return await geminiLyrics(buffer, mime, seconds);
  } catch (error) {
    /* Countable: grep "lyrics gemini fallback reason=finish:RECITATION" to see how often
     * Gemini refuses a commercial song and the untagged backup draft is used instead. */
    const reason = geminiFailureReason(error);
    const line = `[music/lyrics] lyrics gemini fallback reason=${reason} model=${geminiModel} ${mime} ${buffer.length}B ${Math.round(seconds)}s; using scribe_v2`;
    if (error instanceof GeminiMiss && error.skipped) logger.info(line);
    else logger.warn(line);
    if (onGeminiError && !(error instanceof GeminiMiss)) {
      try {
        onGeminiError(error);
      } catch {
        /* the alarm never changes the fallback */
      }
    }
    return scribeLyrics(buffer, mime, seconds);
  }
}

async function scribeLyrics(buffer: Buffer, mime: string, seconds: number): Promise<Transcript> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('Lyric transcription is not configured.');
  const form = new FormData();
  form.append('model_id', 'scribe_v2');
  form.append('tag_audio_events', 'false');
  form.append('diarize', 'false');
  form.append('timestamps_granularity', 'word');
  form.append('temperature', '0');
  form.append('file', buffer, { filename: 'reference.audio', contentType: mime });
  const response = await axios.post<ScribeResult>(
    'https://api.elevenlabs.io/v1/speech-to-text',
    form,
    {
      headers: { ...form.getHeaders(), 'xi-api-key': key },
      timeout: 90000,
      maxRedirects: 0,
      maxBodyLength: 21 * 1024 * 1024,
      maxContentLength: 2 * 1024 * 1024,
    },
  );
  if (typeof response.data.text !== 'string') throw new Error('No lyric transcript returned.');
  return {
    transcript: response.data.text.trim().replace(/([.!?。！？])[\t ]+/gu, '$1\n'),
    seconds,
    model: 'scribe_v2',
  };
}

/* ---- Describe the sound (Oct 11 2026) ----
 * A cover can start from what the recording sounds like. This is a SECOND Gemini audio call, apart from the lyric
 * transcriber (whose prompt and request stay exactly as they were): it asks for ONE plain line in the shape the YuE2
 * trained styles' captions use, "<language>, <genre>, <pace>, <vocal>, <voice, instrument and production words>", which
 * the booth puts in Music direction. KADE_DESCRIBE_SOUND=0 switches the whole feature off (no extra call, no route, no
 * button, every answer as before); unset or anything else is on.
 * The reply is checked hard before anyone sees it (checkSoundDirection). The prompt forbids names, BPM, comparisons and
 * lyrics, and the check turns anything that slipped through into "no description" instead of junk. Honest limit: a name
 * written in plain lowercase inside a line otherwise in lowercase cannot be told from a descriptive word. */
const soundVersion = 'gemini38-sound-v1';
const soundPrompt =
  'Listen to this recording and describe how it sounds in ONE line, in exactly this shape: <language of the singing>, <one or two genre or sub-genre words>, <slow tempo, mid-tempo or up-tempo>, <female lead vocal, male lead vocal or female and male vocals>, then four to six short phrases about the voice quality, the instruments and the production. Separate the parts with commas. Write everything in lowercase except the language. If there is no singing, write instrumental in place of the language and leave out the vocal part. Rules: never give a BPM or any number except a decade such as 80s. Never name any artist, band, singer, producer, song, album or label. Never write sounds like, in the style of or any other comparison. Never write lyrics or quote any word from the recording. Never write section labels or brackets. Return only the line, with no label, quotes, markdown or explanation.';
const soundMaxChars = 240;
/** A line needs at least one phrase about the voice, instruments or production after the four fixed parts. */
const soundMinPhrases = 1;
const soundMaxParts = 30;
/** The message shown when a description could not be made. */
const soundMissNote = 'I could not describe the sound this time; type it yourself.';
const soundLateNote =
  'The description of the sound is not ready yet. Choose Describe the sound of the recording in a moment.';
const soundFailure =
  'I could not describe the sound this time. Your Music direction is kept; type it yourself.';

type SoundUsage = { inputTokens: number; outputTokens: number };
export type SoundDescription = {
  direction: string;
  seconds: number;
  model: string;
  usage?: SoundUsage;
};
export type SoundCheck = { direction: string } | { reason: string };
type SoundReply = { text: string; usage?: SoundUsage };

export function describeSoundEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KADE_DESCRIBE_SOUND !== '0';
}

const soundAlias = (canonical: string, ...forms: string[]): [string, string][] =>
  forms.map((form): [string, string] => [form, canonical]);
const soundLanguages: ReadonlySet<string> = new Set(
  'english spanish french german italian portuguese japanese korean mandarin cantonese chinese hindi arabic russian swedish norwegian danish finnish dutch polish turkish greek hebrew hawaiian latin irish welsh gaelic yiddish swahili zulu tagalog thai vietnamese indonesian ukrainian czech hungarian romanian persian bengali tamil punjabi urdu afrikaans icelandic catalan instrumental'.split(
    ' ',
  ),
);
const soundPace: ReadonlyMap<string, string> = new Map([
  ...soundAlias('slow tempo', 'slow tempo', 'slow-tempo', 'slow', 'slow paced', 'slow-paced', 'downtempo'),
  ...soundAlias(
    'mid-tempo',
    'mid-tempo',
    'mid tempo',
    'midtempo',
    'medium tempo',
    'medium-tempo',
    'moderate tempo',
    'moderate-tempo',
    'moderate',
    'medium',
  ),
  ...soundAlias(
    'up-tempo',
    'up-tempo',
    'up tempo',
    'uptempo',
    'fast tempo',
    'fast-tempo',
    'fast',
    'fast paced',
    'fast-paced',
    'quick tempo',
    'upbeat tempo',
  ),
]);
const soundVocal: ReadonlyMap<string, string> = new Map([
  ...soundAlias(
    'female lead vocal',
    'female lead vocal',
    'female lead vocals',
    'female lead',
    'female vocal',
    'female vocals',
    'female singer',
    'female lead singer',
    'female voice',
    'female vocalist',
    'female lead vocalist',
    'female-led vocals',
    'female led vocals',
    'lead female vocal',
    'lead female vocals',
  ),
  ...soundAlias(
    'male lead vocal',
    'male lead vocal',
    'male lead vocals',
    'male lead',
    'male vocal',
    'male vocals',
    'male singer',
    'male lead singer',
    'male voice',
    'male vocalist',
    'male lead vocalist',
    'male-led vocals',
    'male led vocals',
    'lead male vocal',
    'lead male vocals',
  ),
  ...soundAlias(
    'female and male vocals',
    'female and male vocals',
    'male and female vocals',
    'female and male lead vocals',
    'male and female lead vocals',
    'female and male vocal',
    'male and female vocal',
    'female and male voices',
    'male and female voices',
    'female and male',
    'male and female',
    'female and male duet',
    'male and female duet',
    'duet',
    'mixed vocals',
  ),
]);
/** Words that may be capitalized in a description without being a person's name. */
const soundAcronyms: ReadonlySet<string> = new Set(['R&B', 'EDM', 'UK', 'US', 'DJ']);
const soundPlaces: ReadonlySet<string> = new Set(
  'motown latin celtic afro afrobeat americana appalachian delta chicago memphis nashville detroit british southern western caribbean jamaican brazilian cuban irish scottish hawaiian texas k-pop j-pop'.split(
    ' ',
  ),
);
const soundLabel =
  /^(?:music\s+direction|description|caption|direction|style|sound|prompt|genre|tags?|answer|output|result)\s*[:\-–—]\s*/i;
const soundDecade = /\b(?:19|20)?\d0s\b/g;
/** A section tag or any bracket: "[Chorus]" in a reply means lyrics, whatever else is on the line. */
const soundTag = /[[\]{}<>]/;
/** A reason code for the log, and the pattern that earns it. Order matters: the clearest reason wins. */
const soundBans: [string, RegExp][] = [
  ['tag', soundTag],
  ['quoted', /["“”]/],
  [
    'refusal',
    /\b(?:sorry|i apologi[sz]e|i can(?:not|'t)|cannot|can't|i'?m unable|i am unable|unable to|not able to|as an ai|no audio|no sound)\b/i,
  ],
  [
    'comparison',
    /\b(?:sounds?\s+like|sounding\s+like|in\s+the\s+style\s+of|in\s+the\s+vein\s+of|in\s+the\s+manner\s+of|style\s+of|reminiscent|reminds?|similar\s+to|inspired\s+by|influenced\s+by|akin\s+to|cover\s+of|version\s+of|featuring)\b|esque\b/i,
  ],
  ['trigger', /(?:^|[^a-z])kd[a-z0-9]*/i],
  ['bpm', /bpm\b|beats?[\s-]+per[\s-]+minute/i],
  ['sentences', /[.!?]\s+\S/],
  ['lyrics', /\b(?:i|i'm|i'll|i've|i'd|me|my|you|you're|your|we|our)\b/i],
];

const soundReject = (reason: string): { reason: string } => ({ reason });
const soundTokens = (parts: string[]): { token: string; initial: boolean }[] =>
  parts.flatMap((part) =>
    part.split(/\s+/).map((token, index) => ({ token, initial: index === 0 })),
  );
const soundNeutral = (token: string): boolean =>
  soundAcronyms.has(token) || soundPlaces.has(token.toLowerCase());
const soundCapital = (token: string): boolean => /^\p{Lu}/u.test(token) && !soundNeutral(token);

/**
 * Whether a capital letter in the description points to a person's, band's or song's name. A line written wholly in
 * Title Case or wholly in sentence case per part is a style, not names. Capitals mixed into lowercase words are names,
 * and so is any shouted word (three capitals or more) that is not a known acronym.
 */
function soundHasName(parts: string[]): boolean {
  const tokens = soundTokens(parts);
  if (tokens.some(({ token }) => /^\p{Lu}{3,}$/u.test(token) && !soundNeutral(token))) return true;
  const inner = tokens.filter(({ initial }) => !initial);
  const innerCapitals = inner.filter(({ token }) => soundCapital(token)).length;
  const titleCase = inner.length > 0 && innerCapitals / inner.length >= 0.6;
  if (innerCapitals > 0 && !titleCase) return true;
  const openers = tokens.filter(({ initial, token }) => initial && !soundNeutral(token));
  const capitalOpeners = openers.filter(({ token }) => soundCapital(token)).length;
  return capitalOpeners > 0 && capitalOpeners < openers.length;
}

const soundLower = (part: string): string =>
  part
    .toLowerCase()
    .replace(/\br&b\b/g, 'R&B')
    .replace(/\b(edm|uk|us|dj)\b/g, (word) => word.toUpperCase());

/** One line from the model's reply: markdown, a leading label and wrapping quotes are removed; two lines is no line. */
function soundLine(raw: string): { text: string } | { reason: string } {
  if (soundTag.test(raw)) return soundReject('tag');
  const lines = raw
    .replace(/```[a-z]*/gi, '\n')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return soundReject('empty');
  if (lines.length > 1) return soundReject('lines');
  const text = lines[0]
    .replace(/^[\s>*#_`-]+/, '')
    .replace(soundLabel, '')
    .replace(/^[\s"'‘’`*_]+|[\s"'‘’`*_.]+$/g, '');
  return text ? { text } : soundReject('empty');
}

/** The parts of a line in the order the trained captions use, cut at a comma boundary under the cap. */
function soundOrdered(
  language: string,
  genre: string,
  pace: string,
  vocal: string | undefined,
  sound: string[],
): string {
  const head = [language[0].toUpperCase() + language.slice(1), genre, pace, ...(vocal ? [vocal] : [])].join(', ');
  const totals = sound.map((_, index) =>
    sound.slice(0, index + 1).reduce((length, word) => length + word.length + 2, head.length),
  );
  const over = totals.findIndex((length) => length > soundMaxChars);
  return [head, ...(over === -1 ? sound : sound.slice(0, over))].join(', ');
}

/**
 * The strict check on the model's reply. Returns the line to show or the reason it was refused. It accepts exactly:
 * language (or "instrumental"), a genre part, slow tempo, mid-tempo or up-tempo, female lead vocal, male lead vocal or
 * female and male vocals (not for an instrumental), then voice, instrument and production words, one line, at most 240
 * characters, cut at a comma. It refuses an empty or too short reply, a second line, brackets (section tags), quoted
 * words, lyric-like sentences or first-person words, an apology or refusal, a BPM or any number but a decade, a
 * comparison ("sounds like"), a training trigger (kd...), and capitals that look like names.
 */
export function checkSoundDirection(raw: string): SoundCheck {
  const first = soundLine(raw);
  if ('reason' in first) return first;
  const banned = soundBans.find(([, pattern]) => pattern.test(first.text));
  if (banned) return soundReject(banned[0]);
  if (/\d/.test(first.text.replace(soundDecade, ''))) return soundReject('number');
  const parts = first.text
    .split(/\s*[,;]\s*/)
    .map((part) => part.trim().replace(/[.\s]+$/, ''))
    .filter(Boolean);
  const [language, ...rest] = parts;
  if (!language || !soundLanguages.has(language.toLowerCase())) return soundReject('language');
  if (parts.length > soundMaxParts || rest.some((part) => part.split(/\s+/).length > 6 || part.length > 48))
    return soundReject('segment');
  if (rest.some((part) => /[^\p{L}\d&'’\/ -]/u.test(part))) return soundReject('characters');
  const lower = rest.map(soundLower);
  const fixedPart = (part: string): boolean => soundPace.has(part) || soundVocal.has(part);
  if (soundHasName(rest.filter((part) => !fixedPart(part.toLowerCase())))) return soundReject('name');
  const pace = lower.map((part) => soundPace.get(part)).find(Boolean);
  const vocal = lower.map((part) => soundVocal.get(part)).find(Boolean);
  const instrumental = language.toLowerCase() === 'instrumental';
  if (!pace) return soundReject('pace');
  if (instrumental === Boolean(vocal)) return soundReject('vocal');
  const others = [...new Set(lower.filter((part) => !soundPace.has(part) && !soundVocal.has(part)))];
  if (others.length === 0) return soundReject('genre');
  if (others.length < 1 + soundMinPhrases) return soundReject('short');
  return { direction: soundOrdered(language.toLowerCase(), others[0], pace, vocal, others.slice(1)) };
}

/** The reply of one Gemini audio call, before any check. Same endpoint, key, model, limits and settings as the lyric call. */
async function geminiSound(buffer: Buffer, mime: string): Promise<SoundReply> {
  const key = process.env.GEMINI_API_KEY || process.env.KADE_EMBED_GEMINI_KEY;
  if (!key) throw new GeminiMiss('skip:no-key', true);
  if (buffer.length > 14 * 1024 * 1024) throw new GeminiMiss('skip:over-14MiB', true);
  if (!mime.startsWith('audio/')) throw new GeminiMiss('skip:not-audio', true);
  const { data } = await axios.post<GeminiResult>(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`,
    {
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: mime, data: buffer.toString('base64') } },
            { text: soundPrompt },
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingLevel: 'low' },
      },
    },
    {
      headers: { 'x-goog-api-key': key },
      timeout: 60000,
      maxRedirects: 0,
      maxBodyLength: 20 * 1024 * 1024,
      maxContentLength: 128 * 1024,
    },
  );
  const candidate = data.candidates?.[0];
  if (!candidate) {
    const blocked = data.promptFeedback?.blockReason;
    throw new GeminiMiss(blocked ? `blocked:${blocked}` : 'finish:no-candidate');
  }
  if (candidate.finishReason !== 'STOP')
    throw new GeminiMiss(`finish:${candidate.finishReason || 'none'}`);
  const usage = data.usageMetadata;
  return {
    text: (candidate.content?.parts ?? [])
      .filter((part) => !part.thought && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n'),
    usage: usage
      ? {
          inputTokens: usage.promptTokenCount || 0,
          outputTokens: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
        }
      : undefined,
  };
}

const soundTokensNote = (usage?: SoundUsage): string =>
  usage ? `tokens=in:${usage.inputTokens},out:${usage.outputTokens}` : 'tokens=unknown';

/**
 * One plain line about how a recording sounds, for the Music direction box of a cover, or null when no usable line
 * could be made. It never throws. Its log lines carry the model, the recording's size and length, the token counts
 * (what the house paid for the call) and the reason for a miss, never the reply, the request or the key.
 * `onGeminiError` hears every Gemini HTTP failure, as transcribeMusicLyrics does, so the fork's Google key alarm can tell
 * an empty prepaid balance from a refused recording; a throw inside it is ignored.
 */
export async function describeMusicSound(
  buffer: Buffer,
  mime: string,
  seconds: number,
  onGeminiError?: (error: unknown) => void,
): Promise<SoundDescription | null> {
  mime = audioMime(buffer, mime);
  const detail = `model=${geminiModel} ${mime} ${buffer.length}B ${Math.round(seconds)}s`;
  try {
    const reply = await geminiSound(buffer, mime);
    const checked = checkSoundDirection(reply.text);
    if (!('direction' in checked)) {
      logger.warn(
        `[music/lyrics] sound describe rejected reason=${checked.reason} ${detail} ${soundTokensNote(reply.usage)}`,
      );
      return null;
    }
    logger.info(`[music/lyrics] sound described ${detail} ${soundTokensNote(reply.usage)}`);
    return { direction: checked.direction, seconds, model: geminiModel, usage: reply.usage };
  } catch (error) {
    const line = `[music/lyrics] sound describe failed reason=${geminiFailureReason(error)} ${detail}`;
    if (error instanceof GeminiMiss && error.skipped) logger.info(line);
    else logger.warn(line);
    if (onGeminiError && !(error instanceof GeminiMiss)) {
      try {
        onGeminiError(error);
      } catch {
        /* the alarm never changes the answer */
      }
    }
    return null;
  }
}

/** Where an imported cover came from, when it was not a file (Part 293: a media link). */
export type MusicReferenceSource = {
  site: MediaSite;
  title: string;
  seconds?: number;
  link?: string;
  id?: string;
};
type Reference = {
  user: string;
  key: string;
  url: string;
  seconds?: number;
  source?: MusicReferenceSource;
  transcript?: Transcript;
  transcriptVersion?: string;
  sound?: SoundDescription;
  soundVersion?: string;
  leaseUntil?: Date;
};
const schema = new mongoose.Schema<Reference>({
  user: String,
  key: String,
  url: String,
  seconds: Number,
  source: mongoose.Schema.Types.Mixed,
  transcript: mongoose.Schema.Types.Mixed,
  transcriptVersion: String,
  sound: mongoose.Schema.Types.Mixed,
  soundVersion: String,
  leaseUntil: Date,
});
schema.index({ user: 1, key: 1 }, { unique: true });
const References =
  (mongoose.models.KadeMusicReference as mongoose.Model<Reference>) ||
  mongoose.model<Reference>('KadeMusicReference', schema);
function identity(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new Error('Use an imported recording.');
  return parsed.origin + parsed.pathname;
}
/** Sing it in my voice: an imported recording's length in seconds (for the cost estimate), when the account owns it. */
export async function musicReferenceSeconds(
  user: string,
  url: string,
): Promise<number | undefined> {
  try {
    const reference = await References.findOne({ user, key: identity(url) })
      .select('seconds')
      .lean();
    return typeof reference?.seconds === 'number' ? reference.seconds : undefined;
  } catch {
    return undefined;
  }
}
export async function registerMusicReference(
  user: string,
  url: string,
  seconds?: number | null,
  source?: MusicReferenceSource | null,
): Promise<void> {
  await References.updateOne(
    { user, key: identity(url) },
    {
      $set: {
        url,
        ...(typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
          ? { seconds }
          : {}),
        ...(source ? { source } : {}),
      },
    },
    { upsert: true },
  );
}
type Hooks = {
  auth: RequestHandler;
  user: (req: Request) => string;
  savedSources: (user: string) => Promise<string[]>;
  authorize?: (user: string, url: string) => Promise<void>;
  refresh: (url: string, user: string) => Promise<string>;
  duration: (buffer: Buffer) => Promise<number | null>;
  transcribe: (buffer: Buffer, mime: string, seconds: number) => Promise<Transcript>;
  /** One plain line about how the recording sounds; resolves to null when none could be made. */
  describe?: (buffer: Buffer, mime: string, seconds: number) => Promise<SoundDescription | null>;
  /** Test seam for how long a description is waited for (see soundWaitAfterLyricsMs). */
  describeWait?: { afterLyricsMs?: number; aloneMs?: number };
};

/**
 * The sentence read aloud with a draft, by where it came from: Gemini's section tags are guesses
 * to check; the backup transcriber writes no tags at all, and the person is told so plainly.
 */
export function lyricsWarning(model: string | undefined): string {
  if (typeof model === 'string' && model.startsWith('gemini'))
    return 'Draft lyrics only: singing, backing vocals and instruments can cause wrong or missing words. Parentheses for separate backing vocals and the section tags are guesses from the music. Listen, then correct the words, parentheses and tags in the Lyrics box before generating.';
  return 'Draft lyrics from the backup transcriber, so they have no section tags. Add tags such as [Verse] and [Chorus] yourself. It cannot reliably mark separate backing vocals in parentheses. Singing, backing vocals and instruments can cause wrong or missing words. Listen and correct the Lyrics box before generating.';
}

/* Fit by tempo (worker feature fit-tempo), behind YUE_FIT_TEMPO=1. YuE2 sings up to six minutes
 * (9,000 sound tokens). With the flag on, a recording for a YuE2 cover up to
 * YUE_FIT_TEMPO_MAX_SECONDS (400 s, 6:40, by default and at most: the worker takes up to 402 s) is
 * accepted, and the worker sings a song whose score runs past 352 s a little faster to fit: its
 * score's tempo line only, so the same notes in the same key, about 15% at most for a 6:40 song
 * and never more than 20%. Anything longer is refused here, before anything is stored or any GPU
 * wakes. Only a YuE2 cover gets the longer limit (`yueCover: true`): Sing it in my voice, which
 * checks its recordings here too, keeps six minutes and its own words. With the flag unset every
 * limit and sentence is exactly as before. The live worker must run an image listing fit-tempo
 * first, and the booth sends fit_tempo only then (music/yue.ts yueFitTempoEnabled reads the same
 * flag). */
const COVER_SECONDS = 360;
/** The worker's FIT_SECONDS: a sped score runs at most this long. */
const FIT_SECONDS = 352;
const FIT_MAX_SECONDS = 400;
export function musicFitTempoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.YUE_FIT_TEMPO === '1';
}
/** What a recording is checked for: `yueCover` for a YuE2 cover of a recording, the only use that
 * may run past six minutes; anything else (Sing it in my voice) keeps six minutes. */
export type MusicReferenceUse = { yueCover?: boolean; speechEdit?: boolean; env?: NodeJS.ProcessEnv };
/** The longest recording the booth accepts: 360 s, or for a YuE2 cover up to 400 s with
 * YUE_FIT_TEMPO=1. */
export function musicReferenceMaxSeconds(use: MusicReferenceUse = {}): number {
  const env = use.env ?? process.env;
  if (use.speechEdit) return 3600;
  if (use.yueCover !== true || !musicFitTempoEnabled(env)) return COVER_SECONDS;
  const said = Number(env.YUE_FIT_TEMPO_MAX_SECONDS);
  if (!env.YUE_FIT_TEMPO_MAX_SECONDS || !Number.isFinite(said)) return FIT_MAX_SECONDS;
  return Math.min(FIT_MAX_SECONDS, Math.max(COVER_SECONDS, Math.floor(said)));
}
/** "6 minutes 40 seconds", "6 minutes". */
function coverLength(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m} minute${m === 1 ? '' : 's'}${s ? ` ${s} second${s === 1 ? '' : 's'}` : ''}`;
}

export function musicReferenceError(
  seconds: number | null | undefined,
  use: MusicReferenceUse = {},
): string | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0)
    return 'The recording could not be read. Import a readable audio file before generating.';
  const max = musicReferenceMaxSeconds(use);
  if (seconds <= max) return;
  const rounded = Math.round(seconds);
  const length = `This recording is ${Math.floor(rounded / 60)} minutes ${rounded % 60} seconds long.`;
  if (use.speechEdit) return `${length} Import a recording under one hour for speech editing.`;
  if (max <= COVER_SECONDS)
    return `${length} Covers support up to 6 minutes. Import a shorter recording or an excerpt; your original will not be trimmed automatically.`;
  return `${length} Covers can be up to ${coverLength(max)}: a song over six minutes is sped up a little to fit, and past ${coverLength(max)} that would be too much. Import a shorter recording or an excerpt; your original will not be trimmed automatically.`;
}

/**
 * With YUE_FIT_TEMPO=1, the sentence said when a recording for a YuE2 cover lands that will be
 * sped up to fit, before any GPU time is spent: an estimate from the recording's own length (the
 * take's note gives the exact figure, from its score). '' when nothing will be sped up. For YuE2
 * covers only: the booth never says it for Sing it in my voice.
 */
export function musicReferenceSpeedNote(
  seconds: number | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!musicFitTempoEnabled(env) || typeof seconds !== 'number' || !Number.isFinite(seconds))
    return '';
  if (seconds <= FIT_SECONDS || seconds > musicReferenceMaxSeconds({ yueCover: true, env }))
    return '';
  const percent = Math.max(1, Math.ceil((seconds / FIT_SECONDS - 1) * 100 - 1e-9));
  return `YuE2 sings up to six minutes, so this cover will be sped up about ${percent}%, in the same key.`;
}

const COVER_HINT_TODAY = 'Import one song, up to six minutes.';
const COVER_HOWTO_TODAY = 'A cover takes one recording up to six minutes.';
/**
 * The YuE2 guide with its cover length said the fit-by-tempo way while YUE_FIT_TEMPO=1: the
 * recording field's hint and the how-to line. The same object back when the flag is off. Only
 * the YuE2 engine is passed here; Sing it in my voice keeps its six minutes.
 */
export function musicCoverLengthGuide<
  T extends { settings?: Array<{ key: string; hint?: string }>; howToWrite?: string[] },
>(yue: T, env: NodeJS.ProcessEnv = process.env): T {
  if (!musicFitTempoEnabled(env) || !yue) return yue;
  const max = coverLength(musicReferenceMaxSeconds({ yueCover: true, env }));
  const sped = 'A song over six minutes is sped up a little to fit, in the same key.';
  return {
    ...yue,
    ...(Array.isArray(yue.howToWrite)
      ? {
          howToWrite: yue.howToWrite.map((line) =>
            line.replace(COVER_HOWTO_TODAY, `A cover takes one recording up to ${max}. ${sped}`),
          ),
        }
      : {}),
    ...(Array.isArray(yue.settings)
      ? {
          settings: yue.settings.map((setting) =>
            setting.key === 'reference_voice_url' && typeof setting.hint === 'string'
              ? { ...setting, hint: setting.hint.replace(COVER_HINT_TODAY, `Import one song, up to ${max}. ${sped}`) }
              : setting,
          ),
        }
      : {}),
  };
}

class ReferenceOwnershipError extends Error {
  constructor() {
    super('That recording is not saved on your account. Import it again.');
  }
}

async function authorizeReference(user: string, url: string, hooks: Pick<Hooks, 'authorize'>) {
  try {
    await hooks.authorize?.(user, url);
  } catch {
    throw new ReferenceOwnershipError();
  }
}

async function ownedReference(user: string, url: string, hooks: Pick<Hooks, 'savedSources' | 'authorize'>) {
  // A legacy registry row or cached transcript is not evidence of ownership.
  await authorizeReference(user, url, hooks);
  const key = identity(url);
  const reference = await References.findOne({ user, key }).lean();
  if (reference) {
    await authorizeReference(user, reference.url, hooks);
    return reference;
  }
  const sources = await hooks.savedSources(user);
  const owned = sources.find((url) => {
    try {
      return identity(url) === key;
    } catch {
      return false;
    }
  });
  // An independently authorized import may predate the registry, and equivalent
  // bucket/key URLs can have different origins or paths. Keep that import usable.
  const source = owned || (hooks.authorize ? url : null);
  if (!source) return null;
  await authorizeReference(user, source, hooks);
  await registerMusicReference(user, source);
  return References.findOne({ user, key }).lean();
}

/** Checks an imported recording before a render. `use.yueCover` for a YuE2 cover (the only use
 * that may run past six minutes, with YUE_FIT_TEMPO=1); Sing it in my voice passes nothing. */
export async function validateMusicReference(
  user: string,
  url: string,
  hooks: Pick<Hooks, 'savedSources' | 'refresh' | 'duration' | 'authorize'>,
  use: MusicReferenceUse = {},
): Promise<string> {
  const reference = await ownedReference(user, url, hooks);
  if (!reference) throw new Error('That recording is not saved on your account. Import it again.');
  let refreshed: string;
  let seconds = reference.seconds;
  try {
    refreshed = await hooks.refresh(reference.url, user);
    await authorizeReference(user, refreshed, hooks);
    if (seconds === undefined) {
      const audio = await axios.get<ArrayBuffer>(refreshed, {
        responseType: 'arraybuffer',
        maxRedirects: 0,
        maxContentLength: (use.speechEdit ? 256 : 20) * 1024 * 1024,
        timeout: 45000,
      });
      seconds = (await hooks.duration(Buffer.from(audio.data))) ?? undefined;
      await registerMusicReference(user, reference.url, seconds);
    }
  } catch (error) {
    if (error instanceof ReferenceOwnershipError) throw error;
    throw new Error(
      use.speechEdit
        ? 'Could not check the recording. No edit request was sent. Import it again and retry.'
        : 'Could not check the cover recording. No music request was sent. Import it again and retry.',
    );
  }
  const error = musicReferenceError(seconds, use);
  if (error) throw new Error(error);
  return refreshed;
}

type SoundFields = { direction: string; direction_usage?: SoundUsage } | { direction_note: string };
type Heard = { buffer: Buffer; mime: string; seconds: number };
/** A description being made: its result, and the moment it has been written to the recording's row (never rejects). */
type SoundFlight = { described: Promise<SoundDescription | null>; kept: Promise<void> };
type SoundFlights = {
  running: (user: string, key: string) => SoundFlight | undefined;
  begin: (user: string, key: string, heard: Heard) => SoundFlight;
};
/* How long a description is waited for. After the lyric call it is not waited for at all: if it is not ready by then, the
 * lyrics go out without it and it finishes in the background and is kept for the next press. Alone (the lyrics were already
 * kept from an earlier press) it is the whole request, so it gets time. */
const soundWaitAfterLyricsMs = 0;
const soundWaitAloneMs = 45000;

const describeActive = (hooks: Hooks): boolean =>
  typeof hooks.describe === 'function' && describeSoundEnabled();

function cachedSound(
  reference: Pick<Reference, 'sound' | 'soundVersion'> | null | undefined,
): SoundDescription | undefined {
  const sound = reference?.sound;
  return sound?.direction && reference?.soundVersion === soundVersion ? sound : undefined;
}

const soundFields = (sound: SoundDescription): SoundFields => ({
  direction: sound.direction,
  ...(sound.usage ? { direction_usage: sound.usage } : {}),
});

/** The description if it is ready within `waitMs`; otherwise the plain note that says why there is none. */
async function soundWithin(flight: SoundFlight, waitMs: number): Promise<SoundFields> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), waitMs);
  });
  const got = await Promise.race([flight.described, late]).finally(() => clearTimeout(timer));
  if (got === 'late') return { direction_note: soundLateNote };
  if (!got) return { direction_note: soundMissNote };
  await flight.kept;
  return soundFields(got);
}

/** The Describe button's answer once the description is made: the line (after it is kept), or the plain failure sentence. */
async function answerSound(res: Response, flight: SoundFlight): Promise<void> {
  const described = await flight.described;
  if (!described) {
    res.status(502).json({ error: soundFailure });
    return;
  }
  await flight.kept;
  res.json({ ...soundFields(described), cached: false });
}

async function keepSound(user: string, key: string, sound: SoundDescription | null): Promise<void> {
  if (!sound) return;
  try {
    await References.updateOne({ user, key }, { $set: { sound, soundVersion } });
  } catch (error) {
    logger.warn(
      `[music/lyrics] sound description could not be kept reason=${geminiFailureReason(error)}`,
    );
  }
}

/**
 * The descriptions being made right now, by account and recording. A description that missed its wait keeps running and
 * is kept when it ends, and a second press for the same recording joins it instead of paying for a second call.
 */
function soundFlights(hooks: Hooks): SoundFlights {
  const flying = new Map<string, SoundFlight>();
  const running = (user: string, key: string): SoundFlight | undefined =>
    flying.get(`${user}\n${key}`);
  const begin = (user: string, key: string, heard: Heard): SoundFlight => {
    const known = running(user, key);
    if (known) return known;
    const id = `${user}\n${key}`;
    const described = Promise.resolve()
      .then(() => hooks.describe?.(heard.buffer, heard.mime, heard.seconds) ?? null)
      .then((sound) => (sound && sound.direction?.trim() ? sound : null))
      .catch((error: unknown) => {
        logger.warn(`[music/lyrics] sound describe hook failed reason=${geminiFailureReason(error)}`);
        return null;
      });
    const kept = described.then((sound) => keepSound(user, key, sound));
    const flight = { described, kept };
    flying.set(id, flight);
    void kept.finally(() => flying.delete(id));
    return flight;
  };
  return { running, begin };
}

/** One account's hold on one recording for four minutes, so two presses never run two calls. Null when it is held. */
function claimReference(user: string, key: string) {
  return References.findOneAndUpdate(
    {
      user,
      key,
      $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: new Date() } }],
    },
    { $set: { leaseUntil: new Date(Date.now() + 240000) } },
    { new: true },
  ).lean();
}

const releaseReference = (user: string, key: string) =>
  References.updateOne({ user, key }, { $unset: { leaseUntil: 1 } });

/**
 * The recording's bytes, type and measured length. A recording past a cover's limit is answered here with the 400 and
 * nothing is returned. Transcribe reference lyrics and Describe the sound are a YuE2 cover's buttons, so a cover's limit.
 */
async function listenTo(
  res: Response,
  user: string,
  referenceUrl: string,
  hooks: Hooks,
): Promise<Heard | undefined> {
  const url = await hooks.refresh(referenceUrl, user);
  await authorizeReference(user, url, hooks);
  const audio = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    maxRedirects: 0,
    maxContentLength: 20 * 1024 * 1024,
    timeout: 45000,
  });
  const buffer = Buffer.from(audio.data);
  const seconds = await hooks.duration(buffer);
  const durationError = musicReferenceError(seconds, { yueCover: true });
  if (durationError || seconds === null) {
    res.status(400).json({ error: durationError });
    return undefined;
  }
  return { buffer, mime: String(audio.headers['content-type'] || 'audio/mpeg'), seconds };
}

export function createLyricsRouter(hooks: Hooks): Router {
  const router = express.Router();
  const flights = soundFlights(hooks);
  router.post(
    '/reference/lyrics',
    hooks.auth,
    express.json({ limit: '16kb' }),
    async (req, res) => {
      let key: string;
      const user = hooks.user(req);
      try {
        if (typeof req.body.url !== 'string' || req.body.url.length > 12000)
          throw new Error('No recording.');
        key = identity(req.body.url);
      } catch {
        res.status(400).json({ error: 'Import a cover recording first.' });
        return;
      }
      try {
        const reference = await ownedReference(user, req.body.url, hooks);
        if (!reference) {
          res
            .status(404)
            .json({ error: 'That recording is not saved on your account. Import it again.' });
          return;
        }
        const describing = describeActive(hooks);
        const known = describing ? cachedSound(reference) : undefined;
        if (
          reference?.transcript &&
          reference.transcriptVersion === transcriptVersion &&
          (!describing || known)
        ) {
          const warning = lyricsWarning(reference.transcript.model);
          res.json({
            ...reference.transcript,
            warning,
            cached: true,
            ...(known ? soundFields(known) : {}),
          });
          return;
        }
        const claim = await claimReference(user, key);
        if (!claim) {
          res
            .status(409)
            .json({ error: 'This recording is already being transcribed. Wait for it to finish.' });
          return;
        }
        try {
          await authorizeReference(user, claim.url, hooks);
          const kept =
            claim.transcript && claim.transcriptVersion === transcriptVersion
              ? claim.transcript
              : undefined;
          const keptSound = describing ? cachedSound(claim) : undefined;
          if (kept && (!describing || keptSound)) {
            res.json({
              ...kept,
              warning: lyricsWarning(kept.model),
              cached: true,
              ...(keptSound ? soundFields(keptSound) : {}),
            });
            return;
          }
          const heard = await listenTo(res, user, claim.url, hooks);
          if (!heard) return;
          const sound =
            describing && !keptSound ? flights.begin(user, key, heard) : undefined;
          const result =
            kept ?? (await hooks.transcribe(heard.buffer, heard.mime, heard.seconds));
          if (!result.transcript?.trim()) {
            res
              .status(422)
              .json({ error: 'No clear words were detected. Your existing lyrics are kept.' });
            return;
          }
          if (!kept) {
            result.transcript = result.transcript.slice(0, 8000);
            await References.updateOne(
              { user, key },
              { $set: { transcript: result, transcriptVersion } },
            );
          }
          const extra = keptSound
            ? soundFields(keptSound)
            : sound
              ? await soundWithin(
                  sound,
                  kept
                    ? (hooks.describeWait?.aloneMs ?? soundWaitAloneMs)
                    : (hooks.describeWait?.afterLyricsMs ?? soundWaitAfterLyricsMs),
                )
              : {};
          res.json({ ...result, warning: lyricsWarning(result.model), cached: !!kept, ...extra });
        } finally {
          await releaseReference(user, key);
        }
      } catch (error) {
        if (res.headersSent) return;
        if (error instanceof ReferenceOwnershipError) {
          res.status(400).json({ error: error.message });
          return;
        }
        res.status(502).json({
          error:
            'Could not transcribe this recording. Your existing lyrics are kept. Try a clearer recording or type the words.',
        });
      }
    },
  );
  /* Describe the sound of the recording: the explicit button. It shares the lookup, the ownership check, the four-minute
   * hold and the cover limit with the transcriber, and is answered 404 as if it did not exist while the feature is off. */
  router.post(
    '/reference/describe',
    (_req, _res, next) => (describeActive(hooks) ? next() : next('route')),
    hooks.auth,
    express.json({ limit: '16kb' }),
    async (req, res) => {
      let key: string;
      const user = hooks.user(req);
      try {
        if (typeof req.body.url !== 'string' || req.body.url.length > 12000)
          throw new Error('No recording.');
        key = identity(req.body.url);
      } catch {
        res.status(400).json({ error: 'Import a cover recording first.' });
        return;
      }
      try {
        const reference = await ownedReference(user, req.body.url, hooks);
        if (!reference) {
          res
            .status(404)
            .json({ error: 'That recording is not saved on your account. Import it again.' });
          return;
        }
        const known = cachedSound(reference);
        if (known) {
          res.json({ ...soundFields(known), cached: true });
          return;
        }
        const flying = flights.running(user, key);
        if (flying) {
          await answerSound(res, flying);
          return;
        }
        const claim = await claimReference(user, key);
        if (!claim) {
          res
            .status(409)
            .json({ error: 'This recording is already being worked on. Wait for it to finish.' });
          return;
        }
        try {
          await authorizeReference(user, claim.url, hooks);
          const keptSound = cachedSound(claim);
          if (keptSound) {
            res.json({ ...soundFields(keptSound), cached: true });
            return;
          }
          const heard = await listenTo(res, user, claim.url, hooks);
          if (!heard) return;
          await answerSound(res, flights.begin(user, key, heard));
        } finally {
          await releaseReference(user, key);
        }
      } catch (error) {
        if (res.headersSent) return;
        if (error instanceof ReferenceOwnershipError) {
          res.status(400).json({ error: error.message });
          return;
        }
        res.status(502).json({ error: soundFailure });
      }
    },
  );
  return router;
}
