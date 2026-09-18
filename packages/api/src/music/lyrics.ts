import axios from 'axios';
import express from 'express';
import FormData from 'form-data';
import mongoose from 'mongoose';
import type { Request, RequestHandler, Router } from 'express';

const transcriptVersion = 'gemini38-scribe2-lyrics-v1';
const geminiModel = 'gemini-3.8-flash';
const lyricPrompt =
  'Transcribe the complete sung lyrics from this audio, from beginning to end, in the original language. Use only words audibly present in this recording. Preserve repeated choruses, repetitions, contractions, and audible vocalizations. Do not summarize, translate, improve the writing, or fill gaps from memory. Mark genuinely unintelligible words [unclear]. Put each sung phrase on its own line, with a blank line between sections. Return only the lyric transcript, with no commentary, timestamps, or invented section labels.';
type Transcript = {
  transcript: string;
  seconds: number;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
};
type ScribeResult = { text: string };
type GeminiResult = {
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

async function geminiLyrics(buffer: Buffer, mime: string, seconds: number): Promise<Transcript> {
  const key = process.env.GEMINI_API_KEY || process.env.KADE_EMBED_GEMINI_KEY;
  if (!key || buffer.length > 14 * 1024 * 1024 || !mime.startsWith('audio/'))
    throw new Error('Use the alternate lyric transcriber for this recording.');
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
  const transcript = candidate?.content?.parts
    ?.filter((part) => !part.thought && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
  if (candidate?.finishReason !== 'STOP' || !transcript)
    throw new Error('No complete lyric transcript returned.');
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
  } catch {
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

type Reference = {
  user: string;
  key: string;
  url: string;
  transcript?: Transcript;
  transcriptVersion?: string;
  leaseUntil?: Date;
};
const schema = new mongoose.Schema<Reference>({
  user: String,
  key: String,
  url: String,
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
export async function registerMusicReference(user: string, url: string): Promise<void> {
  await References.updateOne({ user, key: identity(url) }, { $set: { url } }, { upsert: true });
}
type Hooks = {
  auth: RequestHandler;
  user: (req: Request) => string;
  savedSources: (user: string) => Promise<string[]>;
  refresh: (url: string) => Promise<string>;
  duration: (buffer: Buffer) => Promise<number>;
  transcribe: (buffer: Buffer, mime: string, seconds: number) => Promise<Transcript>;
};

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
        let reference = await References.findOne({ user, key }).lean();
        if (!reference) {
          const sources = await hooks.savedSources(user);
          const owned = sources.find((url) => {
            try {
              return identity(url) === key;
            } catch {
              return false;
            }
          });
          if (!owned) {
            res
              .status(404)
              .json({ error: 'That recording is not saved on your account. Import it again.' });
            return;
          }
          await registerMusicReference(user, owned);
          reference = await References.findOne({ user, key }).lean();
        }
        const warning =
          'Draft lyrics only: singing, backing vocals and instruments can cause wrong or missing words. Listen and correct the Lyrics box before generating. Add section tags where useful.';
        if (reference?.transcript && reference.transcriptVersion === transcriptVersion) {
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
            res.json({ ...claim.transcript, warning, cached: true });
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
          if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 360) {
            res.status(400).json({ error: 'Use a readable recording up to six minutes long.' });
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
          res.json({ ...result, warning, cached: false });
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
