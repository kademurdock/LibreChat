import { z } from 'zod';
import axios from 'axios';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import type { Analysis, Continuity, Line, Meter, Word } from './types';
import type { Brief } from './prompt';
import { analysisFormat, analysisPrompt, readAnalysis } from './prompt';

export const visionModel = (): string =>
  process.env.KADE_DESCRIPTION_MODEL || 'google/gemini-3.8-flash';
export const voiceBase = (): string =>
  process.env.KADE_TTS_PROXY_URL || 'https://inworld-tts-proxy-production.up.railway.app';
export const userAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Deepgram Nova-3, multilingual price (the higher of its two), per minute of audio. */
export const transcriptionPerMinute = 0.0052;
/** Fish Audio S2 is billed per UTF-8 byte; Inworld's overage price is lower, so this covers both. */
export const speechPerByte: number = 15 / 1e6;

const speechSchema = z.object({
  metadata: z.object({ duration: z.number().nonnegative().optional() }).optional(),
  results: z.object({
    channels: z.array(
      z.object({
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
  choices: z.array(
    z.object({
      finish_reason: z.string().nullable().optional(),
      message: z.object({ content: z.string().nullable() }),
    }),
  ),
  usage: z
    .object({
      cost: z.number().nonnegative().optional(),
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
    })
    .optional(),
});
export type VoiceCatalog = {
  voices: string[];
  describe?: Record<string, string>;
  categories?: { name: string; voices: string[] }[];
};
let catalog: { at: number; data: VoiceCatalog } | undefined;
export async function voices(): Promise<VoiceCatalog> {
  if (catalog && Date.now() - catalog.at < 300000) return catalog.data;
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
  return data;
}

/** A provider failure that is worth one more try: no answer, a timeout, rate limit or 5xx. */
export function transient(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return error instanceof SyntaxError;
  const status = error.response?.status;
  return !status || [408, 409, 425, 429, 500, 502, 503, 504, 529].includes(status);
}

/** Runs a paid step at most `tries` times, waiting between attempts; permanent errors stop at once. */
export async function attempt<T>(
  tries: number,
  signal: AbortSignal,
  action: () => Promise<T>,
  retryable: (error: unknown) => boolean = transient,
): Promise<T> {
  for (let i = 1; ; i++) {
    signal.throwIfAborted();
    try {
      return await action();
    } catch (error) {
      if (i >= tries || signal.aborted || !retryable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2500 * i));
    }
  }
}

/** Describes a provider error in words without leaking request details. */
export function providerProblem(error: unknown, service: string): string {
  if (!axios.isAxiosError(error)) return `${service} returned something unusable.`;
  const status = error.response?.status;
  if (status === 401 || status === 403)
    return `${service} refused the account key (HTTP ${status}).`;
  if (status === 402) return `${service} needs its account balance topped up (HTTP 402).`;
  if (status === 429) return `${service} is busy right now (HTTP 429).`;
  return status
    ? `${service} did not complete the request (HTTP ${status}).`
    : `${service} could not be reached.`;
}

export async function transcribe(
  file: string,
  seconds: number,
  signal: AbortSignal,
  meter: Meter,
): Promise<Word[]> {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error('Dialogue timing is not configured.');
  const bytes = (await stat(file)).size;
  let words: Word[] = [];
  const reserve = (seconds / 60) * transcriptionPerMinute + 0.002;
  await attempt(2, signal, () =>
    meter('transcription', reserve, async () => {
      const response = await axios.post(
        'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&diarize=true&detect_language=true',
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
      const alternative = data.results.channels[0]?.alternatives[0];
      if (!alternative) throw new Error('Dialogue timing returned no result.');
      words = alternative.words
        .filter((word) => word.end > word.start)
        .map((word) => ({
          word: word.punctuated_word || word.word,
          start: word.start,
          end: word.end,
          speaker: word.speaker,
        }));
      const billed = data.metadata?.duration ?? seconds;
      return { costUSD: (billed / 60) * transcriptionPerMinute };
    }),
  );
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
};
export async function analyze(look: Look, signal: AbortSignal, meter: Meter): Promise<Analysis> {
  const key = process.env.OPENROUTER_KEY;
  if (!key) throw new Error('Video understanding is not configured.');
  const prompt = analysisPrompt(look.seconds, look.brief, look.state, look.lines, look.before);
  const video = (await readFile(look.file)).toString('base64');
  const reserve = (look.seconds * 400 * 1.5 + prompt.length * 0.5 + 12000 * 7.5) / 1e6 + 0.01;
  let result: Analysis | undefined;
  const retryable = (error: unknown) =>
    transient(error) || error instanceof SyntaxError || error instanceof z.ZodError;
  let tries = 0;
  await attempt(
    2,
    signal,
    () =>
      meter('vision', reserve, async () => {
        const response = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model: visionModel(),
            max_tokens: 12000,
            temperature: 0.3,
            provider: { max_price: { prompt: 1.5, completion: 7.5 } },
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'video_url',
                    video_url: { url: `data:video/mp4;base64,${video}` },
                    processing: 'static',
                  },
                  { type: 'text', text: prompt },
                ],
              },
            ],
            response_format: tries++ === 0 ? analysisFormat : { type: 'json_object' },
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
        if (!choice?.message.content || (choice.finish_reason && choice.finish_reason !== 'stop'))
          throw new SyntaxError('The visual description came back incomplete.');
        result = readAnalysis(choice.message.content, look.seconds, look.brief.detail);
        return { costUSD: cost };
      }),
    retryable,
  );
  if (!result) throw new Error('No visual description was returned.');
  return result;
}

/**
 * Speaks one description through the platform voice proxy. `speed` is the voice engine's own
 * rate (1 to 1.5), which sounds more natural than stretching the audio afterwards.
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
  const input = '[clear engaged audio description] ' + text;
  const reserve = Buffer.byteLength(input, 'utf8') * speechPerByte + 0.0005;
  await attempt(2, signal, () =>
    meter('speech', reserve, async () => {
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
        throw new Error('The selected voice did not return playable audio.');
      await writeFile(file, body);
      return { costUSD: Buffer.byteLength(input, 'utf8') * speechPerByte };
    }),
  );
}
