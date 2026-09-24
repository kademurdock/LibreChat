import type { Analysis, Line, Meter, Word } from './types';
import type { Providers } from './engine';
import type { Look } from './providers';
import { command, ffmpeg } from './media';

/** What the rehearsal "hears": a few words at the start, so dialogue timing has something to avoid. */
const heard = ['This', 'is', 'a', 'rehearsal.'];
/** Narration length per UTF-8 byte at 1x, the engine's own starting guess. */
const secondsPerByte = 0.0625;

/** The first clip time with at least two seconds free of dialogue, or the end of the last line. */
export function quietSpot(lines: Line[], seconds: number): number {
  let from = 0.5;
  for (const line of [...lines].sort((a, b) => a.start - b.start)) {
    if (line.start - from >= 2) break;
    from = Math.max(from, line.end + 0.3);
  }
  return Math.max(0, Math.min(from, seconds - 1));
}

async function transcribe(
  _file: string,
  seconds: number,
  _signal: AbortSignal,
  _meter: Meter,
  hints?: { onLanguage?: (code: string) => void },
): Promise<Word[]> {
  hints?.onLanguage?.('en');
  return heard
    .map((word, i) => ({ start: 0.3 + i * 0.35, end: 0.6 + i * 0.35, word, speaker: 0 }))
    .filter((word) => word.end <= seconds);
}

async function analyze(look: Look): Promise<Analysis> {
  const at = quietSpot(look.lines, look.seconds);
  const text = `Rehearsal description ${(look.brief.position?.index ?? 0) + 1}.`;
  return {
    kind: 'other',
    setting: 'A rehearsal with a test tone.',
    people: [],
    speakers: [],
    protectedSounds: [],
    cues: look.brief.survey
      ? []
      : [
          {
            at,
            until: Math.min(look.seconds, at + 3),
            pauseAt: at,
            text,
            shortText: text,
            importance: 3,
          },
        ],
  };
}

/** A 24 kHz mono tone at about -12 dBFS, as long as the words would take to say, made locally. */
async function synthesize(
  text: string,
  _voice: string,
  _session: string,
  file: string,
  speed: number,
  signal: AbortSignal,
): Promise<void> {
  const seconds = Math.min(
    12,
    Math.max(0.5, (Buffer.byteLength(text, 'utf8') * secondsPerByte) / Math.max(1, speed)),
  );
  await command(
    ffmpeg(),
    [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=523:sample_rate=24000:duration=${seconds.toFixed(2)}`,
      '-af',
      'volume=2',
      '-ac',
      '1',
      '-ar',
      '24000',
      '-c:a',
      'pcm_s16le',
      file,
    ],
    signal,
  );
}

/**
 * Stand-ins for the paid services, for a free end-to-end rehearsal through real storage, the
 * real media tools and the real notices: fixed words, one numbered description per section,
 * and a test tone for the narrator. None of them calls the meter or the network.
 */
export const rehearsalProviders: Providers = { transcribe, analyze, synthesize };
