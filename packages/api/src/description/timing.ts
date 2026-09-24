import type { Cue, Interval, Placement, Settings, Word } from './types';

export function mergeIntervals(intervals: Interval[], seconds: number, padding = 0): Interval[] {
  const ordered = intervals
    .filter(
      (item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start,
    )
    .map((item) => ({
      start: Math.max(0, item.start - padding),
      end: Math.min(seconds, item.end + padding),
    }))
    .filter((item) => item.end > item.start)
    .sort((a, b) => a.start - b.start);
  const result: Interval[] = [];
  for (const item of ordered) {
    const last = result[result.length - 1];
    if (last && item.start <= last.end + 0.12) last.end = Math.max(last.end, item.end);
    else result.push({ ...item });
  }
  return result;
}

export function gaps(blocked: Interval[], seconds: number): Interval[] {
  const result: Interval[] = [];
  let cursor = 0;
  for (const span of mergeIntervals(blocked, seconds)) {
    if (span.start - cursor >= 0.25) result.push({ start: cursor, end: span.start });
    cursor = Math.max(cursor, span.end);
  }
  if (seconds - cursor >= 0.25) result.push({ start: cursor, end: seconds });
  return result;
}

const inside = (point: number, spans: Interval[]) =>
  spans.some((span) => span.start < point && point < span.end);

/**
 * Finds the first gap in the soundtrack, from the moment the event appears until its last
 * sensible moment, that holds the narration at no more than the listener's fastest speed.
 * `base` is the narration's length at an ordinary 1x speaking rate.
 */
export function fitCue(
  cue: Cue,
  text: string,
  base: number,
  settings: Settings,
  blocked: Interval[],
  seconds: number,
): Placement | null {
  if (!Number.isFinite(base) || base <= 0) return null;
  for (const gap of gaps(blocked, seconds)) {
    const start = Math.max(gap.start, cue.at);
    const end = Math.min(gap.end, cue.until, seconds);
    const available = end - start - 0.08;
    if (available <= 0) continue;
    const rate = Math.max(settings.rate, base / available);
    if (rate > settings.maxRate + 1e-9) continue;
    return {
      at: start,
      outputAt: start,
      duration: base / rate,
      rate,
      text,
      pauseAt: start,
      pause: 0,
      inserted: false,
      shortened: false,
      importance: cue.importance,
    };
  }
  return null;
}

/**
 * Picks where the picture may freeze for a description that cannot fit: the model's own
 * suggestion when it is clear of speech and important sound, otherwise the best nearby break
 * between words, preferring the end of a sentence and a longer breath.
 */
export function pausePoint(cue: Cue, words: Word[], hard: Interval[], seconds: number): number {
  const latest = Math.min(seconds - 0.05, cue.until + 4);
  const target = Math.min(Math.max(cue.pauseAt ?? cue.at, cue.at), latest);
  const speaking = (point: number) =>
    words.some((word) => word.start - 0.03 < point && point < word.end + 0.03);
  if (!speaking(target) && !inside(target, hard)) return Math.max(0.02, target);
  const ordered = [...words].sort((a, b) => a.start - b.start);
  let best: { point: number; score: number } | null = null;
  for (let i = 0; i < ordered.length; i++) {
    const next = ordered[i + 1]?.start ?? seconds;
    const breath = Math.max(0, next - ordered[i].end);
    const point = ordered[i].end + Math.min(0.04, breath / 2);
    if (point < cue.at || point > latest || inside(point, hard)) continue;
    const score =
      (/[.!?…]["')\]]?$/.test(ordered[i].word) ? 3 : 0) +
      Math.min(1.5, breath) * 2 -
      Math.abs(point - target) * 0.8 -
      Math.max(0, point - cue.until);
    if (!best || score > best.score) best = { point, score };
  }
  if (best) return best.point;
  let point = Math.max(0.02, target);
  for (const span of mergeIntervals([...words, ...hard], seconds).filter((s) => s.end > point))
    if (span.start < point + 0.01) point = span.end + 0.01;
  return Math.min(point, seconds - 0.02);
}

/**
 * Extended-mode placement: the narration starts at the pause point, uses whatever quiet
 * stretch follows it, and the picture freezes only for the part that still does not fit.
 */
export function pauseCue(
  cue: Cue,
  text: string,
  base: number,
  settings: Settings,
  at: number,
  blocked: Interval[],
): Placement {
  const duration = base / settings.rate;
  const next = blocked
    .filter((span) => span.end > at + 0.01)
    .reduce((earliest, span) => Math.min(earliest, Math.max(at, span.start)), Infinity);
  const run = Math.max(0, Math.min(duration, next - at - 0.1));
  const partial = run >= 0.6;
  const freeze = partial ? duration - run : duration;
  return {
    at,
    outputAt: at,
    duration,
    rate: settings.rate,
    text,
    pauseAt: partial ? at + run : at,
    pause: freeze > 0.05 ? freeze + 0.16 : 0,
    inserted: freeze > 0.05,
    shortened: false,
    importance: cue.importance,
  };
}

/** Converts section source times to output times once frozen pauses are added. */
export function outputTimeline(placements: Placement[]): Placement[] {
  const ordered = [...placements].sort((a, b) => a.at - b.at || a.pauseAt - b.pauseAt);
  return ordered.map((item, index) => ({
    ...item,
    outputAt:
      item.at +
      ordered.reduce(
        (shift, other, j) =>
          j !== index && (other.pauseAt < item.at || (other.pauseAt === item.at && j < index))
            ? shift + other.pause
            : shift,
        0,
      ),
  }));
}

/** Maps a section source time to its output time. */
export function toOutput(time: number, placements: Placement[]): number {
  return placements.reduce(
    (shift, item) => (item.pauseAt <= time ? shift + item.pause : shift),
    time,
  );
}

export function tempoFilters(rate: number): string {
  if (!Number.isFinite(rate) || rate < 1 || rate > 3) throw new Error('Invalid narration rate.');
  return rate > 2 ? `atempo=2,atempo=${(rate / 2).toFixed(6)}` : `atempo=${rate.toFixed(6)}`;
}

/** Splits a long video at a quiet moment near every 90 seconds so nobody is cut off mid-line. */
export function planSections(
  seconds: number,
  words: Word[],
  target = 90,
  shortest = 60,
  longest = 120,
): Interval[] {
  const ordered = [...words].sort((a, b) => a.start - b.start);
  const sections: Interval[] = [];
  let cursor = 0;
  while (seconds - cursor > longest) {
    const remaining = seconds - cursor;
    const aim = remaining < target * 2 ? cursor + remaining / 2 : cursor + target;
    const low = remaining < target * 2 ? aim - 15 : cursor + shortest;
    const high = remaining < target * 2 ? aim + 15 : cursor + longest;
    let best: { point: number; score: number } | null = null;
    for (let i = 0; i + 1 < ordered.length; i++) {
      const quiet = ordered[i + 1].start - ordered[i].end;
      const point = (ordered[i].end + ordered[i + 1].start) / 2;
      if (quiet < 0.3 || point < low || point > high) continue;
      const score = Math.min(quiet, 4) - Math.abs(point - aim) * 0.02;
      if (!best || score > best.score) best = { point, score };
    }
    let boundary = best?.point ?? aim;
    if (!best) {
      const word = ordered.find((item) => item.start < boundary && boundary < item.end);
      if (word) boundary = word.end;
    }
    sections.push({ start: cursor, end: boundary });
    cursor = boundary;
  }
  sections.push({ start: cursor, end: seconds });
  return sections;
}
