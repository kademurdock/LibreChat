import axios from 'axios';
import { sampleRate } from './mix';
import { userAgent } from './providers';

/**
 * Hears back one narration take that ran long for its words (engine.ts `voice`), so a voice that
 * said a line twice is told apart from a slow read. Oct 18 2026, Napoleon: Kade's Fish voice said
 * a credit card three times in one take and every length limit let it through.
 *
 * MiMo Flash on OpenRouter, the listener Kade asked for (not Google, not Deepgram), on the
 * zero-retention hosts that really hear audio (Makora, Novita; DeepInfra and Venice answer without
 * hearing it). About $0.00001 a take, under two seconds. Any failure answers null and the engine
 * falls back to length alone. KADE_VOICE_LISTEN=0 turns it off; KADE_VOICE_LISTEN_HOSTS (comma
 * list) and KADE_VOICE_LISTEN_MODEL override the hosts and the model.
 */
const listenRate = 16000;
const prompt =
  'Transcribe every word spoken in this audio exactly as heard. If a word or phrase is said more than once, write it each time it is said. Reply with the words only.';

/** A mono 16-bit WAV at 16 kHz, enough for speech and a third of the bytes. */
export function speechWav(pcm: Float32Array): Buffer {
  const step = sampleRate / listenRate;
  const frames = Math.floor(pcm.length / step);
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + frames * 2, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(listenRate, 24);
  wav.writeUInt32LE(listenRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    const from = Math.floor(i * step);
    let sum = 0;
    for (let j = 0; j < step; j++) sum += pcm[from + j] ?? 0;
    const value = Math.max(-1, Math.min(1, sum / step));
    wav.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return wav;
}

type Reply = {
  choices?: { finish_reason?: string; message?: { content?: string } }[];
  usage?: { prompt_tokens?: number };
};

/** The words in one take, or null when nobody could listen. */
export async function listen(pcm: Float32Array, signal: AbortSignal): Promise<string | null> {
  if (process.env.KADE_VOICE_LISTEN === '0') return null;
  const key = process.env.OPENROUTER_KEY;
  const seconds = pcm.length / sampleRate;
  if (!key || seconds < 0.2 || seconds > 120) return null;
  const hosts = (process.env.KADE_VOICE_LISTEN_HOSTS || 'Makora,Novita')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  try {
    const { data } = await axios.post<Reply>(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: process.env.KADE_VOICE_LISTEN_MODEL || 'xiaomi/mimo-v2.6-flash',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'input_audio',
                input_audio: { data: speechWav(pcm).toString('base64'), format: 'wav' },
              },
            ],
          },
        ],
        reasoning: { enabled: false },
        temperature: 0,
        max_tokens: 400,
        provider: {
          only: hosts,
          allow_fallbacks: true,
          zdr: true,
          data_collection: 'deny',
          max_price: { prompt: 0.14, completion: 0.28 },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'User-Agent': userAgent,
        },
        signal,
        timeout: 15000,
        maxRedirects: 0,
        maxContentLength: 256 * 1024,
      },
    );
    const choice = data.choices?.[0];
    const text = choice?.message?.content?.trim();
    /**
     * A host that never heard the audio counts only the prompt's text: 46 tokens on Oct 20 2026,
     * against 57 for a one-second take heard on Makora and Novita (about 6 more a second).
     */
    const heard = (data.usage?.prompt_tokens ?? 0) >= 48 + 3 * seconds;
    if (!text || !heard || choice?.finish_reason === 'content_filter') return null;
    return text;
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}
