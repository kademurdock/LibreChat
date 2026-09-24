import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Analysis, Meter, Placement, Progress, Report, Settings, Word } from './types';
import {
  accelerate,
  decodeVoice,
  joinSegments,
  pcmSeconds,
  probe,
  renderSegment,
  segment,
} from './media';
import { fitCue, insertionPoint, mergeIntervals, outputTimeline } from './timing';
import { analyze, synthesize, transcribe } from './providers';

export type Providers = {
  transcribe: (file: string, seconds: number, signal: AbortSignal, meter: Meter) => Promise<Word[]>;
  analyze: (
    file: string,
    seconds: number,
    context: string,
    words: Word[],
    settings: Settings,
    signal: AbortSignal,
    meter: Meter,
  ) => Promise<Analysis>;
  synthesize: (
    text: string,
    voice: string,
    session: string,
    file: string,
    signal: AbortSignal,
    meter: Meter,
  ) => Promise<void>;
};
export const productionProviders: Providers = { transcribe, analyze, synthesize };

export async function describeVideo(
  source: string,
  directory: string,
  settings: Settings,
  session: string,
  signal: AbortSignal,
  meter: Meter,
  progress: Progress,
  providers: Providers = productionProviders,
): Promise<{ video: string; audio: string; reportFile: string; report: Report }> {
  const media = await probe(source, signal);
  const report: Report = {
    version: 1,
    sourceSeconds: media.seconds,
    outputSeconds: 0,
    settings,
    descriptions: [],
    skipped: [],
    warning:
      'AI descriptions can miss or misinterpret visual details. Dialogue timing also depends on speech recognition. Review the described copy before relying on it.',
  };
  const files: string[] = [];
  let context = '';
  let outputOffset = 0;
  const count = Math.ceil(media.seconds / 90);
  for (let i = 0; i < count; i++) {
    signal.throwIfAborted();
    const offset = i * 90;
    const seconds = Math.min(90, media.seconds - offset);
    const dir = join(directory, `segment-${i}`);
    await mkdir(dir, { recursive: true });
    await progress(`Preparing section ${i + 1} of ${count}`, (i / count) * 90);
    const input = await segment(source, dir, offset, seconds, media.audio, signal);
    await progress(`Finding dialogue in section ${i + 1} of ${count}`, ((i + 0.1) / count) * 90);
    const words = media.audio
      ? await providers.transcribe(input.audio, seconds, signal, meter)
      : [];
    await progress(`Watching section ${i + 1} of ${count}`, ((i + 0.2) / count) * 90);
    const analysis = await providers.analyze(
      input.video,
      seconds,
      context,
      words,
      settings,
      signal,
      meter,
    );
    context = analysis.context;
    const speech = mergeIntervals(words, seconds, 0.22);
    const blocked = mergeIntervals([...speech, ...analysis.protectedSounds], seconds, 0.1);
    const placed: { placement: Placement; pcm: Buffer }[] = [];
    for (let j = 0; j < analysis.cues.length; j++) {
      signal.throwIfAborted();
      const cue = analysis.cues[j];
      await progress(
        `Voicing description ${j + 1} of ${analysis.cues.length}, section ${i + 1} of ${count}`,
        ((i + 0.3 + (0.5 * j) / Math.max(1, analysis.cues.length)) / count) * 90,
      );
      const voiceFile = join(dir, `voice-${j}.wav`);
      await providers.synthesize(cue.text, settings.voice, session, voiceFile, signal, meter);
      let pcm = await decodeVoice(voiceFile, signal);
      let placement = fitCue(cue, pcmSeconds(pcm), settings, blocked, seconds);
      if (!placement && cue.shortText !== cue.text) {
        await providers.synthesize(
          cue.shortText,
          settings.voice,
          session,
          voiceFile,
          signal,
          meter,
        );
        pcm = await decodeVoice(voiceFile, signal);
        placement = fitCue(
          { ...cue, text: cue.shortText },
          pcmSeconds(pcm),
          settings,
          blocked,
          seconds,
        );
        if (placement) placement.shortened = true;
      }
      if (!placement && settings.mode === 'extended') {
        const at = insertionPoint(
          cue.pauseAt ?? cue.at,
          [
            ...words,
            ...analysis.protectedSounds,
            ...placed
              .filter((item) => !item.placement.inserted)
              .map((item) => ({
                start: item.placement.at,
                end: item.placement.at + item.placement.duration + 0.1,
              })),
          ],
          seconds,
        );
        placement = {
          at,
          outputAt: at,
          duration: pcmSeconds(pcm) / settings.rate,
          rate: settings.rate,
          text: cue.shortText !== cue.text ? cue.shortText : cue.text,
          inserted: true,
          shortened: cue.shortText !== cue.text,
        };
      }
      if (!placement) {
        report.skipped.push({
          at: cue.at + offset,
          text: cue.text,
          reason: 'No suitable gap at the chosen maximum narration rate.',
        });
        continue;
      }
      const accelerated = await accelerate(pcm, placement.rate, signal);
      placement.duration = pcmSeconds(accelerated);
      if (!placement.inserted && placement.at + placement.duration > Math.min(cue.until, seconds))
        throw new Error('A narration clip exceeded its time window after synthesis.');
      if (
        !placement.inserted &&
        blocked.some(
          (span) => placement!.at < span.end && placement!.at + placement!.duration > span.start,
        )
      )
        throw new Error('A narration clip exceeded its dialogue gap after synthesis.');
      if (!placement.inserted)
        blocked.push({ start: placement.at, end: placement.at + placement.duration + 0.1 });
      placed.push({ placement, pcm: accelerated });
    }
    const ordered = [...placed].sort(
      (a, b) =>
        a.placement.at - b.placement.at ||
        Number(b.placement.inserted) - Number(a.placement.inserted),
    );
    const timeline = outputTimeline(ordered.map((item) => item.placement));
    const clips = ordered.map((item) => item.pcm);
    await progress(`Mixing section ${i + 1} of ${count}`, ((i + 0.9) / count) * 90);
    const rendered = await renderSegment(
      source,
      dir,
      i,
      offset,
      seconds,
      media.audio,
      timeline,
      clips,
      signal,
    );
    files.push(rendered);
    report.descriptions.push(
      ...timeline.map((cue) => ({
        ...cue,
        at: cue.at + offset,
        outputAt: cue.outputAt + outputOffset,
      })),
    );
    outputOffset += (await probe(rendered, signal)).seconds;
  }
  await progress('Saving the described video and audio copy', 94);
  const output = await joinSegments(files, directory, signal);
  report.outputSeconds = (await probe(output.video, signal)).seconds;
  const reportFile = join(directory, 'description.json');
  await writeFile(reportFile, JSON.stringify(report, null, 2));
  return { ...output, reportFile, report };
}
