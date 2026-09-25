import axios from 'axios';
import { isAbsolute, join, relative } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import type {
  Analysis,
  Chapter,
  Continuity,
  Cue,
  FailureClass,
  Interval,
  Levels,
  Meter,
  Placement,
  Plan,
  Progress,
  Report,
  SectionRecord,
  Settings,
  Skip,
  Word,
} from './types';
import type { Freeze, Media, Rational } from './media';
import type { Leftover, Variant } from './timing';
import type { Brief, Heard } from './prompt';
import type { Duck, Pause } from './mix';
import type { Look } from './providers';
import {
  assemble,
  copyable,
  decodeVoice,
  MediaError,
  normalize,
  saveSound,
  sectionClip,
  sectionPicture,
  sectionSound,
  soundtrack,
  stretch,
} from './media';
import {
  bridgeDucks,
  decibels,
  duckDepth,
  level,
  mix,
  pauseProgram,
  pcmSeconds,
  sampleRate,
  shortTermMax,
  trimSilence,
} from './mix';
import {
  analyze,
  failureClass,
  keytermsFor,
  linesFrom,
  providerProblem,
  synthesize,
  transcribe,
} from './providers';
import {
  arrange,
  mergeIntervals,
  outputTimeline,
  planSections,
  snapToCuts,
  toOutput,
} from './timing';
import { buildReport, captionTrack, clock, descriptionTrack, transcriptText } from './transcript';
import { nextContinuity } from './prompt';
import { gateCues, recognized } from './ledger';
import { Halt } from './types';

export { buildReport } from './transcript';

export type Providers = {
  transcribe: (
    file: string,
    seconds: number,
    signal: AbortSignal,
    meter: Meter,
    hints?: { keyterms?: string[]; onLanguage?: (code: string) => void },
  ) => Promise<Word[]>;
  analyze: (look: Look, signal: AbortSignal, meter: Meter) => Promise<Analysis>;
  synthesize: (
    text: string,
    voice: string,
    session: string,
    file: string,
    speed: number,
    signal: AbortSignal,
    meter: Meter,
  ) => Promise<void>;
};
export const productionProviders: Providers = { transcribe, analyze, synthesize };

export type SectionFiles = { sound: string; picture?: string };
/** A paid look at one section that has not been rendered yet. */
export type SavedLook = {
  analysis: Analysis | null;
  failure?: string;
  failureClass?: FailureClass;
};
/** What an earlier run left behind: the plan, the dialogue, finished sections, or analyses to reuse. */
export type Saved = {
  firstLook?: { through: number; state: Continuity };
  plan?: Plan;
  words?: Word[];
  /** Finished sections, reused as they are. */
  records: SectionRecord[];
  /** Re-voicing or redoing: analyses to voice again; undefined means look again. */
  analyses?: (Analysis | null | undefined)[];
  /** Paid looks of this version that were not rendered yet. */
  looks?: (SavedLook | undefined)[];
};
/** Persistence for long jobs, so a restart continues instead of starting over. */
export type Keeper = {
  saved: Saved;
  keepFirstLook?: (look: { through: number; state: Continuity }) => Promise<void>;
  keepPlan: (plan: Plan, words: Word[]) => Promise<void>;
  /** Called right after every paid look, including the one made ahead of time. */
  keepLook?: (index: number, look: SavedLook) => Promise<void>;
  keepSection: (record: SectionRecord, files: SectionFiles) => Promise<void>;
  restore: (index: number, directory: string) => Promise<SectionFiles>;
  /** Stores the part cut from the source, so later runs of the same part skip the re-encode. */
  keepWorking?: (file: string) => Promise<void>;
};
export const localKeeper = (): Keeper => ({
  saved: { records: [] },
  keepPlan: async () => {},
  keepSection: async () => {},
  restore: async () => {
    throw new Error('No saved section is available.');
  },
});

export type Request = {
  source: string;
  directory: string;
  title: string;
  about: string;
  settings: Settings;
  session: string;
  signal: AbortSignal;
  meter: Meter;
  progress: Progress;
  providers?: Providers;
  keeper?: Keeper;
  voices?: number;
  /** Preview: render only the sections that start before this time (working-source seconds). */
  stopAfter?: number;
  /** Chapters of the whole source, in source seconds. */
  chapters?: Chapter[];
  /** Redo: an extra note from the listener for particular sections. */
  sectionNotes?: Record<number, string>;
  /** The source is already this part, as kept by an earlier run, so it is not cut again. */
  workingCopy?: boolean;
  /** Section timings, failures and retries, for the server log. */
  log?: (message: string) => void;
};
export type Outcome = {
  video: string;
  audio: string;
  files: { report: string; transcript: string; descriptions: string; captions: string };
  report: Report;
  /** True when a preview left later sections for another run. */
  partial: boolean;
};

type Preset = { lift: number; offset: number; duck: number; depth: number; floor: number };
/**
 * `offset` places the narrator against the dialogue; `lift` is the older rule against the whole
 * soundtrack, kept for plans measured before dialogue loudness existed. `depth` scales the
 * per-line dip and `floor` is the least room (LU) the narrator keeps above the soundtrack.
 */
const presets: Record<Settings['volume'], Preset> = {
  softer: { lift: 0, offset: -2, duck: -6, depth: 0.7, floor: 8 },
  balanced: { lift: 2, offset: 1, duck: -8, depth: 1, floor: 10 },
  louder: { lift: 5, offset: 4, duck: -11, depth: 1.3, floor: 12 },
};

/**
 * Evens out the finished copy: the soundtrack is brought toward -20 LUFS (never more than 6 dB
 * into the peak limiter), and the narrator is set against the dialogue. Without a dialogue
 * measurement it falls back to the programme level lowered for a wide loudness range (EBU TR 084
 * Annex B), and without that to the programme level itself.
 */
export function levelsFor(plan: Plan, choice: Settings['volume']): Levels {
  const preset = presets[choice];
  const { program, peak, dialogue, lra } = plan.loudness;
  if (!plan.audio || program <= -69)
    return { gain: 0, narration: -18 + preset.lift, duck: preset.duck };
  const gain = Math.min(12, 5 - peak, Math.max(-12, -20 - program));
  let anchor = program + preset.lift;
  if (lra !== undefined) anchor = program - 0.19 * (lra - 1) + preset.offset;
  if (dialogue !== undefined) anchor = dialogue + preset.offset;
  return { gain, narration: Math.min(-13, Math.max(-26, anchor + gain)), duck: preset.duck };
}

type Block = { time: number; lufs: number };
const power = (lufs: number) => 10 ** (lufs / 10);
const meanLevel = (blocks: Block[]) =>
  10 * Math.log10(blocks.reduce((sum, block) => sum + power(block.lufs), 0) / blocks.length);

/**
 * Loudness of the dialogue alone: the power mean of the 400 ms momentary blocks centred inside
 * recognised speech, with the usual -70 LUFS and relative gates. Undefined when there is too
 * little speech to trust. A block's `time` is the centre of its 400 ms window, as
 * `momentaryBlocks` in media.ts reports it.
 */
export function dialogueLoudness(
  momentary: Block[],
  words: Word[],
  seconds: number,
): number | undefined {
  const spans = mergeIntervals(words, seconds, 0.1);
  const speech = spans.reduce((sum, span) => sum + span.end - span.start, 0);
  if (speech < Math.max(3, Math.min(30, seconds * 0.1))) return undefined;
  const ordered = [...momentary].sort((a, b) => a.time - b.time);
  const heard: Block[] = [];
  let k = 0;
  for (const block of ordered) {
    const centre = block.time;
    while (k < spans.length && spans[k].end < centre) k++;
    if (k < spans.length && spans[k].start <= centre && block.lufs > -70) heard.push(block);
  }
  if (heard.length < 5) return undefined;
  const gate = meanLevel(heard) - 10;
  const kept = heard.filter((block) => block.lufs > gate);
  return kept.length ? meanLevel(kept) : undefined;
}

/**
 * The peak that sets how far the soundtrack may be raised. A click or pop shorter than half a
 * second no longer decides it: the sample peak counts only up to 12 dB above the loudest
 * sustained momentary loudness, and the limiter takes care of anything sharper.
 */
export function steadyPeak(peak: number, momentary?: Block[]): number {
  const levels = (momentary ?? [])
    .map((block) => block.lufs)
    .filter((value) => Number.isFinite(value) && value > -70)
    .sort((a, b) => b - a);
  if (!levels.length) return peak;
  const top = levels[Math.min(levels.length - 1, Math.max(4, Math.floor(levels.length * 0.001)))];
  return Math.min(peak, top + 12);
}

/** Chapters moved onto the working copy's clock: those inside the part, plus the one it starts in. */
export function workingChapters(
  chapters: Chapter[],
  range: Interval | undefined,
  seconds: number,
): Chapter[] {
  const ordered = [...chapters]
    .filter((item) => Number.isFinite(item.start) && item.title)
    .sort((a, b) => a.start - b.start);
  if (!range) return ordered.filter((item) => item.start >= 0 && item.start < seconds);
  const current = ordered.filter((item) => item.start <= range.start).at(-1);
  return [
    ...(current ? [{ start: 0, title: current.title }] : []),
    ...ordered
      .filter((item) => item.start > range.start && item.start < range.end)
      .map((item) => ({ start: item.start - range.start, title: item.title })),
  ];
}

/** Chapter times in the described copy, after the frozen pauses; later sections are dropped. */
export function outputChapters(chapters: Chapter[], records: SectionRecord[]): Chapter[] {
  const ordered = [...records].sort((a, b) => a.index - b.index);
  const result: Chapter[] = [];
  let offset = 0;
  for (const record of ordered) {
    for (const chapter of chapters)
      if (chapter.start >= record.start && chapter.start < record.end)
        result.push({
          start: offset + toOutput(chapter.start - record.start, record.placements),
          title: chapter.title,
        });
    offset += record.outputSeconds;
  }
  return result;
}

const frameOf = (seconds: number, fps: Rational) => Math.round((seconds * fps.num) / fps.den);
const secondsOf = (frames: number, fps: Rational) => (frames * fps.den) / fps.num;

/** Moves section boundaries onto the picture's frame grid so every join is frame-exact. */
export function alignSections(sections: Interval[], fps: Rational, seconds: number): Interval[] {
  const cuts = [0, ...sections.slice(1).map((item) => secondsOf(frameOf(item.start, fps), fps))];
  const unique = cuts.filter((cut, i) => i === 0 || cut - cuts[i - 1] >= 1);
  return unique.map((start, i) => ({ start, end: unique[i + 1] ?? seconds }));
}

/**
 * Picks the frame to freeze on: of the two frames around the pause point, the one that stays
 * inside the breath (20 ms after the word, 30 ms before the next), nearest the breath's middle.
 */
export function freezeFrame(point: number, words: Word[], fps: Rational, frames: number): number {
  const exact = (point * fps.num) / fps.den;
  const options = [Math.floor(exact), Math.ceil(exact)].map((frame) =>
    Math.min(frames - 1, Math.max(0, frame)),
  );
  const before = words.filter((word) => word.end <= point + 1e-6).at(-1)?.end;
  const after = words.find((word) => word.start >= point - 1e-6)?.start;
  const middle = before !== undefined && after !== undefined ? (before + after) / 2 : point;
  const low = (before ?? -Infinity) + 0.02;
  const high = (after ?? Infinity) - 0.03;
  const distance = (frame: number) => Math.abs(secondsOf(frame, fps) - middle);
  const fitting = options.filter((frame) => {
    const time = secondsOf(frame, fps);
    return time >= low && time <= high;
  });
  return (fitting.length ? fitting : options).sort((a, b) => distance(a) - distance(b))[0];
}

async function pool<T, R>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          results[index] = await work(items[index], index);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  return results;
}

const wait = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, milliseconds);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', stop, { once: true });
  });

/** How long a section that failed on a passing provider error waits before its second try. */
const lookRetryMilliseconds = () => {
  const seconds = Number(process.env.KADE_DESCRIPTION_RETRY_SECONDS);
  return (Number.isFinite(seconds) && seconds >= 0 ? seconds : 60) * 1000;
};
const voiceRetryMilliseconds = 1500;
/** Narration length per UTF-8 byte at 1x before this job's own clips have been measured. */
const seedSecondsPerByte = 0.0625;

type Voiced = { pcm: Float32Array; base: number };
type Looked = {
  analysis: Analysis | null;
  failure?: string;
  failureClass?: FailureClass;
  fatal?: Error;
  /** A failure kept from the copy being voiced again: final, and never paid for in this run. */
  reused?: boolean;
};
type Carried = { id: string; cue: Cue; clips: Map<Variant, Voiced> };
/**
 * A placement tagged with the script id of its description ("section:index" in the section's
 * analysis), so the script can say which descriptions were actually spoken.
 */
type Tagged = Placement & { id?: string };
const emptyContinuity: Continuity = { kind: '', setting: '', people: [], speakers: [], recent: [] };
const blank = (state: Continuity | null): Analysis => ({
  kind: state?.kind ?? '',
  setting: state?.setting ?? '',
  people: [],
  speakers: [],
  cues: [],
  protectedSounds: [],
});
const leftReasons: Record<Leftover | 'voice', string> = {
  room: 'No gap was long enough at the fastest narration speed chosen.',
  minor: 'Left out rather than pausing the video for a minor detail.',
  priority: 'Left out to make room for a more important description.',
  voice: 'The voice service did not return this description.',
};
/** Account problems (bad key, empty balance) stop the job instead of skipping a section. */
const accountProblem = (error: unknown) =>
  axios.isAxiosError(error) && [401, 402, 403].includes(error.response?.status ?? 0);
const within = (directory: string, file: string) => {
  const path = relative(directory, file);
  return !!path && !path.startsWith('..') && !isAbsolute(path);
};
const sameRange = (a?: Interval, b?: Interval) =>
  (!a && !b) ||
  (!!a && !!b && Math.abs(a.start - b.start) < 1e-6 && Math.abs(a.end - b.end) < 1e-6);
const overlap = (a: Interval, b: Interval) =>
  Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
const seconds1 = (value: number) => `${value.toFixed(1)} s`;

/** Deepgram key terms cost extra per minute, so they run only when KADE_DESCRIPTION_KEYTERMS=1. */
const keytermsWanted = (): boolean => process.env.KADE_DESCRIPTION_KEYTERMS === '1';

export async function describeVideo(request: Request): Promise<Outcome> {
  const { directory, settings, signal, progress, meter } = request;
  const providers = request.providers ?? productionProviders;
  const keeper = request.keeper ?? localKeeper();
  const log = request.log ?? (() => {});
  const safely = async (action: () => Promise<void> | undefined, what: string) => {
    try {
      await action();
    } catch (error) {
      log(
        `${what} could not be saved: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  };
  const working = await normalize(
    request.source,
    directory,
    signal,
    request.workingCopy ? undefined : settings.range,
    log,
  );
  const keptWorking =
    settings.range && !request.workingCopy
      ? safely(() => keeper.keepWorking?.(working.file), 'The cut part of the video')
      : undefined;
  if (working.file !== request.source && within(directory, request.source))
    await rm(request.source, { force: true });
  const source = working.file;
  const chapters = workingChapters(request.chapters ?? [], settings.range, working.media.seconds);
  const reusable = !!keeper.saved.plan && sameRange(keeper.saved.plan.range, settings.range);
  if (keeper.saved.plan && !reusable) log('The saved plan was for another part of the video.');
  const saved: Saved = reusable ? keeper.saved : { records: [] };
  let plan = saved.plan;
  let words = saved.words ?? [];
  if (!plan) {
    const media = working.media;
    await progress('Measuring the soundtrack', 1);
    const sound = media.audio ? await soundtrack(source, directory, signal, media) : null;
    await progress('Finding the dialogue', 3);
    let language: string | undefined;
    words = sound
      ? await providers.transcribe(sound.dialogue, media.seconds, signal, meter, {
          keyterms: keytermsWanted()
            ? keytermsFor({
                title: request.title,
                notes: settings.notes,
                about: request.about,
                chapters,
              })
            : [],
          onLanguage: (code) => {
            language = code;
          },
        })
      : [];
    if (sound) await rm(sound.dialogue, { force: true });
    const dialogue = sound?.momentary
      ? dialogueLoudness(sound.momentary, words, media.seconds)
      : undefined;
    const sections = planSections(media.seconds, words, 90, 60, 120, {
      cuts: sound?.cuts,
      chapters: chapters.map((item) => item.start),
    });
    plan = {
      version: 2,
      seconds: media.seconds,
      audio: media.audio,
      fps: media.fps,
      loudness: {
        program: sound?.program ?? -70,
        peak: sound ? steadyPeak(sound.peak, sound.momentary) : -70,
        ...(dialogue !== undefined ? { dialogue } : {}),
        ...(sound?.lra !== undefined ? { lra: sound.lra } : {}),
      },
      sections: alignSections(sections, media.fps, media.seconds),
      ...(settings.range ? { range: settings.range } : {}),
      ...(sound?.cuts?.length ? { cuts: sound.cuts } : {}),
      ...(sound?.stills?.length ? { stills: sound.stills } : {}),
      ...(language ? { language } : {}),
      ...(sound?.oneSided ? { oneSided: sound.oneSided } : {}),
    };
    await keeper.keepPlan(plan, words);
  }
  const fixed: Plan = plan;
  const media: Media = {
    ...working.media,
    ...(fixed.oneSided ? { oneSided: fixed.oneSided } : {}),
  };
  const count = fixed.sections.length;
  const limit = request.stopAfter;
  const active =
    limit === undefined
      ? count
      : Math.max(1, fixed.sections.filter((section) => section.start < limit).length);
  const partial = active < count;
  const fps = fixed.fps;
  const copyVideo = settings.mode === 'standard' && copyable(media);
  const levels = levelsFor(fixed, settings.volume);
  const preset = presets[settings.volume];
  const native = Math.min(1.5, settings.rate);
  const surveyed = !!settings.firstLook && !saved.analyses && fixed.seconds > 120 && count > 1;
  const surveyShare = surveyed ? 6 : 0;
  const share = (i: number, part: number) =>
    5 + surveyShare + ((i + part) / active) * (87 - surveyShare);
  const inSection = (section: Interval) =>
    words.filter((word) => word.start >= section.start && word.start < section.end);
  const cutsIn = (section: Interval) =>
    (fixed.cuts ?? [])
      .filter((time) => time >= section.start && time < section.end)
      .map((time) => time - section.start);
  const stills = fixed.stills ?? [];
  const seen = { main: new Set<number>(), survey: new Set<number>() };
  const stillOf = (section: Interval) =>
    stills.findIndex((still) => overlap(still, section) >= 0.95 * (section.end - section.start));
  const markSeen = (section: Interval, set: Set<number>) =>
    stills.forEach((still, k) => {
      if (overlap(still, section) >= 2) set.add(k);
    });
  const prior = fixed.secondsPerByte ?? seedSecondsPerByte;
  const measured = { bytes: 0, seconds: 0 };
  let secondsPerByte = prior;
  let keptSecondsPerByte = fixed.secondsPerByte;
  let voiceFailures = 0;
  const carried = new Map<number, Carried[]>();

  const briefFor = (i: number, survey: boolean, scale: number): Brief => {
    const section = fixed.sections[i];
    const cuts = cutsIn(section);
    const note = request.sectionNotes?.[i];
    return {
      title: request.title,
      about: request.about,
      notes: settings.notes,
      range: settings.range,
      detail: settings.detail,
      rate: settings.rate,
      maxRate: settings.maxRate,
      mode: settings.mode,
      survey,
      slowed: scale > 1,
      orientation: survey ? undefined : saved.firstLook?.state.people,
      position: { index: i, count, start: section.start, end: section.end, total: fixed.seconds },
      ...(chapters.length ? { chapters } : {}),
      ...(cuts.length ? { cuts } : {}),
      ...(fixed.language ? { language: fixed.language } : {}),
      secondsPerByte,
      ...(note ? { sectionNote: note } : {}),
    };
  };

  /** Maps a close look's slowed timeline back to the section and restores its minimum window. */
  const toSection = (analysis: Analysis, scale: number, seconds: number): Analysis => {
    if (scale === 1) return analysis;
    return {
      ...analysis,
      cues: analysis.cues.map((cue) => {
        const at = cue.at / scale;
        return {
          ...cue,
          at,
          until: Math.max(cue.until / scale, Math.min(seconds, at + 1.5)),
          pauseAt: cue.pauseAt === undefined ? undefined : cue.pauseAt / scale,
        };
      }),
      protectedSounds: analysis.protectedSounds.map((span) => ({
        start: span.start / scale,
        end: span.end / scale,
      })),
    };
  };

  async function look(
    i: number,
    state: Continuity | null,
    survey: boolean = false,
  ): Promise<Looked> {
    const section = fixed.sections[i];
    if (!survey) {
      const reused = saved.analyses?.[i];
      if (reused !== undefined) return { analysis: reused };
      const kept = saved.looks?.[i];
      if (kept?.analysis) {
        markSeen(section, seen.main);
        return { analysis: kept.analysis };
      }
      if (
        kept?.failure &&
        (saved.analyses || (kept.failureClass && kept.failureClass !== 'transient'))
      )
        return {
          analysis: null,
          failure: kept.failure,
          failureClass: kept.failureClass ?? 'transient',
          reused: true,
        };
    }
    const still = stillOf(section);
    if (still >= 0 && (survey ? seen.survey : seen.main).has(still)) {
      log(
        `Section ${i + 1} of ${count} shows the same still picture as before; not looked at again.`,
      );
      return { analysis: blank(state) };
    }
    const seconds = section.end - section.start;
    const dir = join(directory, `section-${i}`);
    const began = Date.now();
    try {
      await mkdir(dir, { recursive: true });
      const scale = settings.closeLook && !survey ? 4 : 1;
      const clip = await sectionClip(source, dir, section.start, seconds, signal, scale > 1, media);
      let analysis: Analysis;
      try {
        analysis = await providers.analyze(
          {
            file: clip,
            seconds: seconds * scale,
            brief: briefFor(i, survey, scale),
            state,
            lines: linesFrom(inSection(section), section.start).map((line) => ({
              ...line,
              start: line.start * scale,
              end: line.end * scale,
            })),
            before: linesFrom(
              words.filter(
                (word) => word.start >= section.start - 15 && word.start < section.start,
              ),
              section.start - 15,
            ).slice(-4),
            log,
          },
          signal,
          meter,
        );
      } finally {
        await rm(clip, { force: true });
      }
      const result = toSection(analysis, scale, seconds);
      markSeen(section, survey ? seen.survey : seen.main);
      log(
        `Section ${i + 1} of ${count}: ${survey ? 'first look' : 'looked'} in ${seconds1((Date.now() - began) / 1000)}.`,
      );
      const characters = result.people.filter(recognized).map((person) => person.name);
      if (characters.length)
        log(`Section ${i + 1} of ${count} recognized: ${characters.join(', ').slice(0, 100)}.`);
      if (!survey)
        await safely(
          () => keeper.keepLook?.(i, { analysis: result }),
          `The look at section ${i + 1}`,
        );
      return { analysis: result };
    } catch (error) {
      if (signal.aborted || error instanceof Halt) return { analysis: null, fatal: error as Error };
      const failure =
        error instanceof MediaError ? error.message : providerProblem(error, 'The video model');
      if (accountProblem(error)) return { analysis: null, failure, fatal: new Error(failure) };
      const kind: FailureClass = failureClass(error);
      log(`Section ${i + 1} of ${count} could not be described (${kind}): ${failure}`);
      return { analysis: null, failure, failureClass: kind };
    }
  }

  async function voice(text: string, file: string): Promise<Voiced | null> {
    try {
      await providers.synthesize(
        text,
        settings.voice,
        request.session,
        file,
        native,
        signal,
        meter,
      );
      const pcm = trimSilence(await decodeVoice(file, signal));
      voiceFailures = 0;
      if (pcm.length <= sampleRate * 0.2) return null;
      const base = pcmSeconds(pcm) * native;
      measured.bytes += bytes(text);
      measured.seconds += base;
      secondsPerByte = (prior * 200 + measured.seconds) / (200 + measured.bytes);
      return { pcm, base };
    } catch (error) {
      if (signal.aborted || error instanceof Halt) throw error;
      if (++voiceFailures >= 6)
        throw new Error(
          `${providerProblem(error, 'The voice service')} Six descriptions in a row could not be voiced.`,
        );
      return null;
    } finally {
      await rm(file, { force: true });
    }
  }

  const records = new Map<number, SectionRecord>();
  const savedRecords = new Map(saved.records.map((record) => [record.index, record]));
  const neighbour = (index: number) => records.get(index) ?? savedRecords.get(index);
  const spoken = (record: SectionRecord) =>
    record.placements.map((item) => ({ start: item.outputAt, end: item.outputAt + item.duration }));

  /**
   * Keeps room at section joins: the soundtrack must be back up before a section ends, and a
   * description may not start right after one that ended at the end of the previous section.
   */
  function edgeGuards(i: number, seconds: number): Interval[] {
    const guards: Interval[] = [];
    if (i > 0) {
      const previous = neighbour(i - 1);
      const tail = previous
        ? spoken(previous).reduce(
            (gap, span) => Math.min(gap, previous.outputSeconds - span.end),
            Infinity,
          )
        : Infinity;
      guards.push({ start: 0, end: Math.max(0.25, 0.35 - tail) });
    }
    if (i < count - 1) {
      const next = neighbour(i + 1);
      const head = next
        ? spoken(next).reduce((gap, span) => Math.min(gap, span.start), Infinity)
        : Infinity;
      guards.push({ start: seconds - Math.max(0.25, 0.35 - head), end: seconds });
    }
    return guards;
  }

  async function render(
    i: number,
    looked: Looked,
    stateIn: Continuity | null,
    late: boolean = false,
    onPlaced?: (continuity: Continuity) => void,
  ): Promise<SectionRecord> {
    const section = fixed.sections[i];
    const seconds = section.end - section.start;
    const dir = join(directory, `section-${i}`);
    const began = Date.now();
    const at = (part: number) => (late ? 92 : share(i, part));
    await mkdir(dir, { recursive: true });
    const sectionWords = inSection(section).map((word) => ({
      ...word,
      start: word.start - section.start,
      end: Math.min(seconds, word.end - section.start),
    }));
    const analysis = looked.analysis;
    const sectionCuts = cutsIn(section);
    const incoming = carried.get(i) ?? [];
    carried.delete(i);
    const gate = analysis
      ? gateCues({
          cues: snapToCuts(analysis.cues, sectionCuts),
          people: analysis.people,
          state: stateIn,
          words,
          notes: settings.notes,
          sectionStart: section.start,
          reference: saved.firstLook?.state.people,
        })
      : undefined;
    const gated = gate?.cues ?? [];
    const cues = [...incoming.map((item) => item.cue), ...gated];
    const ids = [
      ...incoming.map((item) => item.id),
      ...gated.map((_cue, index) => `${i}:${index}`),
    ];
    const protectedSounds = analysis?.protectedSounds ?? [];
    const blocked = mergeIntervals(
      [
        ...mergeIntervals(sectionWords, seconds, 0.22),
        ...mergeIntervals(protectedSounds, seconds, 0.1),
        ...edgeGuards(i, seconds),
      ],
      seconds,
    );
    await progress(`Voicing section ${i + 1} of ${count}`, at(0.3));
    const key = (index: number, variant: Variant) => `${index}:${variant}`;
    const clips = new Map<string, Voiced>();
    incoming.forEach((item, index) =>
      item.clips.forEach((clip, variant) => clips.set(key(index, variant), clip)),
    );
    const failing = new Set<string>();
    const failed = new Set<string>();
    const textOf = (index: number, variant: Variant) =>
      variant === 'full' ? cues[index].text : cues[index].shortText;
    const estimate = (index: number, variant: Variant) =>
      bytes(textOf(index, variant)) * secondsPerByte;
    const length = (index: number, variant: Variant) => clips.get(key(index, variant))?.base;
    const ratio = (index: number) => {
      const variant = (['full', 'short'] as const).find((item) => clips.has(key(index, item)));
      return variant ? (length(index, variant) ?? 0) / estimate(index, variant) : undefined;
    };
    const earliest = i > 0 ? edgeGuards(i, seconds)[0].end : undefined;
    const layout = (
      measure: (index: number, variant: Variant) => number | undefined,
      prefer?: (index: number) => Variant | undefined,
    ) =>
      arrange({
        cues,
        length: measure,
        settings,
        blocked,
        hard: protectedSounds,
        words: sectionWords,
        seconds,
        cuts: sectionCuts,
        prefer,
        earliest,
      });
    const speak = async (wanted: { index: number; variant: Variant }[], suffix: string) => {
      const names = wanted.map((item) => key(item.index, item.variant));
      const fresh = wanted.filter(
        (_item, n) =>
          !clips.has(names[n]) &&
          !failing.has(names[n]) &&
          !failed.has(names[n]) &&
          names.indexOf(names[n]) === n,
      );
      await pool(fresh, request.voices ?? 2, async (item, n) => {
        const name = key(item.index, item.variant);
        const clip = await voice(
          textOf(item.index, item.variant),
          join(dir, `voice-${n}${suffix}.wav`),
        );
        if (clip) clips.set(name, clip);
        else failing.add(name);
      });
    };
    const planned = layout(estimate);
    const hopeful = layout((index, variant) => estimate(index, variant) * 0.8);
    const unplanned = new Set(planned.left.map((item) => item.index));
    await speak(
      [...planned.placed, ...hopeful.placed.filter((item) => unplanned.has(item.index))],
      'a',
    );
    const corrected = layout(
      (index, variant) => {
        if (failed.has(key(index, variant))) return undefined;
        return length(index, variant) ?? estimate(index, variant) * (ratio(index) ?? 1);
      },
      (index) => {
        const off = ratio(index);
        if (off === undefined || Math.abs(off - 1) > 0.1) return undefined;
        return clips.has(key(index, 'full')) ? 'full' : 'short';
      },
    );
    await speak(corrected.placed, 'b');
    if (failing.size) {
      log(`Section ${i + 1} of ${count}: trying ${failing.size} dropped voice clip(s) once more.`);
      await wait(voiceRetryMilliseconds, signal);
      const retry = [...failing].map((name) => {
        const [index, variant] = name.split(':');
        return { index: Number(index), variant: variant as Variant };
      });
      await pool(retry, 1, async (item, n) => {
        const name = key(item.index, item.variant);
        const clip = await voice(textOf(item.index, item.variant), join(dir, `retry-${n}.wav`));
        failing.delete(name);
        if (clip) clips.set(name, clip);
        else failed.add(name);
      });
    }
    let final = layout(length);
    for (let pass = 0; gate && pass < cues.length; pass++) {
      const changes = gate.rejoin(
        final.placed.map((item) => ({
          cue: cues[item.index],
          spoken: textOf(item.index, item.variant),
        })),
      );
      if (!changes.some(Boolean)) break;
      changes.forEach((change, index) => {
        if (!change) return;
        const cueIndex = final.placed[index].index;
        cues[cueIndex] = change;
        clips.delete(key(cueIndex, 'full'));
        clips.delete(key(cueIndex, 'short'));
      });
      await speak(final.placed, `join-${pass}`);
      final = layout(length);
    }
    const skipped: (Skip & { id?: string })[] = [];
    const left: string[] = [];
    const nextCut = i + 1 < count ? cutsIn(fixed.sections[i + 1])[0] : undefined;
    for (const item of final.left) {
      const cue = cues[item.index];
      const voiceLost =
        failed.has(key(item.index, 'short')) ||
        (failed.has(key(item.index, 'full')) && !clips.has(key(item.index, 'short')));
      const shotEnds = (fixed.cuts ?? []).some(
        (time) => time > section.start + cue.at + 0.05 && time <= section.end + 0.3,
      );
      const carry =
        !voiceLost &&
        item.reason !== 'priority' &&
        cue.until >= seconds - 0.25 &&
        !shotEnds &&
        i + 1 < active &&
        !savedRecords.has(i + 1) &&
        !records.has(i + 1);
      if (carry) {
        const kept = new Map<Variant, Voiced>();
        for (const variant of ['full', 'short'] as const) {
          const clip = clips.get(key(item.index, variant));
          if (clip) kept.set(variant, clip);
        }
        carried.set(i + 1, [
          ...(carried.get(i + 1) ?? []),
          {
            id: ids[item.index],
            cue: { ...cue, at: 0, until: Math.min(4, nextCut ?? 4), pauseAt: 0 },
            clips: kept,
          },
        ]);
        continue;
      }
      left.push(cue.text);
      skipped.push({
        at: cue.at + section.start,
        text: cue.text,
        reason: leftReasons[voiceLost ? 'voice' : item.reason],
        id: ids[item.index],
      });
    }
    const placed = final.placed.flatMap((item) => {
      const clip = clips.get(key(item.index, item.variant));
      const placement: Tagged = { ...item.placement, id: ids[item.index] };
      return clip ? [{ placement, clip }] : [];
    });
    clips.clear();
    const sourceFrames = copyVideo ? 0 : frameOf(section.end, fps) - frameOf(section.start, fps);
    const aligned = placed
      .map(({ placement, clip }) => {
        if (!placement.pause || copyVideo) return { placement, clip };
        let frame = freezeFrame(placement.pauseAt, sectionWords, fps, sourceFrames);
        if (secondsOf(frame, fps) < placement.at && placement.pauseAt > placement.at)
          frame = Math.min(sourceFrames - 1, Math.ceil((placement.at * fps.num) / fps.den));
        const pauseAt = secondsOf(frame, fps);
        const pause = secondsOf(Math.max(1, Math.ceil((placement.pause * fps.num) / fps.den)), fps);
        const at =
          placement.pauseAt === placement.at || pauseAt < placement.at ? pauseAt : placement.at;
        return { placement: { ...placement, at, pauseAt, pause }, clip };
      })
      .sort((a, b) => a.placement.at - b.placement.at || a.placement.pauseAt - b.placement.pauseAt);
    const heard: Heard = {
      spoken: aligned.map((item) => item.placement.text),
      left,
      sectionIndex: i,
      sectionStart: section.start,
      sectionEnd: section.end,
      words,
      notes: settings.notes,
    };
    const continuity =
      analysis || aligned.length
        ? nextContinuity(stateIn, analysis ?? blank(stateIn), heard)
        : (stateIn ?? emptyContinuity);
    onPlaced?.(continuity);
    const timeline = outputTimeline(aligned.map((item) => item.placement));
    await progress(`Mixing section ${i + 1} of ${count}`, at(0.75));
    const pauses = timeline.filter((item) => item.pause > 0);
    const pausedFrames = pauses.reduce(
      (sum, item) => sum + Math.round((item.pause * fps.num) / fps.den),
      0,
    );
    const sourceSamples = copyVideo
      ? Math.round(section.end * sampleRate) - Math.round(section.start * sampleRate)
      : Math.round(secondsOf(sourceFrames, fps) * sampleRate);
    const outputSamples = copyVideo
      ? sourceSamples
      : Math.round(secondsOf(sourceFrames + pausedFrames, fps) * sampleRate);
    const sound = join(dir, 'sound.flac');
    const placements = await mixSection({
      section,
      dir,
      sectionWords,
      protectedSounds,
      timeline,
      clips: aligned.map((item) => item.clip),
      sourceSamples,
      outputSamples,
      sound,
    });
    const picture = copyVideo
      ? undefined
      : await sectionPicture(
          source,
          dir,
          i,
          section.start,
          sourceFrames,
          fps,
          pauses.map<Freeze>((item) => ({
            frame: frameOf(item.pauseAt, fps),
            frames: Math.round((item.pause * fps.num) / fps.den),
          })),
          signal,
          media,
        );
    const record: SectionRecord = {
      index: i,
      start: section.start,
      end: section.end,
      analysis,
      ...(looked.failure
        ? { failure: looked.failure, failureClass: looked.failureClass ?? 'transient' }
        : {}),
      placements,
      skipped: skipped.sort((a, b) => a.at - b.at),
      outputSeconds: outputSamples / sampleRate,
      continuity,
    };
    await keeper.keepSection(record, { sound, picture });
    log(
      `Section ${i + 1} of ${count}: finished in ${seconds1((Date.now() - began) / 1000)} with ${placements.length} description(s)${skipped.length ? `, ${skipped.length} left out` : ''}.`,
    );
    if (
      measured.bytes &&
      (keptSecondsPerByte === undefined || Math.abs(secondsPerByte / keptSecondsPerByte - 1) > 0.05)
    ) {
      keptSecondsPerByte = secondsPerByte;
      const update = { ...fixed, secondsPerByte };
      await safely(() => keeper.keepPlan(update, words), 'The measured narration speed');
    }
    return record;
  }

  /**
   * Builds and saves one section's sound: its own soundtrack with the pauses laid in, each line
   * ducked by how loud the soundtrack is under it, lowered only after a protected sound ends and
   * released before the next dialogue word or protected sound, and the narration on top. The
   * large buffers live only inside this call.
   */
  async function mixSection(input: {
    section: Interval;
    dir: string;
    sectionWords: Word[];
    protectedSounds: Interval[];
    timeline: Placement[];
    clips: Voiced[];
    sourceSamples: number;
    outputSamples: number;
    sound: string;
  }): Promise<Placement[]> {
    const { sectionWords, timeline } = input;
    const previousEnd = (time: number) =>
      sectionWords.filter((word) => word.end <= time + 1e-6).at(-1)?.end ?? -Infinity;
    const nextStart = (time: number) =>
      sectionWords.find((word) => word.start >= time - 1e-6)?.start ?? Infinity;
    const pauses: Pause[] = timeline
      .filter((item) => item.pause > 0)
      .map((item) => ({
        at: item.pauseAt,
        length: item.pause,
        fadeOut: clamp(item.pauseAt - previousEnd(item.pauseAt) - 0.005, 0.01, 0.035),
        fadeIn: clamp(nextStart(item.pauseAt) - item.pauseAt - 0.01, 0.01, 0.06),
      }));
    const paused = pauseProgram(
      await sectionSound(
        source,
        input.dir,
        input.section.start,
        input.sourceSamples,
        fixed.audio,
        signal,
        media,
      ),
      pauses,
      input.outputSamples,
    );
    await rm(join(input.dir, 'sound.f32'), { force: true });
    const guarded = [...sectionWords, ...input.protectedSounds]
      .map((span) => toOutput(span.start, timeline))
      .sort((a, b) => a - b);
    const protectedEnds = input.protectedSounds.map((span) => toOutput(span.end, timeline));
    const placements: Placement[] = [];
    const clips: { at: number; pcm: Float32Array }[] = [];
    const ducks: Duck[] = [];
    for (let j = 0; j < timeline.length; j++) {
      const placement = timeline[j];
      const sped = await stretch(input.clips[j].pcm, placement.rate / native, signal);
      const pcm = level(sped, levels.narration - 3.01);
      const duration = pcmSeconds(pcm);
      clips.push({ at: placement.outputAt, pcm });
      const frozen = placement.pause > 0 && placement.pauseAt === placement.at;
      if (frozen) {
        placements.push({ ...placement, duration });
        continue;
      }
      const end =
        placement.outputAt + (placement.pause > 0 ? placement.pauseAt - placement.at : duration);
      const under = fixed.audio
        ? shortTermMax(paused, placement.outputAt, end) + levels.gain
        : -Infinity;
      const dip = duckDepth(under, levels.narration, preset.depth, preset.floor);
      const next = guarded.find((time) => time >= end - 1e-6) ?? Infinity;
      const held = protectedEnds
        .filter((time) => time <= placement.outputAt + 1e-6)
        .reduce((latest, time) => Math.max(latest, time), -Infinity);
      placements.push({ ...placement, duration, dip });
      ducks.push({
        start: placement.outputAt,
        end,
        gain: decibels(dip),
        attack: clamp(placement.outputAt - held - 0.05, 0.05, 0.25),
        release: clamp(next - end - 0.05, 0.15, 0.5),
      });
    }
    await saveSound(
      mix(paused, decibels(levels.gain), bridgeDucks(ducks, guarded), clips),
      input.sound,
      signal,
    );
    await rm(input.sound + '.f32', { force: true });
    return placements;
  }

  if (surveyed) {
    let first = saved.firstLook ?? { through: 0, state: emptyContinuity };
    for (let i = first.through; i < active; i++) {
      await progress(`First look: section ${i + 1} of ${active}`, 4 + (i / active) * surveyShare);
      const result = await look(i, first.state, true);
      if (result.fatal) throw result.fatal;
      if (!result.analysis)
        log(
          `First look skipped section ${i + 1} of ${active} (${result.failureClass ?? 'unknown'}): ${result.failure ?? 'no reply'}`,
        );
      first = {
        through: i + 1,
        state: result.analysis ? nextContinuity(first.state, result.analysis) : first.state,
      };
      await keeper.keepFirstLook?.(first);
      saved.firstLook = first;
    }
  }

  let state: Continuity | null = null;
  let failures = 0;
  const ahead = new Map<number, Promise<Looked>>();
  const deferred: { index: number; state: Continuity | null; at: number }[] = [];
  for (let i = 0; i < active; i++) {
    signal.throwIfAborted();
    const done = savedRecords.get(i);
    if (done) {
      records.set(i, done);
      if (done.analysis) markSeen(fixed.sections[i], seen.main);
      state = done.continuity;
      failures = 0;
      continue;
    }
    await progress(`Watching section ${i + 1} of ${count}`, share(i, 0));
    const section = fixed.sections[i];
    log(`Section ${i + 1} of ${count} (${clock(section.start)} to ${clock(section.end)}) started.`);
    const looked: Looked = (await ahead.get(i)) ?? (await look(i, state));
    ahead.delete(i);
    if (looked.fatal) throw looked.fatal;
    failures = looked.failure && !looked.reused ? failures + 1 : 0;
    if (failures >= 3)
      throw new Error(
        `${looked.failure} Three sections in a row could not be described, so the job stopped.`,
      );
    const lookAhead = (from: Continuity | null) => {
      if (i + 1 < active && !savedRecords.has(i + 1)) ahead.set(i + 1, look(i + 1, from));
    };
    if (!looked.analysis) lookAhead(state);
    if (looked.failureClass === 'transient' && !looked.reused) {
      deferred.push({ index: i, state, at: Date.now() });
      continue;
    }
    try {
      const record = await render(i, looked, state, false, (continuity) => {
        if (looked.analysis) lookAhead(continuity);
      });
      records.set(i, record);
      state = record.continuity;
    } catch (error) {
      await Promise.all(ahead.values());
      throw error;
    }
  }
  for (const item of deferred) {
    const remaining = lookRetryMilliseconds() - (Date.now() - item.at);
    if (remaining > 0) {
      await progress(`Waiting to try section ${item.index + 1} again`, 92);
      await wait(remaining, signal);
    }
    await progress(`Trying section ${item.index + 1} again`, 92);
    log(`Section ${item.index + 1} of ${count}: trying again after a passing provider error.`);
    const looked = await look(item.index, item.state);
    if (looked.fatal) throw looked.fatal;
    records.set(item.index, await render(item.index, looked, item.state, true));
  }

  await keptWorking;
  const ordered = [...records.values()].sort((a, b) => a.index - b.index);
  await progress('Joining the finished sections', 93);
  const files = await pool(ordered, 4, async (record) => {
    const dir = join(directory, `section-${record.index}`);
    if (!savedRecords.has(record.index))
      return {
        sound: join(dir, 'sound.flac'),
        picture: copyVideo ? undefined : join(dir, `part-${record.index}.mp4`),
      };
    await mkdir(dir, { recursive: true });
    return keeper.restore(record.index, dir);
  });
  const report = buildReport(
    request.title,
    keptSecondsPerByte === undefined ? fixed : { ...fixed, secondsPerByte: keptSecondsPerByte },
    levels,
    settings,
    ordered,
    words,
    {
      ...(partial ? { preview: true } : {}),
      ...(settings.range ? { range: settings.range } : {}),
    },
  );
  const reportFile = join(directory, 'description.json');
  const transcript = join(directory, 'transcript.txt');
  const descriptions = join(directory, 'descriptions.vtt');
  const captions = join(directory, 'captions.vtt');
  await writeFile(reportFile, JSON.stringify(report, null, 2));
  await writeFile(transcript, transcriptText(report));
  await writeFile(descriptions, descriptionTrack(report));
  await writeFile(captions, captionTrack(report));
  if (!copyVideo && source !== request.source && within(directory, source))
    await rm(source, { force: true });
  const output = await assemble(
    directory,
    files.map((file) => file.sound),
    copyVideo ? null : files.map((file) => file.picture || ''),
    source,
    `${request.title || 'Video'} (described)`,
    signal,
    {
      media,
      subtitles: [
        ...(report.dialogue.length
          ? [
              {
                file: captions,
                language: report.language ?? fixed.language ?? 'und',
                title: 'Captions',
              },
            ]
          : []),
        ...(report.descriptions.length
          ? [{ file: descriptions, language: 'en', title: 'Audio descriptions (text)' }]
          : []),
      ],
      chapters: outputChapters(chapters, ordered),
    },
  );
  return {
    ...output,
    files: { report: reportFile, transcript, descriptions, captions },
    report,
    partial,
  };
}
