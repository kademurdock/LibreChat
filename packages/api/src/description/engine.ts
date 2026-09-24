import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import type {
  Analysis,
  Continuity,
  Cue,
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
import type { Freeze, Rational } from './media';
import type { Look } from './providers';
import {
  assemble,
  copyable,
  decodeVoice,
  probe,
  saveSound,
  sectionClip,
  sectionPicture,
  sectionSound,
  soundtrack,
  stretch,
} from './media';
import {
  fitCue,
  pauseCue,
  pausePoint,
  toOutput,
  planSections,
  mergeIntervals,
  outputTimeline,
} from './timing';
import {
  decibels,
  duckCurve,
  level,
  mix,
  pauseProgram,
  pcmSeconds,
  sampleRate,
  trimSilence,
} from './mix';
import { analyze, linesFrom, providerProblem, synthesize, transcribe } from './providers';
import { captionTrack, descriptionTrack, transcriptText } from './transcript';
import { nextContinuity } from './prompt';
import { Halt } from './types';

export type Providers = {
  transcribe: (file: string, seconds: number, signal: AbortSignal, meter: Meter) => Promise<Word[]>;
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
/** What an earlier run left behind: the plan, the dialogue, finished sections, or analyses to reuse. */
export type Saved = {
  plan?: Plan;
  words?: Word[];
  records: SectionRecord[];
  analyses?: (Analysis | null)[];
};
/** Persistence for long jobs, so a restart continues instead of starting over. */
export type Keeper = {
  saved: Saved;
  keepPlan: (plan: Plan, words: Word[]) => Promise<void>;
  keepSection: (record: SectionRecord, files: SectionFiles) => Promise<void>;
  restore: (index: number, directory: string) => Promise<SectionFiles>;
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
};
export type Outcome = {
  video: string;
  audio: string;
  files: { report: string; transcript: string; descriptions: string; captions: string };
  report: Report;
};

const volume: Record<Settings['volume'], { lift: number; duck: number }> = {
  softer: { lift: 0, duck: -6 },
  balanced: { lift: 2, duck: -8 },
  louder: { lift: 5, duck: -11 },
};

/**
 * Evens out the finished copy: the soundtrack is brought toward -20 LUFS (never more than
 * 6 dB into the peak limiter), and the narrator sits just above it.
 */
export function levelsFor(plan: Plan, choice: Settings['volume']): Levels {
  const { lift, duck } = volume[choice];
  if (!plan.audio || plan.loudness.program <= -69) return { gain: 0, narration: -18 + lift, duck };
  const gain = Math.min(12, 5 - plan.loudness.peak, Math.max(-12, -20 - plan.loudness.program));
  return {
    gain,
    narration: Math.min(-13, Math.max(-26, plan.loudness.program + gain + lift)),
    duck,
  };
}

const frameOf = (seconds: number, fps: Rational) => Math.round((seconds * fps.num) / fps.den);
const secondsOf = (frames: number, fps: Rational) => (frames * fps.den) / fps.num;

/** Moves section boundaries onto the picture's frame grid so every join is frame-exact. */
export function alignSections(sections: Interval[], fps: Rational, seconds: number): Interval[] {
  const cuts = [0, ...sections.slice(1).map((item) => secondsOf(frameOf(item.start, fps), fps))];
  const unique = cuts.filter((cut, i) => i === 0 || cut - cuts[i - 1] >= 1);
  return unique.map((start, i) => ({ start, end: unique[i + 1] ?? seconds }));
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

type Voiced = { pcm: Float32Array; base: number };
type Looked = { analysis: Analysis | null; failure?: string; fatal?: Error };
const emptyContinuity: Continuity = { kind: '', setting: '', people: [], speakers: [], recent: [] };
/** Account problems (bad key, empty balance) stop the job instead of skipping a section. */
const permanent = (problem: string) => /HTTP (401|402|403)\)/.test(problem);

export async function describeVideo(request: Request): Promise<Outcome> {
  const { source, directory, settings, signal, progress, meter } = request;
  const providers = request.providers ?? productionProviders;
  const keeper = request.keeper ?? localKeeper();
  const media = await probe(source, signal);
  let plan = keeper.saved.plan;
  let words = keeper.saved.words ?? [];
  if (!plan) {
    await progress('Measuring the soundtrack', 1);
    const sound = media.audio ? await soundtrack(source, directory, signal) : null;
    await progress('Finding the dialogue', 3);
    words = sound ? await providers.transcribe(sound.dialogue, media.seconds, signal, meter) : [];
    if (sound) await rm(sound.dialogue, { force: true });
    plan = {
      version: 2,
      seconds: media.seconds,
      audio: media.audio,
      fps: media.fps,
      loudness: { program: sound?.program ?? -70, peak: sound?.peak ?? -70 },
      sections: alignSections(planSections(media.seconds, words), media.fps, media.seconds),
    };
    await keeper.keepPlan(plan, words);
  }
  const fixed = plan;
  const count = fixed.sections.length;
  const fps = fixed.fps;
  const copyVideo = settings.mode === 'standard' && copyable(media);
  const levels = levelsFor(fixed, settings.volume);
  const native = Math.min(1.5, settings.rate);
  const brief = {
    title: request.title,
    about: request.about,
    notes: settings.notes,
    detail: settings.detail,
    rate: settings.rate,
    maxRate: settings.maxRate,
    mode: settings.mode,
  };
  const share = (i: number, part: number) => 5 + ((i + part) / count) * 87;
  const inSection = (section: Interval) =>
    words.filter((word) => word.start >= section.start && word.start < section.end);
  let voiceFailures = 0;

  async function look(i: number, state: Continuity | null): Promise<Looked> {
    const reused = keeper.saved.analyses?.[i];
    if (reused !== undefined) return { analysis: reused };
    const section = fixed.sections[i];
    const dir = join(directory, `section-${i}`);
    try {
      await mkdir(dir, { recursive: true });
      const clip = await sectionClip(
        source,
        dir,
        section.start,
        section.end - section.start,
        signal,
      );
      const analysis = await providers.analyze(
        {
          file: clip,
          seconds: section.end - section.start,
          brief,
          state,
          lines: linesFrom(inSection(section), section.start),
          before: linesFrom(
            words.filter((word) => word.start >= section.start - 15 && word.start < section.start),
            section.start - 15,
          ).slice(-4),
        },
        signal,
        meter,
      );
      await rm(clip, { force: true });
      return { analysis };
    } catch (error) {
      if (signal.aborted || error instanceof Halt) return { analysis: null, fatal: error as Error };
      const failure = providerProblem(error, 'The video model');
      return {
        analysis: null,
        failure,
        fatal: permanent(failure) ? new Error(failure) : undefined,
      };
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
      await rm(file, { force: true });
      voiceFailures = 0;
      return pcm.length > sampleRate * 0.2 ? { pcm, base: pcmSeconds(pcm) * native } : null;
    } catch (error) {
      if (signal.aborted || error instanceof Halt) throw error;
      if (++voiceFailures >= 6)
        throw new Error(
          `${providerProblem(error, 'The voice service')} Six descriptions in a row could not be voiced.`,
        );
      return null;
    }
  }

  async function place(
    cues: Cue[],
    voiced: (Voiced | null)[],
    sectionWords: Word[],
    protectedSounds: Interval[],
    seconds: number,
    dir: string,
    offset: number,
  ) {
    const blocked = mergeIntervals(
      [
        ...mergeIntervals(sectionWords, seconds, 0.22),
        ...mergeIntervals(protectedSounds, seconds, 0.1),
      ],
      seconds,
    );
    const hard: Interval[] = [...protectedSounds];
    const placed: { placement: Placement; clip: Voiced }[] = [];
    const skipped: Skip[] = [];
    const order = cues
      .map((cue, index) => ({ cue, index }))
      .sort((a, b) => b.cue.importance - a.cue.importance || a.cue.at - b.cue.at);
    for (const { cue, index } of order) {
      const full = voiced[index];
      if (!full) {
        skipped.push({
          at: cue.at + offset,
          text: cue.text,
          reason: 'The voice service did not return this description.',
        });
        continue;
      }
      let clip = full;
      let placement = fitCue(cue, cue.text, full.base, settings, blocked, seconds);
      if (!placement && cue.shortText && cue.shortText !== cue.text) {
        const short = await voice(cue.shortText, join(dir, `short-${index}.wav`));
        const fitted = short && fitCue(cue, cue.shortText, short.base, settings, blocked, seconds);
        if (short && fitted) {
          placement = { ...fitted, shortened: true };
          clip = short;
        }
      }
      if (!placement && settings.mode === 'extended' && cue.importance === 1) {
        skipped.push({
          at: cue.at + offset,
          text: cue.text,
          reason: 'Left out rather than pausing the video for a minor detail.',
        });
        continue;
      }
      if (!placement && settings.mode === 'extended') {
        const point = pausePoint(cue, sectionWords, hard, seconds);
        placement = pauseCue(cue, cue.text, full.base, settings, point, blocked);
        clip = full;
      }
      if (!placement) {
        skipped.push({
          at: cue.at + offset,
          text: cue.text,
          reason: 'No gap was long enough at the fastest narration speed chosen.',
        });
        continue;
      }
      const span = placement.pause
        ? { start: placement.at - 0.05, end: placement.pauseAt + 0.05 }
        : { start: placement.at, end: placement.at + placement.duration + 0.1 };
      blocked.push(span);
      hard.push(span);
      placed.push({ placement, clip });
    }
    return { placed, skipped };
  }

  async function render(i: number, looked: Looked, continuity: Continuity): Promise<SectionRecord> {
    const section = fixed.sections[i];
    const seconds = section.end - section.start;
    const dir = join(directory, `section-${i}`);
    await mkdir(dir, { recursive: true });
    const sectionWords = inSection(section).map((word) => ({
      ...word,
      start: word.start - section.start,
      end: Math.min(seconds, word.end - section.start),
    }));
    const cues = looked.analysis?.cues ?? [];
    await progress(`Voicing section ${i + 1} of ${count}`, share(i, 0.3));
    const voiced = await pool(cues, request.voices ?? 2, (cue, j) =>
      voice(cue.text, join(dir, `voice-${j}.wav`)),
    );
    const { placed, skipped } = await place(
      cues,
      voiced,
      sectionWords,
      looked.analysis?.protectedSounds ?? [],
      seconds,
      dir,
      section.start,
    );
    const sourceFrames = copyVideo ? 0 : frameOf(section.end, fps) - frameOf(section.start, fps);
    const aligned = placed.map(({ placement, clip }) => {
      if (!placement.pause || copyVideo) return { placement, clip };
      let frame = Math.min(sourceFrames - 1, Math.max(0, frameOf(placement.pauseAt, fps)));
      if (secondsOf(frame, fps) < placement.at && placement.pauseAt > placement.at)
        frame = Math.min(sourceFrames - 1, Math.ceil((placement.at * fps.num) / fps.den));
      const pauseAt = secondsOf(frame, fps);
      const pause = secondsOf(Math.max(1, Math.ceil((placement.pause * fps.num) / fps.den)), fps);
      const at =
        placement.pauseAt === placement.at || pauseAt < placement.at ? pauseAt : placement.at;
      return { placement: { ...placement, at, pauseAt, pause }, clip };
    });
    aligned.sort(
      (a, b) => a.placement.at - b.placement.at || a.placement.pauseAt - b.placement.pauseAt,
    );
    const timeline = outputTimeline(aligned.map((item) => item.placement));
    await progress(`Mixing section ${i + 1} of ${count}`, share(i, 0.75));
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
    const program = await sectionSound(
      source,
      dir,
      section.start,
      sourceSamples,
      fixed.audio,
      signal,
    );
    await rm(join(dir, 'sound.f32'), { force: true });
    const paused = pauseProgram(
      program,
      pauses.map((item) => ({ at: item.pauseAt, length: item.pause })),
      outputSamples,
    );
    const placements: Placement[] = [];
    const clips: { at: number; pcm: Float32Array }[] = [];
    for (let j = 0; j < timeline.length; j++) {
      const placement = timeline[j];
      const sped = await stretch(aligned[j].clip.pcm, placement.rate / native, signal);
      const pcm = level(sped, levels.narration - 3.01);
      placements.push({ ...placement, duration: pcmSeconds(pcm) });
      clips.push({ at: placement.outputAt, pcm });
    }
    const curve = duckCurve(
      outputSamples,
      placements.map((item) => ({ start: item.outputAt, end: item.outputAt + item.duration })),
      decibels(levels.duck),
    );
    const sound = join(dir, 'sound.flac');
    await saveSound(mix(paused, decibels(levels.gain), curve, clips), sound, signal);
    await rm(sound + '.f32', { force: true });
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
        );
    const record: SectionRecord = {
      index: i,
      start: section.start,
      end: section.end,
      analysis: looked.analysis,
      failure: looked.failure,
      placements,
      skipped: skipped.sort((a, b) => a.at - b.at),
      outputSeconds: outputSamples / sampleRate,
      continuity,
    };
    await keeper.keepSection(record, { sound, picture });
    return record;
  }

  const saved = new Map(keeper.saved.records.map((record) => [record.index, record]));
  const records: SectionRecord[] = [];
  let state: Continuity | null = null;
  let failures = 0;
  let ahead: Promise<Looked> | null = null;
  for (let i = 0; i < count; i++) {
    signal.throwIfAborted();
    const done = saved.get(i);
    if (done) {
      records.push(done);
      state = done.continuity;
      continue;
    }
    await progress(`Watching section ${i + 1} of ${count}`, share(i, 0));
    const looked: Looked = await (ahead ?? look(i, state));
    ahead = null;
    if (looked.fatal) throw looked.fatal;
    failures = looked.failure ? failures + 1 : 0;
    if (failures >= 3)
      throw new Error(
        `${looked.failure} Three sections in a row could not be described, so the job stopped.`,
      );
    const continuity: Continuity = looked.analysis
      ? nextContinuity(state, looked.analysis)
      : (state ?? emptyContinuity);
    if (i + 1 < count && !saved.has(i + 1)) ahead = look(i + 1, continuity);
    try {
      records.push(await render(i, looked, continuity));
    } catch (error) {
      if (ahead) await ahead;
      throw error;
    }
    state = continuity;
  }

  await progress('Joining the finished sections', 93);
  const files = await Promise.all(
    records.map(async (record) => {
      const dir = join(directory, `section-${record.index}`);
      if (!saved.has(record.index))
        return {
          sound: join(dir, 'sound.flac'),
          picture: copyVideo ? undefined : join(dir, `part-${record.index}.mp4`),
        };
      await mkdir(dir, { recursive: true });
      return keeper.restore(record.index, dir);
    }),
  );
  const title = `${request.title || 'Video'} (described)`;
  const output = await assemble(
    directory,
    files.map((file) => file.sound),
    copyVideo ? null : files.map((file) => file.picture || ''),
    source,
    title,
    signal,
  );
  const report = buildReport(request.title, fixed, levels, settings, records, words);
  const reportFile = join(directory, 'description.json');
  const transcript = join(directory, 'transcript.txt');
  const descriptions = join(directory, 'descriptions.vtt');
  const captions = join(directory, 'captions.vtt');
  await writeFile(reportFile, JSON.stringify(report, null, 2));
  await writeFile(transcript, transcriptText(report));
  await writeFile(descriptions, descriptionTrack(report));
  await writeFile(captions, captionTrack(report));
  return {
    ...output,
    files: { report: reportFile, transcript, descriptions, captions },
    report,
  };
}

export function buildReport(
  title: string,
  plan: Plan,
  levels: Levels,
  settings: Settings,
  records: SectionRecord[],
  words: Word[],
): Report {
  const ordered = [...records].sort((a, b) => a.index - b.index);
  const last = ordered[ordered.length - 1]?.continuity ?? emptyContinuity;
  const names = new Map(last.speakers.map((item) => [item.speaker, item.who]));
  const report: Report = {
    version: 2,
    title,
    kind: last.kind,
    sourceSeconds: plan.seconds,
    outputSeconds: 0,
    settings,
    loudness: { ...plan.loudness, ...levels },
    people: last.people,
    descriptions: [],
    skipped: [],
    failedSections: [],
    dialogue: [],
    warning:
      'AI descriptions can miss or misread visual details, and dialogue timing depends on speech recognition. Check anything important for yourself.',
  };
  let offset = 0;
  for (const record of ordered) {
    report.descriptions.push(
      ...record.placements.map((item) => ({
        ...item,
        at: item.at + record.start,
        pauseAt: item.pauseAt + record.start,
        outputAt: item.outputAt + offset,
      })),
    );
    report.skipped.push(...record.skipped);
    if (record.failure)
      report.failedSections.push({ start: record.start, end: record.end, reason: record.failure });
    const own = words.filter((word) => word.start >= record.start && word.start < record.end);
    for (const line of linesFrom(own, record.start))
      report.dialogue.push({
        ...line,
        start: toOutput(line.start, record.placements) + offset,
        end: toOutput(line.end, record.placements) + offset,
        who:
          line.speaker === undefined
            ? ''
            : names.get(line.speaker) || `Speaker ${line.speaker + 1}`,
      });
    offset += record.outputSeconds;
  }
  report.outputSeconds = offset;
  return report;
}
