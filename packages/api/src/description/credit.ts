import type { Meter } from './types';
import { decibels, mix, sampleRate } from './mix';

/**
 * "Audio description by Kade-AI" (Sep 27 2026, Kade's ask): every described copy names the
 * platform that described it, as exposure, never as a request for money. The credit sits outside
 * the film at both ends, so it never talks over dialogue, music or the opening:
 *
 * - before the first frame: the opening sonic logo (logo 3), then the narrator says the start
 *   line;
 * - after the last frame: the closing logo (logo 4), then the end line, which names the website.
 *
 * The job's own narrator says both at the job's own speed. The platform's voice proxy already says
 * "Kade-AI" as "Kadie A I" and "kademurdock" as "Kadie Murdock" on every speech request, so the
 * lines are written plainly. A preview gets the start line only: its film has not ended.
 */
export const creditLines: Record<'start' | 'end', { written: string; said: string }> = {
  start: {
    written: 'Audio description by Kade-AI.',
    said: 'Audio description by Kade-AI.',
  },
  end: {
    written: 'Described by Kade-AI. More at kademurdock.com.',
    said: 'Described by Kade-AI. More at kademurdock dot com.',
  },
};

/** The file-wide comment tag of a credited MP4 and M4A (shown in Files, VLC and QuickTime info). */
export const creditComment = 'Audio description by Kade-AI, kademurdock.com';

/** Which ends carry the credit (KADE_DESCRIPTION_CREDIT): both (the default), the end only, or none. */
export type CreditWhere = 'both' | 'end' | 'off';
export function creditWhere(): CreditWhere {
  const value = (process.env.KADE_DESCRIPTION_CREDIT || '').trim().toLowerCase();
  return value === 'end' || value === 'off' ? value : 'both';
}

/**
 * The five sonic logo candidates made on Sep 27 2026 (api/server/assets/kade-ai-logo/logo-N.flac,
 * 48 kHz stereo) and how far into each the words begin, over its fading tail.
 */
export const logos: Record<number, { voiceAt: number; about: string }> = {
  1: { voiceAt: 1.0, about: 'music box sparkle' },
  2: { voiceAt: 1.1, about: 'harp into vibraphone' },
  3: { voiceAt: 1.1, about: 'the name tune' },
  4: { voiceAt: 1.8, about: 'chime melody' },
  5: { voiceAt: 0.95, about: 'chime shower' },
};
/**
 * Kade's choice (Sep 27 2026): logo 3, the celesta tune shaped like the name, opens the copy, and
 * logo 4, the chime melody, closes it.
 */
export const defaultLogos: Record<'start' | 'end', number> = { start: 3, end: 4 };

/**
 * One logo switch: a logo number (1 to 5), null for `none` (the words alone), or undefined when it
 * is unset or names no logo, so the next switch decides.
 */
function logoSetting(name: string): number | null | undefined {
  const value = (process.env[name] || '').trim().toLowerCase();
  if (!value) return undefined;
  if (value === 'none' || value === 'off' || value === '0') return null;
  const number = Number(value);
  return Number.isInteger(number) && logos[number] ? number : undefined;
}

/**
 * The logo before one end's words, or null for none: KADE_DESCRIPTION_LOGO_START (default 3) or
 * KADE_DESCRIPTION_LOGO_END (default 4), each 1 to 5 or `none`. KADE_DESCRIPTION_LOGO, the older
 * single switch, still sets both ends when an end's own switch is unset.
 */
export function logoChoice(which: 'start' | 'end'): number | null {
  const own = logoSetting(
    which === 'start' ? 'KADE_DESCRIPTION_LOGO_START' : 'KADE_DESCRIPTION_LOGO_END',
  );
  if (own !== undefined) return own;
  const both = logoSetting('KADE_DESCRIPTION_LOGO');
  return both !== undefined ? both : defaultLogos[which];
}

/** One end's sonic logo: its file, how far into it the words begin, and its name for the log. */
export type CreditLogo = { file: string; voiceAt: number; name: string };

/** What the engine needs to add the credit to a copy (engine.ts `Request.credit`). */
export type Credit = {
  /** `both`: the opening credit and the closing card; `end`: the closing card only. */
  where: 'both' | 'end';
  /**
   * The sonic logo before each end's words (`start`, `end`); an end without one (or whose file
   * cannot be read) has its words said alone.
   */
  logos?: { start?: CreditLogo; end?: CreditLogo };
  /**
   * The meter the credit's speech is booked through: the platform's included work, charged to
   * nobody (router.ts `includedMeter`). Absent: the job's own meter. Either way the engine books
   * it as the `credit` part of the run's cost breakdown.
   */
  meter?: Meter;
};

/** Where the words start when there is no logo, and the breath before the closing card. */
export const bareVoiceAt = 0.15;
export const endBreath = 0.6;
/** How far the logo eases down under the words, over how long, and what rings on after them. */
const duckDb = -4;
const duckRamp = 0.15;
const tailAfter = 0.45;
const softEnd = 0.3;

/**
 * Lays one credit line over the logo: `before` seconds of silence, then the logo (interleaved
 * stereo) scaled by `logoGain`, easing 4 dB down (150 ms) under the words; the words (mono,
 * already levelled) from `voiceAt` seconds into the logo; the logo's own tail, or 0.45 s after the
 * words, whichever is longer; and a 0.3 s soft end so nothing is cut mid-ring. `frames` pads the
 * result with silence to at least that many stereo frames. Returns the interleaved stereo and
 * where the words start.
 */
export function layCredit(input: {
  logo: Float32Array | null;
  logoGain: number;
  voice: Float32Array;
  voiceAt: number;
  before?: number;
  frames?: number;
}): { pcm: Float32Array; wordsAt: number } {
  const before = Math.round(Math.max(0, input.before ?? 0) * sampleRate);
  const logoFrames = input.logo ? Math.floor(input.logo.length / 2) : 0;
  const wordsAt = before + Math.round(Math.max(0, input.voiceAt) * sampleRate);
  const content = Math.max(
    before + logoFrames,
    wordsAt + input.voice.length + Math.round(tailAfter * sampleRate),
  );
  const frames = Math.max(content, Math.round(input.frames ?? 0));
  const pcm = new Float32Array(frames * 2);
  if (input.logo) pcm.set(input.logo.subarray(0, logoFrames * 2), before * 2);
  const at = wordsAt / sampleRate;
  mix(
    pcm,
    input.logoGain,
    [
      {
        start: at,
        end: at + input.voice.length / sampleRate,
        gain: decibels(duckDb),
        attack: duckRamp,
        release: duckRamp,
      },
    ],
    [{ at, pcm: input.voice }],
  );
  const fade = Math.min(Math.round(softEnd * sampleRate), content - before);
  for (let i = 0; i < fade; i++) {
    const gain = 0.5 + 0.5 * Math.cos((Math.PI * (i + 1)) / fade);
    const frame = content - fade + i;
    pcm[frame * 2] *= gain;
    pcm[frame * 2 + 1] *= gain;
  }
  return { pcm, wordsAt: at };
}
