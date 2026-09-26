import axios from 'axios';
import express from 'express';
import FormData from 'form-data';
import mongoose from 'mongoose';
import { logger } from '@librechat/data-schemas';
import type { Request, RequestHandler, Router } from 'express';
import type { MediaSite } from '../description/links';

/* v2 (Part 293, Sep 25 2026): Gemini now writes section tags, so untagged v1 drafts are not
 * served from the cache any more. */
const transcriptVersion = 'gemini38-tags-scribe2-lyrics-v2';
/* Flash on low thinking: the Sep 25 check found no word-accuracy gain from medium or Pro, and
 * medium once spent 7,863 thought tokens and hit MAX_TOKENS. */
const geminiModel = 'gemini-3.8-flash';
/* The tag instruction is TAG_PROMPT from the Sep 25 check (no accuracy loss detected; every
 * chorus tagged), with [Post-Chorus] added to the allowed labels. */
const lyricPrompt =
  'Transcribe the complete sung lyrics from this audio, from beginning to end, in the original language. Use only words audibly present in this recording. Preserve repeated choruses, repetitions, contractions, and audible vocalizations. Do not summarize, translate, improve the writing, or fill gaps from memory. Mark genuinely unintelligible words [unclear]. Put each sung phrase on its own line, with a blank line between sections. Put a section label on its own line before a section only where the music audibly marks a new section: [Verse], [Pre-Chorus], [Chorus], [Post-Chorus], [Bridge], [Intro] or [Outro]. A block whose words come back as a refrain is [Chorus]. Do not number the labels. Return only the lyric transcript with those labels, with no commentary or timestamps.';
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

/**
 * Keeps Gemini's labels to the allowed list: "[verse 2]" becomes "[Verse]", a label outside the
 * list ("[Interlude]") is dropped, and "[unclear]" on its own line stays. Lyric lines are never
 * touched.
 */
export function tidySectionTags(transcript: string): string {
  return transcript
    .split('\n')
    .flatMap((line) => {
      const label = /^\s*\[([^\]\n]{1,40})\]\s*$/.exec(line);
      if (!label) return [line];
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
        temperature: 0.1,
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

export async function transcribeMusicLyrics(
  buffer: Buffer,
  mime: string,
  seconds: number,
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
  refresh: (url: string) => Promise<string>;
  duration: (buffer: Buffer) => Promise<number | null>;
  transcribe: (buffer: Buffer, mime: string, seconds: number) => Promise<Transcript>;
};

/**
 * The sentence read aloud with a draft, by where it came from: Gemini's section tags are guesses
 * to check; the backup transcriber writes no tags at all, and the person is told so plainly.
 */
export function lyricsWarning(model: string | undefined): string {
  if (typeof model === 'string' && model.startsWith('gemini'))
    return 'Draft lyrics only: singing, backing vocals and instruments can cause wrong or missing words, and the section tags are guesses from the music. Listen, then correct the words and the tags in the Lyrics box before generating.';
  return 'Draft lyrics from the backup transcriber, so they have no section tags. Add tags such as [Verse] and [Chorus] yourself. Singing, backing vocals and instruments can cause wrong or missing words. Listen and correct the Lyrics box before generating.';
}

export function musicReferenceError(seconds: number | null | undefined): string | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0)
    return 'The recording could not be read. Import a readable audio file before generating.';
  if (seconds <= 360) return;
  const rounded = Math.round(seconds);
  return `This recording is ${Math.floor(rounded / 60)} minutes ${rounded % 60} seconds long. Covers support up to 6 minutes. Import a shorter recording or an excerpt; your original will not be trimmed automatically.`;
}

async function ownedReference(user: string, key: string, hooks: Pick<Hooks, 'savedSources'>) {
  const reference = await References.findOne({ user, key }).lean();
  if (reference) return reference;
  const sources = await hooks.savedSources(user);
  const owned = sources.find((url) => {
    try {
      return identity(url) === key;
    } catch {
      return false;
    }
  });
  if (!owned) return null;
  await registerMusicReference(user, owned);
  return References.findOne({ user, key }).lean();
}

export async function validateMusicReference(
  user: string,
  url: string,
  hooks: Pick<Hooks, 'savedSources' | 'refresh' | 'duration'>,
): Promise<string> {
  const key = identity(url);
  const reference = await ownedReference(user, key, hooks);
  if (!reference) throw new Error('That recording is not saved on your account. Import it again.');
  let refreshed: string;
  let seconds = reference.seconds;
  try {
    refreshed = await hooks.refresh(reference.url);
    if (seconds === undefined) {
      const audio = await axios.get<ArrayBuffer>(refreshed, {
        responseType: 'arraybuffer',
        maxRedirects: 0,
        maxContentLength: 20 * 1024 * 1024,
        timeout: 45000,
      });
      seconds = (await hooks.duration(Buffer.from(audio.data))) ?? undefined;
      await registerMusicReference(user, reference.url, seconds);
    }
  } catch {
    throw new Error(
      'Could not check the cover recording. No music request was sent. Import it again and retry.',
    );
  }
  const error = musicReferenceError(seconds);
  if (error) throw new Error(error);
  return refreshed;
}

export function createLyricsRouter(hooks: Hooks): Router {
  const router = express.Router();
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
        const reference = await ownedReference(user, key, hooks);
        if (!reference) {
          res
            .status(404)
            .json({ error: 'That recording is not saved on your account. Import it again.' });
          return;
        }
        if (reference?.transcript && reference.transcriptVersion === transcriptVersion) {
          const warning = lyricsWarning(reference.transcript.model);
          res.json({ ...reference.transcript, warning, cached: true });
          return;
        }
        const claim = await References.findOneAndUpdate(
          {
            user,
            key,
            $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: new Date() } }],
          },
          { $set: { leaseUntil: new Date(Date.now() + 240000) } },
          { new: true },
        ).lean();
        if (!claim) {
          res
            .status(409)
            .json({ error: 'This recording is already being transcribed. Wait for it to finish.' });
          return;
        }
        try {
          if (claim.transcript && claim.transcriptVersion === transcriptVersion) {
            res.json({
              ...claim.transcript,
              warning: lyricsWarning(claim.transcript.model),
              cached: true,
            });
            return;
          }
          const url = await hooks.refresh(claim.url);
          const audio = await axios.get<ArrayBuffer>(url, {
            responseType: 'arraybuffer',
            maxRedirects: 0,
            maxContentLength: 20 * 1024 * 1024,
            timeout: 45000,
          });
          const buffer = Buffer.from(audio.data);
          const seconds = await hooks.duration(buffer);
          const durationError = musicReferenceError(seconds);
          if (durationError || seconds === null) {
            res.status(400).json({ error: durationError });
            return;
          }
          const result = await hooks.transcribe(
            buffer,
            String(audio.headers['content-type'] || 'audio/mpeg'),
            seconds,
          );
          if (!result.transcript?.trim()) {
            res
              .status(422)
              .json({ error: 'No clear words were detected. Your existing lyrics are kept.' });
            return;
          }
          result.transcript = result.transcript.slice(0, 8000);
          await References.updateOne(
            { user, key },
            { $set: { transcript: result, transcriptVersion } },
          );
          res.json({ ...result, warning: lyricsWarning(result.model), cached: false });
        } finally {
          await References.updateOne({ user, key }, { $unset: { leaseUntil: 1 } });
        }
      } catch {
        if (res.headersSent) return;
        res.status(502).json({
          error:
            'Could not transcribe this recording. Your existing lyrics are kept. Try a clearer recording or type the words.',
        });
      }
    },
  );
  return router;
}
