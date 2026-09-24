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

const sentenceEnd = (word: string) => /[.!?…]["')\]]?$/.test(word);

/** Seconds kept free after one description before another may start. */
export const narrationGap = 0.35;
/** Seconds kept free before speech starts again, so the soundtrack can come back up. */
const clearance = 0.5;

/**
 * Finds where a description fits in the soundtrack, from the moment the event appears until its
 * last sensible moment, at no more than the listener's fastest speed. Among the gaps that fit, it
 * takes the first one unless a gap starting within 3 seconds of it holds the narration near her
 * usual speed and leaves room before the next line. `base` is the narration's length at 1x.
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
  const fits: { start: number; rate: number; room: number }[] = [];
  for (const gap of gaps(blocked, seconds)) {
    const start = Math.max(gap.start, cue.at);
    const end = Math.min(gap.end, cue.until, seconds);
    const available = end - start - 0.08;
    if (available <= 0) continue;
    const rate = Math.max(settings.rate, base / available);
    if (rate > settings.maxRate + 1e-9) continue;
    fits.push({ start, rate, room: gap.end - start - base / rate });
  }
  const first = fits[0];
  if (!first) return null;
  const easy = fits.find(
    (item) =>
      item.start <= first.start + 3 &&
      item.rate <= settings.rate * 1.15 + 1e-9 &&
      item.room >= clearance,
  );
  const { start, rate } = easy ?? first;
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

/** A freeze point inside the breath after a word: its middle, at most 0.2 s after the word. */
const breathPoint = (end: number, next: number) => end + Math.min(0.2, Math.max(0, next - end) / 2);

/**
 * Picks where the picture may freeze for a description that cannot fit: the model's own
 * suggestion when it is clear of speech and important sound (moved onto a nearby scene cut, or
 * into the middle of a short breath), otherwise the best nearby break, preferring the end of a
 * sentence, a longer breath and a scene cut.
 */
export function pausePoint(
  cue: Cue,
  words: Word[],
  hard: Interval[],
  seconds: number,
  cuts: number[] = [],
): number {
  const latest = Math.min(seconds - 0.05, cue.until + 4);
  const target = Math.min(Math.max(cue.pauseAt ?? cue.at, cue.at), latest);
  const ordered = [...words].sort((a, b) => a.start - b.start);
  const speaking = (point: number) =>
    ordered.some((word) => word.start - 0.03 < point && point < word.end + 0.03);
  const allowed = (point: number) => point >= cue.at && point <= latest && !inside(point, hard);
  const clear = (point: number) => allowed(point) && !speaking(point);
  if (!speaking(target) && !inside(target, hard)) {
    const cut = cuts
      .filter((time) => Math.abs(time - target) <= 0.5 && clear(time))
      .sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
    if (cut !== undefined) return Math.max(0.02, cut);
    const before = ordered.filter((word) => word.end <= target).at(-1);
    const after = ordered.find((word) => word.start >= target);
    if (before && after) {
      const edge = Math.min(0.1, (after.start - before.end) / 2);
      const point = Math.min(Math.max(target, before.end + edge), after.start - edge);
      if (allowed(point)) return point;
    }
    return Math.max(0.02, target);
  }
  const candidates: { point: number; score: number }[] = [
    ...ordered.map((word, i) => {
      const next = ordered[i + 1]?.start ?? seconds;
      return {
        point: breathPoint(word.end, next),
        score: (sentenceEnd(word.word) ? 3 : 0) + Math.min(1.5, Math.max(0, next - word.end)) * 2,
      };
    }),
    ...cuts.filter(clear).map((point) => ({ point, score: 2.5 })),
  ]
    .filter((item) => allowed(item.point))
    .map((item) => ({
      point: item.point,
      score: item.score - Math.abs(item.point - target) * 0.8 - Math.max(0, item.point - cue.until),
    }));
  const best = candidates.reduce<{ point: number; score: number } | null>(
    (top, item) => (!top || item.score > top.score ? item : top),
    null,
  );
  if (best) return best.point;
  let point = Math.max(0.02, target);
  for (const span of mergeIntervals([...words, ...hard], seconds).filter((s) => s.end > point))
    if (span.start < point + 0.01) point = span.end + 0.01;
  return Math.min(point, seconds - 0.02);
}

/** Seconds of frozen picture kept after the narration so it does not butt into the next line. */
export const pauseTail = 0.35;

/**
 * Extended-mode placement: the narration starts at the pause point, uses whatever quiet
 * stretch follows it before the next blocked sound or the section end, and the picture freezes
 * only for the part that still does not fit.
 */
export function pauseCue(
  cue: Cue,
  text: string,
  base: number,
  settings: Settings,
  at: number,
  blocked: Interval[],
  seconds: number = Infinity,
): Placement {
  const duration = base / settings.rate;
  const next = blocked
    .filter((span) => span.end > at + 0.01)
    .reduce(
      (earliest, span) => Math.min(earliest, Math.max(at, span.start)),
      Math.max(at, seconds - 0.05),
    );
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
    pause: freeze > 0.05 ? freeze + pauseTail : 0,
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

/**
 * Moves each description onto a scene cut that follows its time within 0.8 s, since the model
 * samples only a few frames a second. Never earlier, so nothing is described before it appears.
 */
export function snapToCuts(cues: Cue[], cuts: number[]): Cue[] {
  if (!cuts.length) return cues;
  return cues.map((cue) => {
    const cut = cuts.find((time) => time >= cue.at && time <= cue.at + 0.8);
    if (cut === undefined || cut === cue.at) return cue;
    return {
      ...cue,
      at: cut,
      until: Math.max(cue.until, cut + 0.5),
      pauseAt: cue.pauseAt === undefined ? undefined : Math.max(cue.pauseAt, cut),
    };
  });
}

export type Variant = 'full' | 'short';
export type Arranged = { index: number; variant: Variant; placement: Placement };
/** Why a description was left out of the section. */
export type Leftover = 'room' | 'minor' | 'priority';
export type Arrangement = { placed: Arranged[]; left: { index: number; reason: Leftover }[] };

const textOf = (cue: Cue, variant: Variant) => (variant === 'full' ? cue.text : cue.shortText);
const spanOf = (placement: Placement): Interval =>
  placement.pause
    ? { start: placement.at - 0.05, end: placement.pauseAt + 0.05 }
    : {
        start: placement.at - (narrationGap - 0.08),
        end: placement.at + placement.duration + narrationGap,
      };

/**
 * Places a section's descriptions in the order their events happen. Each one takes its full
 * text near the listener's usual speed if it can, then the short text, then either text up to
 * her fastest speed. A description is not allowed to take the room a later, more important one
 * needs; it is shortened, paused for (extended mode), or left out instead. `length` gives each
 * text's length at 1x, or undefined when that text cannot be used.
 */
export function arrange(input: {
  cues: Cue[];
  length: (index: number, variant: Variant) => number | undefined;
  settings: Settings;
  blocked: Interval[];
  hard: Interval[];
  words: Word[];
  seconds: number;
  cuts?: number[];
  /** A text already voiced for a cue whose measured length is close to its estimate: try it first. */
  prefer?: (index: number) => Variant | undefined;
}): Arrangement {
  const { cues, settings, seconds } = input;
  const order = cues
    .map((cue, index) => ({ cue, index }))
    .sort((a, b) => a.cue.at - b.cue.at || b.cue.importance - a.cue.importance);
  const lengths = (index: number): Partial<Record<Variant, number>> => {
    const cue = cues[index];
    const full = input.length(index, 'full');
    const short =
      cue.shortText && cue.shortText !== cue.text ? input.length(index, 'short') : undefined;
    return {
      ...(full !== undefined && full > 0 ? { full } : {}),
      ...(short !== undefined && short > 0 ? { short } : {}),
    };
  };
  const tries = (index: number): [Variant, number][] => {
    const easy = Math.min(settings.maxRate, settings.rate * 1.2);
    const sticky = input.prefer?.(index);
    const all: [Variant, number][] = sticky
      ? [
          [sticky, easy],
          [sticky, settings.maxRate],
          [sticky === 'full' ? 'short' : 'full', easy],
          [sticky === 'full' ? 'short' : 'full', settings.maxRate],
        ]
      : [
          ['full', easy],
          ['short', easy],
          ['full', settings.maxRate],
          ['short', settings.maxRate],
        ];
    const known = lengths(index);
    return all.filter(
      ([variant, limit], i) =>
        known[variant] !== undefined &&
        !all.slice(0, i).some(([other, earlier]) => other === variant && earlier === limit),
    );
  };
  const spans: Interval[] = [];
  let floor = 0;
  const fit = (index: number, variant: Variant, limit: number, taken: Interval[], from: number) =>
    fitCue(
      cues[index],
      textOf(cues[index], variant),
      lengths(index)[variant] ?? NaN,
      { ...settings, maxRate: limit },
      [...input.blocked, ...taken, { start: 0, end: from }],
      seconds,
    );
  const fitsAnywhere = (index: number, taken: Interval[], from: number) =>
    tries(index).some(([variant]) => !!fit(index, variant, settings.maxRate, taken, from));
  const hurts = (position: number, span: Interval) =>
    order
      .slice(position + 1)
      .some(
        (later) =>
          later.cue.importance > order[position].cue.importance &&
          fitsAnywhere(later.index, spans, floor) &&
          !fitsAnywhere(later.index, [...spans, span], Math.max(floor, span.end)),
      );
  const placed: Arranged[] = [];
  const left: Arrangement['left'] = [];
  order.forEach(({ cue, index }, position) => {
    let chosen: Arranged | null = null;
    let crowded = false;
    for (const [variant, limit] of tries(index)) {
      const placement = fit(index, variant, limit, spans, floor);
      if (!placement) continue;
      if (hurts(position, spanOf(placement))) {
        crowded = true;
        continue;
      }
      chosen = { index, variant, placement: { ...placement, shortened: variant === 'short' } };
      break;
    }
    const full = lengths(index).full;
    if (!chosen && settings.mode === 'extended' && cue.importance >= 2 && full !== undefined) {
      const point = pausePoint(cue, input.words, [...input.hard, ...spans], seconds, input.cuts);
      chosen = {
        index,
        variant: 'full',
        placement: pauseCue(
          cue,
          cue.text,
          full,
          settings,
          point,
          [...input.blocked, ...spans],
          seconds,
        ),
      };
    }
    if (!chosen) {
      const reason: Leftover = crowded
        ? 'priority'
        : settings.mode === 'extended' && cue.importance === 1
          ? 'minor'
          : 'room';
      left.push({ index, reason });
      return;
    }
    const span = spanOf(chosen.placement);
    spans.push(span);
    floor = Math.max(floor, span.end);
    placed.push(chosen);
  });
  return { placed, left };
}

/** A place a section may end, with how good a place it is. */
type Boundary = { point: number; score: number };

/**
 * Candidate section boundaries. The end of a sentence inside speech is best, since quiet
 * stretches are where descriptions go and should stay whole; a long quiet stretch is cut just
 * after its last word so the silence opens the next section. Scene cuts between words are good
 * too, unless they split a long quiet stretch.
 */
function boundaries(words: Word[], cuts: number[], seconds: number): Boundary[] {
  const result: Boundary[] = [];
  for (let i = 0; i + 1 < words.length; i++) {
    const quiet = words[i + 1].start - words[i].end;
    if (quiet < 0.3) continue;
    if (quiet < 1.5)
      result.push({
        point: (words[i].end + words[i + 1].start) / 2,
        score: (sentenceEnd(words[i].word) ? 3 : 1) + Math.min(quiet, 1.2),
      });
    else result.push({ point: words[i].end + 0.3, score: 2 });
  }
  for (const cut of cuts) {
    if (cut <= 0 || cut >= seconds) continue;
    const next = firstFrom(words, cut);
    const previous = words[next - 1];
    const following = words[next];
    if (previous && previous.end + 0.05 > cut) continue;
    if (following && following.start - 0.05 < cut) continue;
    const before = previous?.end ?? 0;
    const after = following?.start ?? seconds;
    const score = after - before < 1.5 ? 3.5 : cut - before <= 0.6 ? 3 : 1.5;
    result.push({ point: cut, score });
  }
  return result;
}

/** Index of the first word (sorted by start) that starts at or after `time`. */
function firstFrom(words: Word[], time: number): number {
  let low = 0;
  let high = words.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (words[middle].start < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Splits a long video near every 90 seconds at a point where nobody is cut off mid-word:
 * preferably a sentence end or a scene cut, and near a chapter start when there is one.
 */
export function planSections(
  seconds: number,
  words: Word[],
  target = 90,
  shortest = 60,
  longest = 120,
  marks: { cuts?: number[]; chapters?: number[] } = {},
): Interval[] {
  const ordered = [...words].sort((a, b) => a.start - b.start);
  const candidates = boundaries(ordered, marks.cuts ?? [], seconds);
  const chapters = marks.chapters ?? [];
  const nearChapter = (point: number) =>
    chapters.reduce(
      (bonus, start) => Math.max(bonus, 2 * Math.max(0, 1 - Math.abs(point - start) / 15)),
      0,
    );
  const sections: Interval[] = [];
  let cursor = 0;
  while (seconds - cursor > longest) {
    const remaining = seconds - cursor;
    const aim = remaining < target * 2 ? cursor + remaining / 2 : cursor + target;
    const low = remaining < target * 2 ? aim - 15 : cursor + shortest;
    const high = remaining < target * 2 ? aim + 15 : cursor + longest;
    let best: Boundary | null = null;
    for (const candidate of candidates) {
      if (candidate.point < low || candidate.point > high) continue;
      const score =
        candidate.score - Math.abs(candidate.point - aim) * 0.02 + nearChapter(candidate.point);
      if (!best || score > best.score) best = { point: candidate.point, score };
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
