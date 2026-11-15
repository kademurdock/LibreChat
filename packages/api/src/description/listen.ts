import axios from 'axios';
import { sampleRate } from './mix';
import { userAgent } from './providers';

/**
 * Hears back one narration take that ran long for its words (engine.ts `voice`), so a voice that
 * said a line twice is told apart from a slow read. Oct 18 2026, Napoleon: Kade's Fish voice said
 * a credit card three times in one take and every length limit let it through.
 *
 * MiMo Flash on OpenRouter, the listener Kade asked for (not Google, not Deepgram), on hosts that
 * really hear audio (DeepInfra and Venice answer without hearing it). About $0.00001 a take. Any
 * failure answers null and the engine falls back to length alone. KADE_VOICE_LISTEN=0 turns it
 * off; KADE_VOICE_LISTEN_HOSTS (comma list, asked in that order) and KADE_VOICE_LISTEN_MODEL
 * override the hosts and the model.
 *
 * Nov 14 2026: Novita no longer serves MiMo, and Makora's price rose to $0.18 and $0.36 per million
 * tokens, over the $0.14 and $0.28 cap. By OpenRouter's endpoint list that day no host could take
 * the call (not tried live), so every take fell back to length alone, with nothing in the log.
 * The cap is now Makora's price. Makora keeps nothing and waited 0.5 s. `log` hears which host
 * answered, or why none did, for the server log (engine.ts passes the job's log).
 *
 * Who may keep a take (Nov 14 2026 review). A take reads out the description of the job's video,
 * which can carry names and words heard in it, and that video can be a person's own upload. So a
 * take keeps `zdr` (Makora alone by default) unless the job's source may be kept (`listenMayKeep`:
 * a YouTube video, already public). Then, under Kade's rule, `zdr` is
 * dropped and Xiaomi follows Makora, at $0.14 and $0.28: it keeps prompts 30 days and never trains,
 * and it is slow (a 3.9 s wait, 14.5 s at the slow end, against the 15 s limit).
 * `data_collection: 'deny'` keeps out every host that trains on what it is sent, either way
 * (OpenRouter applies `data_collection` to training and `zdr` to keeping).
 */
const listenRate = 16000;
const zeroRetentionHosts = 'Makora';
const keptHosts = 'Makora,Xiaomi';
const listenPrice = { prompt: 0.18, completion: 0.36 };

/**
 * Whether a take of this job's video may go to a host that keeps prompts: only a YouTube video,
 * which is public already. A person's upload stays on zero retention, and so does every Library
 * video: a shared shelf can still hold someone's own home video. So does a source this code does
 * not know.
 */
export function listenMayKeep(source: string | undefined): boolean {
  return source === 'youtube';
}
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
  provider?: string;
  choices?: { finish_reason?: string; message?: { content?: string } }[];
  usage?: { prompt_tokens?: number };
};

/** Why a listen failed, in a few words for the log: the status and OpenRouter's own short reason. */
function listenFailure(error: unknown): string {
  if (!axios.isAxiosError(error)) return 'an error';
  const status = error.response?.status;
  if (!status) return error.code || 'no answer';
  const said = (error.response?.data as { error?: { message?: unknown } } | undefined)?.error
    ?.message;
  return typeof said === 'string' && said.trim()
    ? `HTTP ${status}: ${said.trim().slice(0, 60)}`
    : `HTTP ${status}`;
}

/** The words in one take, or null when nobody could listen. */
export async function listen(
  pcm: Float32Array,
  signal: AbortSignal,
  log: (message: string) => void = () => {},
  { mayKeep = false }: { mayKeep?: boolean } = {},
): Promise<string | null> {
  if (process.env.KADE_VOICE_LISTEN === '0') return null;
  const key = process.env.OPENROUTER_KEY;
  const seconds = pcm.length / sampleRate;
  if (!key || seconds < 0.2 || seconds > 120) return null;
  const hosts = (process.env.KADE_VOICE_LISTEN_HOSTS || (mayKeep ? keptHosts : zeroRetentionHosts))
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
        /* `order` asks the hosts in the order given; `only` keeps every other host out. */
        provider: {
          order: hosts,
          only: hosts,
          allow_fallbacks: true,
          ...(mayKeep ? {} : { zdr: true }),
          data_collection: 'deny',
          max_price: { ...listenPrice },
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
    const host = data.provider || 'a host that gave no name';
    if (!text || !heard || choice?.finish_reason === 'content_filter') {
      log(
        `listen: ${host} answered without the words (${!heard ? `${data.usage?.prompt_tokens ?? 'no'} prompt tokens` : choice?.finish_reason || 'empty'}); length decides`,
      );
      return null;
    }
    log(`listen: ${host} heard the take (${data.usage?.prompt_tokens} prompt tokens)`);
    return text;
  } catch (error) {
    if (signal.aborted) throw error;
    log(`listen: no host heard the take (${listenFailure(error)}); length decides`);
    return null;
  }
}
