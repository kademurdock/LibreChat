import type { Cue, Interval, Line, Placement, Settings, Word } from './types';

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
/** The gap left after another description's words before a freeze may start. */
const breath = 0.05;

/**
 * Finds where a description fits in the soundtrack, from the moment the event appears until its
 * last sensible moment, at no more than the listener's fastest speed. Among the gaps that fit, it
 * takes the first one unless a gap starting within 3 seconds of it holds the narration near her
 * usual speed and leaves room before the next line. `base` is the narration's length at 1x.
 * `late` (pause mode, `lateWindow`) lets the narration start as late as `late.start` and run on
 * to `late.end` instead of the cue's `until`, as long as its gap is free.
 */
export function fitCue(
  cue: Cue,
  text: string,
  base: number,
  settings: Settings,
  blocked: Interval[],
  seconds: number,
  late?: Interval,
): Placement | null {
  if (!Number.isFinite(base) || base <= 0) return null;
  const fits: { start: number; rate: number; room: number }[] = [];
  const lastStart = late?.start ?? Infinity;
  const lastEnd = late?.end ?? cue.until;
  for (const gap of gaps(blocked, seconds)) {
    const start = Math.max(gap.start, cue.at);
    if (start > lastStart + 1e-9) break;
    const end = Math.min(gap.end, lastEnd, seconds);
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
 * sentence, a longer breath and a scene cut. `earliest` keeps the freeze clear of the section
 * start, so the soundtrack has room to fade before it stops.
 */
export function pausePoint(
  cue: Cue,
  words: Word[],
  hard: Interval[],
  seconds: number,
  cuts: number[] = [],
  earliest: number = 0.02,
): number {
  const latest = Math.min(seconds - 0.05, cue.until + 4);
  const target = Math.min(Math.max(cue.pauseAt ?? cue.at, cue.at, earliest), latest);
  const ordered = [...words].sort((a, b) => a.start - b.start);
  const speaking = (point: number) =>
    ordered.some((word) => word.start - 0.03 < point && point < word.end + 0.03);
  const allowed = (point: number) =>
    point >= cue.at && point >= earliest && point <= latest && !inside(point, hard);
  const clear = (point: number) => allowed(point) && !speaking(point);
  if (!speaking(target) && !inside(target, hard)) {
    const cut = cuts
      .filter((time) => Math.abs(time - target) <= 0.5 && clear(time))
      .sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
    if (cut !== undefined) return cut;
    const before = ordered.filter((word) => word.end <= target).at(-1);
    const after = ordered.find((word) => word.start >= target);
    if (before && after) {
      const edge = Math.min(0.1, (after.start - before.end) / 2);
      const point = Math.min(Math.max(target, before.end + edge), after.start - edge);
      if (allowed(point)) return point;
    }
    return target;
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
  let point = target;
  for (const span of mergeIntervals([...words, ...hard], seconds).filter((s) => s.end > point))
    if (span.start < point + 0.01) point = span.end + 0.01;
  return Math.min(point, seconds - 0.02);
}

/**
 * How late pause mode may start a description over the running film before it freezes the
 * picture instead (Napoleon, Oct 17 2026: Kade heard the picture stop during the opening credits
 * "where it could have talked over the music"). An action may start as late as a freeze for it
 * already could, up to 4 s after its last sensible moment; a card reading up to 2.5 s after the
 * card leaves. Either may then run on to the next dialogue, protected sound or section edge.
 */
export const actionLate = 4;
export const readingLate = 2.5;
export const lateWindow = (cue: Cue): Interval => ({
  start: cue.until + (cue.reading ? readingLate : actionLate),
  end: Infinity,
});

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
 * Seconds a line of narration needs at 1x, the slowest any voice is asked for: the engine's
 * starting length per UTF-8 byte (engine.ts seedSecondsPerByte), with digits, short all-capital
 * words (often said letter by letter) and inner dots ("www.mgm.com", said "dot") counted as the
 * longer words they become.
 */
export function spokenSeconds(words: string): number {
  const digits = (words.match(/\p{N}/gu) ?? []).length;
  const spelled = (words.match(/\b\p{Lu}{2,5}\b/gu) ?? []).reduce(
    (sum, word) => sum + word.length,
    0,
  );
  const dots = (words.match(/[\p{L}\p{N}]\.[\p{L}\p{N}]/gu) ?? []).length;
  return (Buffer.byteLength(words, 'utf8') + 4 * digits + 2 * spelled + 3 * dots) * 0.0625;
}

/** How far past `spokenSeconds` a clip may run before it counts as the voice running on. */
export type RunOnLimit = { factor: number; slack: number };
export const lineRunOn: RunOnLimit = { factor: 2.5, slack: 3 };
/** The credit's words are fixed and plain, so its limit is tighter. */
export const creditRunOn: RunOnLimit = { factor: 2, slack: 2.5 };

/**
 * A clip this long is a voice that ran on past its words, not a slow read (Napoleon, Oct 17
 * 2026: Kade's Fish voice said the five-word opening credit about fifteen times over 48 s, and in
 * later tests it went on into made-up chatter after the line, 2 takes in 6). Measured against
 * that job's 33 real descriptions, the slowest (the MGM card, 14.9 s) sat under half its limit.
 * The limit is sized at 1x, so a sped-up clip is judged at its 1x length (`ClipSpeed.oneX`).
 * KADE_VOICE_RUNON=0 turns the check off.
 */
export function ranOn(words: string, seconds: number, limit: RunOnLimit = lineRunOn): boolean {
  if (process.env.KADE_VOICE_RUNON === '0') return false;
  return seconds > limit.factor * spokenSeconds(words) + limit.slack;
}

/**
 * How long a take is against this voice's own pace in this job (`pace`: raw seconds per byte of
 * what was sent, after the engine's speed). `ranOn` is sized for the slowest voice on the slowest
 * line, so a voice that says a line two or three times passes it: on Napoleon (Oct 18 2026) Kade's
 * Fish voice said "Text reads, Sound Designers JAMES CURRIE and CRAIG CARTER." three times in one
 * 10.6 s take, under both `ranOn` (15.2 s) and the voice proxy's own guard (12.4 s). Against that
 * film's own pace its 615 other clips took at most 1.58 times their words, and the repeat 3.03.
 * `suspect` asks for a listen (engine.ts `voice`); `strong` alone retakes when nothing could
 * listen. KADE_VOICE_RUNON=0 turns both off.
 */
export type PaceCheck = { expected: number; suspect: boolean; strong: boolean };
export function paceCheck(words: string, seconds: number, pace: number): PaceCheck {
  const expected = (spokenSeconds(words) / 0.0625) * pace;
  if (process.env.KADE_VOICE_RUNON === '0' || !(expected > 0))
    return { expected, suspect: false, strong: false };
  return {
    expected,
    suspect: seconds > 1.4 * expected + 0.3,
    strong: seconds > 1.8 * expected + 0.6,
  };
}

/** Within this share of the number asked, a clip counts as having hit it: no atempo pass for it. */
const speedNear = 0.03;
/** What one voiced clip really came back at, against the speed asked of the voice proxy. */
export type ClipSpeed = {
  /** The clip's own engine speed: its length times this is its 1x length; atempo makes up the rest. */
  native: number;
  /** What its length is multiplied by before `ranOn` judges it. */
  oneX: number;
  /** The proxy's own number shows it stretched this clip, so exact speed is on over there. */
  stretched: boolean;
};
/**
 * Reads the voice proxy's x-kade-tts-speed-applied (`applied`) for one clip of `sent` speed.
 *
 * Kade, Oct 30 2026: "All the prat clips sounded completely natural." A Fish clip now comes back
 * stretched by the number, unless Praat had a hiccup: then a whole line would play at about 1x, so
 * the clip keeps what it really got as its own native and atempo makes up the difference. A figure
 * within 3% (a short clip's rounding, a long line's seams) counts as the number, since a second pass
 * through atempo for that would cost more than it gives.
 *
 * - `legacy`, a run of a job from before exact speed: everything stays as it was. The proxy gives
 *   it the old named pace, and "1" from the proxy there says nothing about the speed heard.
 * - No header (an Inworld voice, or a proxy from before the header): trust the number. The run-on
 *   check trusts it too for Inworld, which really renders at the number, but not for Fish, where
 *   a proxy without exact speed still returns about 1x.
 * - "1" at a higher number is the one that can't be read alone. It means a hiccup while the
 *   proxy's FISH_SPEED_EXACT is on and plain old behavior while it is off, where atempo on top
 *   would run the line far too fast. So it counts as a hiccup only once this run has seen a clip
 *   that really was stretched (`proven`). Until then the clip is treated as before this change,
 *   so the failure is the old sound, never a new one.
 */
export function clipSpeed(
  sent: number,
  applied: number | void,
  {
    legacy = false,
    fish = false,
    proven = false,
  }: { legacy?: boolean; fish?: boolean; proven?: boolean },
): ClipSpeed {
  if (legacy) return { native: sent, oneX: 1, stretched: false };
  if (typeof applied !== 'number' || !Number.isFinite(applied) || applied <= 0)
    return { native: sent, oneX: fish ? 1 : sent, stretched: false };
  const stretched = applied > 1 + speedNear;
  if (applied >= sent * (1 - speedNear)) return { native: sent, oneX: sent, stretched };
  if (!stretched && !proven) return { native: sent, oneX: 1, stretched: false };
  const native = Math.max(1, applied);
  return { native, oneX: native, stretched };
}

const heardWords = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .match(/[\p{L}\p{N}']+/gu) ?? [];

/**
 * Whether what a listener heard in a take says the line more often than the line itself does, or
 * carries on well past it (a run-on into the voice's reference recording). Misheard names only
 * lower the matches, so they never make a clean take look repeated.
 */
export function repeatsWords(line: string, heard: string): boolean {
  const said = heardWords(line);
  const got = heardWords(heard);
  if (!said.length || !got.length) return false;
  if (got.length >= 1.6 * said.length + 2) return true;
  const size = Math.min(3, said.length);
  const count = (list: string[], gram: string) => {
    let found = 0;
    for (let i = 0; i + size <= list.length; i++)
      if (list.slice(i, i + size).join(' ') === gram) found++;
    return found;
  };
  for (let i = 0; i + size <= said.length; i++) {
    const gram = said.slice(i, i + size).join(' ');
    if (count(got, gram) > count(said, gram)) return true;
  }
  return false;
}

/**
 * Moves each description onto a scene cut that follows its time within 0.8 s, since the model
 * samples only a few frames a second. Never earlier, so nothing is described before it appears.
 * Finite card readings keep their exact visible window.
 */
export function snapToCuts(cues: Cue[], cuts: number[]): Cue[] {
  if (!cuts.length) return cues;
  return cues.map((cue) => {
    if (cue.reading) return cue;
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

/** An earlier stretch this long with no dialogue and no description, while the last is crammed. */
export const idleStretch = 8;
/** The last description counts as crammed when it starts this close to the end of the clip. */
export const crammedEnd = 2.5;

const tenth = (value: number) => value.toFixed(1);

/**
 * Signs that a look's times stretched later than the events, as plain sentences (film seconds),
 * for the log and the section record. One cheap check: the last description crammed into the
 * clip's final `crammedEnd` seconds while an earlier stretch of `idleStretch` seconds has neither
 * dialogue nor any description's window. In the Pluto A/B (Sep 25 2026) it fired on both looks
 * whose times stretched and on none of the nine accurate ones, and a sign asks for one second
 * look (engine.ts). A second check, a description sharing words with dialogue that ended long
 * before it, was dropped: it fired on all eleven looks, the accurate ones included, because the
 * right description of a later moment can repeat an earlier line ("blows out the candle").
 * `cues` and `lines` are in section seconds.
 */
export function stretchSigns(input: {
  cues: Cue[];
  lines: Line[];
  seconds: number;
  /** Film seconds where the section starts, for the times in the sentences. */
  offset: number;
}): string[] {
  const { cues, lines, seconds, offset } = input;
  const signs: string[] = [];
  const ordered = [...cues].sort((a, b) => a.at - b.at);
  const last = ordered[ordered.length - 1];
  if (last && seconds >= 4 * idleStretch && last.at >= seconds - crammedEnd) {
    const busy = [
      ...lines,
      ...ordered
        .slice(0, -1)
        .map((cue) => ({ start: cue.at, end: Math.max(cue.until, cue.at + 1) })),
    ];
    const idle = gaps(busy, last.at)
      .filter((span) => span.end - span.start >= idleStretch)
      .sort((a, b) => b.end - b.start - (a.end - a.start))[0];
    if (idle)
      signs.push(
        `the last description starts ${tenth(seconds - last.at)} s before the clip ends while ${tenth(idle.end - idle.start)} s from ${tenth(offset + idle.start)} s has neither dialogue nor description`,
      );
  }
  return signs;
}

export type Variant = 'full' | 'short';
export type Arranged = { index: number; variant: Variant; placement: Placement };
/** Why a description was left out of the section. */
export type Leftover = 'room' | 'minor' | 'priority';
export type Arrangement = { placed: Arranged[]; left: { index: number; reason: Leftover }[] };

const textOf = (cue: Cue, variant: Variant) => (variant === 'full' ? cue.text : cue.shortText);
const readingWindow = (cue: Cue): string => `${cue.at}:${cue.until}:${cue.pauseAt ?? cue.at}`;
const spanOf = (placement: Placement): Interval =>
  placement.pause
    ? { start: placement.at - 0.05, end: placement.pauseAt + 0.05 }
    : {
        start: placement.at - (narrationGap - 0.08),
        end: placement.at + placement.duration + narrationGap,
      };

/** What `arrange` places a section's descriptions from. */
export type ArrangeInput = {
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
  /** The earliest a freeze may start, clear of the section start. */
  earliest?: number;
};
/** One planning pass: whether late starts are tried, and what is kept from them. */
type Pass = {
  late: boolean;
  /** Freeze exactly as the describer did before Oct 17 2026 (no moved freeze points). */
  legacy: boolean;
  /** Card windows (`readingWindow`) whose chunks freeze on the card rather than start late. */
  onCard: Set<string>;
  /** Descriptions that may not start late in this pass. */
  noLate: Set<Cue>;
};

/**
 * Places a section's descriptions in the order their events happen. Each one takes its full
 * text near the listener's usual speed if it can, then the short text, then either text up to
 * her fastest speed. A description is not allowed to take the room a later, more important one
 * needs; it is shortened, paused for (extended mode), or left out instead. `length` gives each
 * text's length at 1x, or undefined when that text cannot be used. Marked readings use only
 * the full text; chunks sharing a card window are spoken together or omitted together.
 *
 * Pause mode keeps that plan, exactly as it was before Oct 17 2026, unless a newer one beats it
 * on every count. The newer plans let a description start a little late over whatever music or
 * sound follows (`lateWindow`) before freezing the picture, and move a freeze off another
 * description still talking. One counts only when it speaks every description the old plan
 * spoke, freezes no longer, and puts no more descriptions out of order, no more voices on top of
 * each other and no more card lines out of order; when the late plan falls short, the late
 * starts behind the shortfall are barred one pass at a time. Of those that count, the one that
 * freezes least wins, then the one that speaks most, then the one with fewer voices overlapping.
 */
export function arrange(input: ArrangeInput): Arrangement {
  const empty = { onCard: new Set<string>(), noLate: new Set<Cue>() };
  const base = plan(input, { late: false, legacy: true, ...empty });
  if (input.settings.mode !== 'extended') return base;
  const calm = base.left.length === 0 && base.placed.every((item) => item.placement.pause === 0);
  /** Nothing frozen and nothing left out: no other plan can do better. */
  if (calm) return base;
  const { cues } = input;
  const eps = 1e-6;
  const frozen = (result: Arrangement) =>
    result.placed.reduce((sum, item) => sum + item.placement.pause, 0);
  /** Descriptions heard before one whose event happened more than half a second earlier. */
  const outOfOrder = (result: Arrangement) =>
    result.placed.filter((item) =>
      result.placed.some(
        (other) =>
          cues[item.index].at + 0.5 < cues[other.index].at &&
          item.placement.at > other.placement.at + eps,
      ),
    );
  /** Pairs heard the wrong way round, as listened to, among cues or among one card's lines. */
  const pairs = (result: Arrangement, wrong: (a: number, b: number) => boolean) => {
    /** Sorted as outputTimeline sorts (stably), so its answers line up with these. */
    const sorted = [...result.placed].sort(
      (a, b) => a.placement.at - b.placement.at || a.placement.pauseAt - b.placement.pauseAt,
    );
    const heard = outputTimeline(sorted.map((item) => item.placement));
    const order = sorted.map((item, n) => ({ index: item.index, at: heard[n].outputAt }));
    return order.reduce(
      (count, a) =>
        count + order.filter((b) => wrong(a.index, b.index) && a.at > b.at + eps).length,
      0,
    );
  };
  const swapped = (result: Arrangement) => pairs(result, (a, b) => cues[a].until <= cues[b].at);
  const cardSwapped = (result: Arrangement) =>
    pairs(
      result,
      (a, b) => a < b && !!cues[a].reading && readingWindow(cues[a]) === readingWindow(cues[b]),
    );
  /** Pairs of descriptions heard on top of each other. */
  const overlaps = (result: Arrangement) => {
    const heard = outputTimeline(result.placed.map((item) => item.placement));
    return heard.reduce(
      (count, a) =>
        count +
        heard.filter(
          (b) => a !== b && a.outputAt <= b.outputAt && b.outputAt < a.outputAt + a.duration - 1e-3,
        ).length,
      0,
    );
  };
  const kept = base.placed.map((item) => item.index);
  const limits = {
    frozen: frozen(base),
    disorder: outOfOrder(base).length,
    swaps: swapped(base),
    cards: cardSwapped(base),
    overlaps: overlaps(base),
  };
  const shortfall = (tried: Arrangement) => {
    const spoken = new Set(tried.placed.map((item) => item.index));
    const lost = kept.filter((index) => !spoken.has(index)).map((index) => cues[index]);
    const longer = frozen(tried) > limits.frozen + eps;
    const shuffled = outOfOrder(tried);
    const worse =
      shuffled.length > limits.disorder ||
      swapped(tried) > limits.swaps ||
      cardSwapped(tried) > limits.cards ||
      overlaps(tried) > limits.overlaps;
    return lost.length || longer || worse ? { lost, longer, shuffled } : null;
  };
  const startedLate = (item: Arranged) =>
    item.placement.pause === 0 &&
    item.placement.at + item.placement.duration > cues[item.index].until - 0.08 + eps;
  const late = (): Arrangement | null => {
    const noLate = new Set<Cue>();
    for (let pass = 0; pass <= cues.length; pass++) {
      const tried = plan(input, { late: true, legacy: false, onCard: new Set(), noLate });
      const short = shortfall(tried);
      if (!short) return tried;
      const started = tried.placed.filter(
        (item) => startedLate(item) && !noLate.has(cues[item.index]),
      );
      if (!started.length) return null;
      const from = Math.min(...short.lost.map((cue) => cue.at));
      const to = Math.max(...short.lost.map((cue) => cue.until + actionLate));
      const behind = short.lost.length
        ? started.filter((item) => {
            const span = spanOf(item.placement);
            return span.end > from && span.start < to;
          })
        : short.longer
          ? started
          : started.filter((item) => short.shuffled.includes(item));
      for (const item of behind.length ? behind : started) noLate.add(cues[item.index]);
    }
    return null;
  };
  const moved = plan(input, { late: false, legacy: false, ...empty });
  const better = (a: Arrangement, b: Arrangement) =>
    frozen(a) < frozen(b) - eps ||
    (frozen(a) <= frozen(b) + eps &&
      (a.placed.length > b.placed.length ||
        (a.placed.length === b.placed.length && overlaps(a) < overlaps(b))));
  const chosen = [late(), shortfall(moved) ? null : moved].reduce<Arrangement>(
    (best, option) => (option && better(option, best) ? option : best),
    base,
  );
  /**
   * A description the old plan left out for room or as minor keeps that reason, never 'priority',
   * so the engine can still carry it into the next section as before.
   */
  const reasons = new Map(base.left.map((item) => [item.index, item.reason]));
  return {
    ...chosen,
    left: chosen.left.map((item) => {
      const before = reasons.get(item.index);
      return item.reason === 'priority' && before && before !== 'priority'
        ? { ...item, reason: before }
        : item;
    }),
  };
}

function plan(input: ArrangeInput, pass: Pass): Arrangement {
  const { cues, settings, seconds } = input;
  const order = cues
    .map((cue, index) => ({ cue, index }))
    .sort((a, b) => a.cue.at - b.cue.at || b.cue.importance - a.cue.importance);
  const lengths = (index: number): Partial<Record<Variant, number>> => {
    const cue = cues[index];
    const full = input.length(index, 'full');
    /**
     * A reading's short text is the opening of its own words, its first credit role
     * (`creditShortText`), and only outside pause mode; a paraphrase is never read as a card.
     */
    const short =
      cue.shortText &&
      cue.shortText !== cue.text &&
      (!cue.reading || (settings.mode !== 'extended' && cue.text.startsWith(cue.shortText)))
        ? input.length(index, 'short')
        : undefined;
    return {
      ...(full !== undefined && full > 0 ? { full } : {}),
      ...(short !== undefined && short > 0 ? { short } : {}),
    };
  };
  const tries = (index: number): [Variant, number][] => {
    const easy = Math.min(settings.maxRate, settings.rate * 1.2);
    const sticky = cues[index].reading ? 'full' : input.prefer?.(index);
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
  /**
   * No-pause mode (Oct 20 2026): a reading may run `readingLate` past its card, the grace pause mode
   * already gives, so a credit group a little longer than its few seconds on screen is still read.
   */
  const fitWindow = (cue: Cue): Cue =>
    cue.reading && settings.mode !== 'extended'
      ? { ...cue, until: Math.min(seconds, cue.until + readingLate) }
      : cue;
  const fit = (index: number, variant: Variant, limit: number, taken: Interval[], from: number) =>
    fitCue(
      fitWindow(cues[index]),
      textOf(cues[index], variant),
      lengths(index)[variant] ?? NaN,
      { ...settings, maxRate: limit },
      [...input.blocked, ...taken, { start: 0, end: from }],
      seconds,
    );
  const extended = settings.mode === 'extended';
  const lateOn = (index: number) =>
    pass.late &&
    extended &&
    cues[index].importance >= 2 &&
    !pass.noLate.has(cues[index]) &&
    !(cues[index].reading && pass.onCard.has(readingWindow(cues[index])));
  /** A late try never speaks slower than `least` (at most `limit`), to leave room for later ones. */
  const fitLate = (
    index: number,
    variant: Variant,
    limit: number,
    taken: Interval[],
    from: number,
    least: number,
  ) =>
    fitCue(
      cues[index],
      textOf(cues[index], variant),
      lengths(index)[variant] ?? NaN,
      { ...settings, rate: Math.min(limit, least), maxRate: limit },
      [...input.blocked, ...taken, { start: 0, end: from }],
      seconds,
      lateWindow(cues[index]),
    );
  const fitsAnywhere = (index: number, taken: Interval[], from: number) =>
    tries(index).some(([variant]) => !!fit(index, variant, settings.maxRate, taken, from));
  /** Spoken over the running film, on time or late: anything but a freeze. */
  const overFilm = (index: number, taken: Interval[], from: number) =>
    tries(index).some(
      ([variant, limit]) =>
        !!fit(index, variant, limit, taken, from) ||
        (lateOn(index) && !!fitLate(index, variant, limit, taken, from, settings.rate)),
    );
  const later = (position: number, span: Interval) =>
    order.slice(position + 1).filter((item) => item.cue.at < span.end);
  /** True when taking `span` would make a later important description freeze instead. */
  const forcesFreeze = (position: number, span: Interval) =>
    later(position, span).some(
      (item) =>
        item.cue.importance >= 2 &&
        overFilm(item.index, spans, floor) &&
        !overFilm(item.index, [...spans, span], Math.max(floor, span.end)),
    );
  /** True when taking `span` would leave a later description of any importance no gap. */
  const crowds = (position: number, span: Interval) =>
    later(position, span).some(
      (item) =>
        fitsAnywhere(item.index, spans, floor) &&
        !fitsAnywhere(item.index, [...spans, span], Math.max(floor, span.end)),
    );
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
  /** Placements a late try made, the only ones a card is re-planned for. */
  const startedLate = new Set<Arranged>();
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
    if (!chosen && lateOn(index)) {
      /** The first late start that crowds nothing out wins; otherwise the first that fits. */
      let fallback: Arranged | null = null;
      late: for (const [variant, limit] of tries(index))
        for (const least of new Set([settings.rate, Math.min(limit, settings.rate * 1.2), limit])) {
          const placement = fitLate(index, variant, limit, spans, floor, least);
          if (!placement) break;
          const span = spanOf(placement);
          if (hurts(position, span) || forcesFreeze(position, span)) continue;
          const option = {
            index,
            variant,
            placement: { ...placement, shortened: variant === 'short' },
          };
          if (!crowds(position, span)) {
            chosen = option;
            break late;
          }
          fallback ??= option;
        }
      chosen ??= fallback;
      if (chosen) startedLate.add(chosen);
    }
    const full = lengths(index).full;
    if (!chosen && extended && cue.importance >= 2 && full !== undefined) {
      const earlierReading = cue.reading
        ? placed.find(
            (item) =>
              cues[item.index].reading &&
              readingWindow(cues[item.index]) === readingWindow(cue) &&
              item.placement.pause > 0,
          )
        : undefined;
      const suggested =
        earlierReading?.placement.pauseAt ??
        pausePoint(
          cue,
          input.words,
          [...input.hard, ...spans],
          seconds,
          input.cuts,
          input.earliest,
        );
      const end = cue.reading ? Math.min(seconds, cue.until) : seconds;
      const aimed =
        cue.reading && !earlierReading
          ? Math.min(Math.max(cue.at, end - 0.05), Math.max(cue.at, suggested))
          : suggested;
      /**
       * A freeze never starts while an earlier description is still talking over the film, on its
       * own or before its own freeze, nor before an earlier chunk of its own card has been read.
       * Chunks of one card keep sharing their first chunk's freeze, with the grace that freeze was
       * given. When the moved point cannot freeze, the old one is used, as before.
       */
      const talking = earlierReading
        ? []
        : placed
            .map(({ placement }) => ({
              start: placement.at,
              end: placement.pause ? placement.pauseAt : placement.at + placement.duration,
            }))
            .filter((span) => span.end > span.start)
            .sort((a, b) => a.start - b.start);
      const cardRead = cue.reading
        ? placed
            .filter(
              (item) =>
                cues[item.index].reading &&
                readingWindow(cues[item.index]) === readingWindow(cue) &&
                item.placement.pause === 0,
            )
            .reduce(
              (time, item) => Math.max(time, item.placement.at + item.placement.duration + breath),
              -Infinity,
            )
        : -Infinity;
      const moved = Math.max(
        cardRead,
        talking.reduce(
          (time, span) =>
            span.start - 0.01 < time && time < span.end + breath
              ? Math.max(span.end, Math.min(span.end + breath, seconds - 0.05))
              : time,
          aimed,
        ),
      );
      const freezable = (time: number) => {
        const grace = cue.reading ? (time > aimed || earlierReading ? readingLate : 0) : actionLate;
        const latest = Math.min(seconds - 0.05, cue.until + grace);
        const inWord =
          cue.reading &&
          input.words.some((word) => word.start - 0.03 < time && time < word.end + 0.03);
        return time <= latest + 1e-9 && !inside(time, input.hard) && !inWord;
      };
      /** Before Oct 17 2026 a freeze stayed where it was aimed, its card's end the limit. */
      const asBefore = (time: number) =>
        time <= Math.min(seconds - 0.05, cue.until + (cue.reading ? 0 : actionLate)) + 1e-9 &&
        !inside(time, input.hard) &&
        !(
          cue.reading &&
          input.words.some((word) => word.start - 0.03 < time && time < word.end + 0.03)
        );
      const point = pass.legacy
        ? asBefore(aimed)
          ? aimed
          : undefined
        : freezable(moved)
          ? moved
          : freezable(aimed)
            ? aimed
            : undefined;
      if (point === undefined) {
        left.push({ index, reason: 'room' });
        return;
      }
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
          end,
        ),
      };
    }
    if (!chosen) {
      const reason: Leftover = crowded
        ? 'priority'
        : extended && cue.importance === 1
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
  const readings = new Map<string, number[]>();
  cues.forEach((cue, index) => {
    if (!cue.reading) return;
    const window = readingWindow(cue);
    readings.set(window, [...(readings.get(window) ?? []), index]);
  });
  {
    const ranLate = (item: Arranged) =>
      startedLate.has(item) &&
      item.placement.at + item.placement.duration > cues[item.index].until + 1e-6;
    const windows = new Map<string, Arranged[]>();
    for (const item of placed) {
      if (!cues[item.index].reading) continue;
      const window = readingWindow(cues[item.index]);
      windows.set(window, [...(windows.get(window) ?? []), item]);
    }
    /** A card read partly late and partly frozen, or late with chunks missing, freezes whole. */
    const split = [...windows]
      .filter(
        ([window, items]) =>
          !pass.onCard.has(window) &&
          items.some(ranLate) &&
          (items.some((item) => item.placement.pause > 0) ||
            items.length < (readings.get(window)?.length ?? 0)),
      )
      .map(([window]) => window);
    // Each pass adds at least one card window, so this ends.
    if (split.length) return plan(input, { ...pass, onCard: new Set([...pass.onCard, ...split]) });
  }
  const spoken = new Set(placed.map((item) => item.index));
  const incomplete = new Set(
    [...readings.values()]
      .filter(
        (group) =>
          group.some((index) => spoken.has(index)) && group.some((index) => !spoken.has(index)),
      )
      .flat(),
  );
  if (incomplete.size) {
    // A finite card is one reading: omit all its chunks when only part fits, then release
    // their room for other descriptions. Each retry removes at least one reading group.
    const indices = cues.map((_cue, index) => index).filter((index) => !incomplete.has(index));
    const rest = plan(
      {
        ...input,
        cues: indices.map((index) => cues[index]),
        length: (index, variant) => input.length(indices[index], variant),
        prefer: (index) => input.prefer?.(indices[index]),
      },
      pass,
    );
    return {
      placed: rest.placed.map((item) => ({ ...item, index: indices[item.index] })),
      left: [
        ...rest.left.map((item) => ({ ...item, index: indices[item.index] })),
        ...[...incomplete].map((index) => ({ index, reason: 'room' as const })),
      ].sort((a, b) => a.index - b.index),
    };
  }
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
