import type {
  Continuity,
  Cue,
  Interval,
  Person,
  Plan,
  SectionRecord,
  Settings,
  Word,
} from './types';
import type { Arranged } from './timing';
import { arrange, gaps, mergeIntervals, readingLate, snapToCuts } from './timing';
import { creditShortText, dropRereadCards, gateCues, splitCardReadings } from './ledger';
import { spokenForm } from './prompt';

/**
 * Tellavision "Follow along" (Nov 2026, design Part 5.1). A phone listens to a film playing on
 * another screen and speaks a copy's descriptions in step, in its own voice. A track is the
 * timed lines it needs, built from the copy's saved files with no paid call: each section's saved
 * look goes through the steps a run takes before voicing (scene-cut snapping, card readings, the
 * name gate), then `arrange` in no-pause mode at estimated voice lengths. Only the gaps between
 * the words go into a track, never the words.
 *
 * The field names are a contract the iPhone reads (id, startSec, endSec, text, shortText and
 * importance are what syncprint's planner reads). Times are seconds in the source film: a part
 * of a film adds the part's start to every time. The fingerprint's second 0 is `covers.startSec`.
 */

export const trackFormat: 'kade-follow-track' = 'kade-follow-track';
export const trackVersion: 1 = 1;
/** Seconds of speech per UTF-8 byte at 1x the track assumes: the engine's starting pace. */
export const trackSecondsPerByte: number = 0.0625;
export const trackWarning: string =
  'AI descriptions can miss or misread visual details. Check anything important for yourself.';

/** What the server expected for a line at its pace: its full text, its short text, or neither. */
export type TrackFit = 'full' | 'short' | 'none';
export type TrackCue = {
  /** "section:index", unique in the track. */
  id: string;
  /** The window a line may be spoken in: a quiet stretch of the film. */
  startSec: number;
  endSec: number;
  /** When the thing happens, and the last sensible moment to say it. */
  at: number;
  until: number;
  text: string;
  shortText: string;
  importance: number;
  /** Reads words from the screen. */
  reading: boolean;
  fit: TrackFit;
};
/** The fingerprint file that goes with the track (syncprint's own format, "SYPR"). */
export type TrackPrint = { format: number; bytes: number; sha256: string };
/** The Kade-AI credit as the phone says it; left out when the copy has none. */
export type TrackCredit = { start?: string; end?: string };
export type Track = {
  format: 'kade-follow-track';
  version: 1;
  job: string;
  copyVersion: number;
  title: string;
  language: string;
  filmSeconds: number;
  covers: { startSec: number; endSec: number };
  print: TrackPrint;
  plannedAt: { secPerChar: number; rate: number; maxRate: number };
  credit?: TrackCredit;
  cues: TrackCue[];
  /** Every quiet stretch of the film the track covers, as [start, end] pairs. */
  quiet: [number, number][];
  warning: string;
};
export type TrackInput = {
  job: string;
  copyVersion: number;
  title: string;
  /** The copy's settings: its rate, fastest rate and notes are used; its mode is not. */
  settings: Settings;
  plan: Plan;
  /** The plan's dialogue words, in plan seconds. */
  words: Word[];
  /** The copy's section records, from its manifest. */
  records: SectionRecord[];
  /** The first look's people, when the copy had one. */
  reference?: Person[];
  /** The whole source's length in seconds; the plan's end when unknown. */
  filmSeconds?: number;
  print: TrackPrint;
  credit?: TrackCredit | null;
};

const round = (value: number): number => Math.round(value * 100) / 100;
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * The track of one copy. Sections without a saved look still give their quiet stretches. A line
 * that fits gets the window `arrange` placed it in: from its start to the end of that gap or the
 * line's last sensible moment, whichever comes first. A line that did not fit (fit "none") gets
 * the first gap that touches its own moment, or an empty window at its moment when there is none.
 * Lines of importance 1 stay in: the phone decides whether to say them.
 */
export function buildTrack(input: TrackInput): Track {
  const steps = trackSteps(input);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/**
 * `buildTrack` one section at a time: it pauses after each section, so a caller on the server's
 * main thread can let other work run between sections (a two-hour film is about 80 sections and
 * 0.7 s of planning in all). The finished track is its return value.
 */
export function* trackSteps(input: TrackInput): Generator<void, Track, void> {
  const { plan, settings } = input;
  const offset = plan.range?.start ?? 0;
  const count = plan.sections.length;
  const noPause: Settings = { ...settings, mode: 'standard' };
  const seen = new Set<number>();
  const records = [...input.records]
    .filter((record) => Number.isInteger(record.index) && record.index >= 0 && record.index < count)
    .sort((a, b) => a.index - b.index)
    .filter((record) => (seen.has(record.index) ? false : (seen.add(record.index), true)));
  const cues: TrackCue[] = [];
  const quiet: Interval[] = [];
  /** The continuity each section starts from: the record before it, as a run hands it on. */
  let state: Continuity | null = null;
  /** Seconds between the end of the last line placed in the previous section and its end. */
  let tail = Infinity;
  let previous = -1;
  for (const [position, record] of records.entries()) {
    if (position > 0) yield;
    const i = record.index;
    const start = record.start;
    const seconds = record.end - record.start;
    const stateIn = state;
    state = record.continuity ?? state;
    const tailIn = previous === i - 1 ? tail : Infinity;
    previous = i;
    tail = Infinity;
    if (!(seconds > 0)) continue;
    const sectionWords = input.words
      .filter((word) => word.start >= start && word.start < record.end)
      .map((word) => ({
        ...word,
        start: word.start - start,
        end: Math.min(seconds, word.end - start),
      }));
    const analysis = record.analysis;
    const protectedSounds = analysis?.protectedSounds ?? [];
    const sound = mergeIntervals(
      [
        ...mergeIntervals(sectionWords, seconds, 0.22),
        ...mergeIntervals(protectedSounds, seconds, 0.1),
      ],
      seconds,
    );
    for (const gap of gaps(sound, seconds))
      quiet.push({ start: offset + start + gap.start, end: offset + start + gap.end });
    if (!analysis) continue;
    /** The room a run keeps at section joins (engine.ts `edgeGuards`). */
    const guards: Interval[] = [];
    if (i > 0) guards.push({ start: 0, end: Math.max(0.25, 0.35 - tailIn) });
    if (i < count - 1) guards.push({ start: seconds - 0.25, end: seconds });
    const blocked = mergeIntervals([...sound, ...guards], seconds);
    const sectionCuts = (plan.cuts ?? [])
      .filter((time) => time >= start && time < record.end)
      .map((time) => time - start);
    const fresh = dropRereadCards(
      splitCardReadings(snapToCuts(analysis.cues, sectionCuts)),
      stateIn,
      [],
    );
    const gated = creditShortText(
      gateCues({
        cues: fresh.cues,
        people: analysis.people,
        state: stateIn,
        words: input.words,
        notes: settings.notes ?? '',
        sectionStart: start,
        reference: input.reference,
      }).cues,
    ).filter((cue) => cue.text.trim().length > 0);
    const ledger = [...analysis.people, ...(stateIn?.people ?? []), ...(input.reference ?? [])]
      .flatMap((person) => [person.name, person.label])
      .filter(Boolean);
    const textOf = (cue: Cue, variant: 'full' | 'short') =>
      variant === 'full' ? cue.text : cue.shortText;
    const arranged = arrange({
      cues: gated,
      length: (index, variant) =>
        bytes(spokenForm(textOf(gated[index], variant), ledger)) * trackSecondsPerByte,
      settings: noPause,
      blocked,
      hard: protectedSounds,
      words: sectionWords,
      seconds,
      cuts: sectionCuts,
      ...(i > 0 ? { earliest: guards[0].end } : {}),
    });
    const placed = new Map<number, Arranged>(arranged.placed.map((item) => [item.index, item]));
    for (const item of arranged.placed)
      tail = Math.min(tail, seconds - (item.placement.at + item.placement.duration));
    const open = gaps(blocked, seconds);
    /** A line's last sensible moment as `arrange` reads it in no-pause mode. */
    const lastMoment = (cue: Cue) => Math.min(seconds, cue.until + (cue.reading ? readingLate : 0));
    gated.forEach((cue, n) => {
      const item = placed.get(n);
      let from: number;
      let to: number;
      if (item) {
        const at = item.placement.at;
        const gap = open.find((span) => span.start - 1e-6 <= at && at < span.end + 1e-6);
        from = at;
        to = Math.max(Math.min(gap?.end ?? seconds, lastMoment(cue)), at + item.placement.duration);
      } else {
        const until = lastMoment(cue);
        const touching = open.find((span) => span.end > cue.at && span.start < until);
        from = touching ? Math.max(touching.start, cue.at) : Math.min(Math.max(0, cue.at), seconds);
        to = touching ? Math.min(touching.end, until) : from;
      }
      const startSec = round(offset + start + from);
      cues.push({
        id: `${i}:${n}`,
        startSec,
        endSec: Math.max(startSec, round(offset + start + to)),
        at: round(offset + start + cue.at),
        until: round(offset + start + cue.until),
        text: cue.text,
        shortText: cue.shortText || cue.text,
        importance: Math.min(3, Math.max(1, Math.round(cue.importance) || 2)),
        reading: !!cue.reading,
        fit: item ? item.variant : 'none',
      });
    });
  }
  const order = new Map(cues.map((cue, n) => [cue, n]));
  cues.sort(
    (a, b) => a.startSec - b.startSec || a.at - b.at || (order.get(a) ?? 0) - (order.get(b) ?? 0),
  );
  /** Stretches that meet across a section join are one stretch. */
  const joined: Interval[] = [];
  for (const span of quiet.sort((a, b) => a.start - b.start)) {
    const last = joined[joined.length - 1];
    if (last && span.start <= last.end + 0.02) last.end = Math.max(last.end, span.end);
    else joined.push({ ...span });
  }
  const first = records[0];
  const last = records[records.length - 1];
  const covers = first
    ? { startSec: round(offset + first.start), endSec: round(offset + last.end) }
    : { startSec: round(offset), endSec: round(offset + plan.seconds) };
  const credit =
    input.credit && (input.credit.start || input.credit.end)
      ? {
          ...(input.credit.start ? { start: input.credit.start } : {}),
          ...(input.credit.end ? { end: input.credit.end } : {}),
        }
      : undefined;
  return {
    format: trackFormat,
    version: trackVersion,
    job: input.job,
    copyVersion: input.copyVersion,
    title: input.title,
    language: 'en',
    filmSeconds: round(
      Number.isFinite(input.filmSeconds) && (input.filmSeconds ?? 0) > 0
        ? (input.filmSeconds as number)
        : offset + plan.seconds,
    ),
    covers,
    print: { ...input.print },
    plannedAt: {
      secPerChar: Math.round((trackSecondsPerByte / settings.rate) * 10000) / 10000,
      rate: settings.rate,
      maxRate: settings.maxRate,
    },
    ...(credit ? { credit } : {}),
    cues,
    quiet: joined
      .map((span): [number, number] => [round(span.start), round(span.end)])
      .filter(([from, to]) => to > from),
    warning: trackWarning,
  };
}
