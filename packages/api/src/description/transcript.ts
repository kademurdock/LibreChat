import type { Report } from './types';

/** 83.4 -> "1:23"; 3723 -> "1:02:03". */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function spokenLength(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const part = (value: number, word: string) =>
    value ? `${value} ${word}${value === 1 ? '' : 's'}` : '';
  return (
    [part(h, 'hour'), part(m, 'minute'), part(s, 'second')].filter(Boolean).join(' ') || '0 seconds'
  );
}

const stamp = (seconds: number) => {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  return `${h}:${m}:${s}.${String(ms % 1000).padStart(3, '0')}`;
};

export function webVtt(cues: { start: number; end: number; text: string }[]): string {
  return (
    'WEBVTT\n\n' +
    cues
      .filter((cue) => cue.end > cue.start && cue.text)
      .map(
        (cue, i) =>
          `${i + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text.replace(/-->/g, '->')}\n`,
      )
      .join('\n')
  );
}

export const descriptionTrack = (report: Report): string =>
  webVtt(
    report.descriptions.map((cue) => ({
      start: cue.outputAt,
      end: cue.outputAt + cue.duration,
      text: cue.text,
    })),
  );

export const captionTrack = (report: Report): string =>
  webVtt(
    report.dialogue.map((line) => ({
      start: line.start,
      end: Math.max(line.end, line.start + 0.8),
      text: line.who ? `${line.who}: ${line.text}` : line.text,
    })),
  );

/** Plain text for reading with a screen reader or braille display, in playback order. */
export function transcriptText(report: Report): string {
  const entries = [
    ...report.descriptions.map((cue) => ({
      at: cue.outputAt,
      order: 0,
      text: `Description: ${cue.text}`,
    })),
    ...report.dialogue.map((line) => ({
      at: line.start,
      order: 1,
      text: `${line.who || 'Speaker'}: ${line.text}`,
    })),
  ].sort((a, b) => a.at - b.at || a.order - b.order);
  const head = [
    `${report.title} — described transcript`,
    `Original length ${spokenLength(report.sourceSeconds)}. Described version ${spokenLength(report.outputSeconds)}. ${report.descriptions.length} descriptions.`,
    'Times are positions in the described version. Descriptions start with the word Description; speech starts with the speaker.',
    report.warning,
    '',
  ];
  const skipped = report.skipped.length
    ? [
        '',
        'Descriptions that did not fit, with their times in the original video:',
        ...report.skipped.map((item) => `${clock(item.at)} ${item.text}`),
      ]
    : [];
  const failed = report.failedSections.length
    ? [
        '',
        'Parts that could not be described:',
        ...report.failedSections.map(
          (item) => `${clock(item.start)} to ${clock(item.end)}: ${item.reason}`,
        ),
      ]
    : [];
  return (
    [
      ...head,
      ...entries.map((entry) => `${clock(entry.at)} ${entry.text}`),
      ...skipped,
      ...failed,
    ].join('\n') + '\n'
  );
}
