import type {
  Continuity,
  Interval,
  Levels,
  Line,
  Person,
  Placement,
  Plan,
  Report,
  SectionRecord,
  Settings,
  Word,
} from './types';
import {
  capitalize,
  looksLikeLabel,
  nameKey,
  readsName,
  resolvePerson,
  revealsFor,
  speakerAt,
} from './ledger';
import { toOutput } from './timing';

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

export const isEnglish = (code: string): boolean => /^en(?:$|[-_])/i.test(code.trim());

/** "es" -> "Spanish"; an unknown code is returned as it is. */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

const stamp = (seconds: number) => {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  return `${h}:${m}:${s}.${String(ms % 1000).padStart(3, '0')}`;
};

/** Cue text for WebVTT: & < > escaped, no blank line that would end the cue early. */
function vttText(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((line) => line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
    .join('\n');
}

/** A WebVTT file; a line break inside a cue's text is kept as a second caption line. */
export function webVtt(cues: { start: number; end: number; text: string }[]): string {
  return (
    'WEBVTT\n\n' +
    cues
      .map((cue) => ({ ...cue, text: vttText(cue.text) }))
      .filter((cue) => cue.end > cue.start && cue.text)
      .map((cue, i) => `${i + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}\n`)
      .join('\n')
  );
}

export const descriptionTrack = (report: Report): string =>
  webVtt(
    report.descriptions.map((cue) => ({
      start: cue.outputAt,
      end: cue.outputAt + cue.duration,
      text: cue.text.replace(/\s+/g, ' '),
    })),
  );

/** One voice under one name: "Frank (the flying squirrel)" and a later "Frank" are the same. */
const identity = (line: { who: string; speaker?: number }) =>
  `${line.speaker ?? ''}|${line.who.replace(/ \([^)]*\)$/, '').toLowerCase()}`;

/** Breaks a caption into at most two lines near the middle when it is longer than 42 characters. */
function wrap(text: string): string {
  if (text.length <= 42) return text;
  const middle = text.length / 2;
  let best = -1;
  for (let i = text.indexOf(' '); i >= 0; i = text.indexOf(' ', i + 1))
    if (best < 0 || Math.abs(i - middle) < Math.abs(best - middle)) best = i;
  return best < 0 ? text : `${text.slice(0, best)}\n${text.slice(best + 1)}`;
}

/**
 * Captions: at most two short lines each, on screen for 1 to 7 seconds but never into the next
 * caption, with the speaker named only when the speaker changes.
 */
export const captionTrack = (report: Report): string => {
  const lines = report.dialogue.filter((line) => line.text.trim());
  let previous: string | undefined;
  return webVtt(
    lines.map((line, i) => {
      const next = lines[i + 1];
      let end = Math.min(Math.max(line.end, line.start + 1), line.start + 7);
      if (next) end = Math.max(Math.min(end, next.start - 0.05), line.start + 0.1);
      const voice = identity(line);
      const label = line.who && voice !== previous ? `${capitalize(line.who)}: ` : '';
      previous = voice;
      return { start: line.start, end, text: wrap(label + line.text) };
    }),
  );
};

type Group = { heading: string; items: string[] };

function reasonHeading(reason: string): string {
  if (/voice/i.test(reason)) return 'Voice failed, try Make a new version';
  if (/minor detail/i.test(reason)) return 'Left out on purpose, minor detail';
  if (/gap|room|fit|long enough/i.test(reason)) return 'Left out, no room';
  return reason.replace(/[.\s]+$/, '');
}

/** Plain text for reading with a screen reader or braille display, in playback order. */
export function transcriptText(report: Report): string {
  const entries = [
    ...report.descriptions.map((cue) => ({
      at: cue.outputAt,
      order: 0,
      who: '',
      voice: '',
      text: cue.text,
    })),
    ...report.dialogue.map((line) => ({
      at: line.start,
      order: 1,
      who: capitalize(line.who) || 'Speaker',
      voice: identity(line),
      text: line.text,
    })),
  ].sort((a, b) => a.at - b.at || a.order - b.order);
  const merged: typeof entries = [];
  for (const entry of entries) {
    const last = merged[merged.length - 1];
    if (
      last &&
      entry.order === 1 &&
      last.order === 1 &&
      last.voice === entry.voice &&
      entry.at - last.at <= 20 &&
      last.text.length + entry.text.length < 300
    )
      last.text += ' ' + entry.text;
    else merged.push({ ...entry });
  }
  const shift = report.range?.start ?? 0;
  const length = report.range
    ? `Described part ${clock(report.range.start)} to ${clock(report.range.end)} of the original, ${spokenLength(report.sourceSeconds)}.`
    : `Original length ${spokenLength(report.sourceSeconds)}.`;
  const head = [
    `${report.title} — described transcript`,
    `${length} Described version ${spokenLength(report.outputSeconds)}. ${plural(report.descriptions.length, 'description')}.`,
    report.preview
      ? 'This is a preview of the beginning; the rest has not been described yet.'
      : '',
    report.language && !isEnglish(report.language)
      ? `Dialogue language: ${languageName(report.language)} (detected).`
      : '',
    'Times are positions in the described version. Descriptions start with the word Description; speech starts with the speaker.',
    report.warning,
    '',
  ].filter((line, i, all) => line || i === all.length - 1);
  const groups: Group[] = [];
  for (const item of report.skipped) {
    const heading = reasonHeading(item.reason);
    let group = groups.find((entry) => entry.heading === heading);
    if (!group) groups.push((group = { heading, items: [] }));
    group.items.push(`${clock(item.at + shift)} ${item.text}`);
  }
  const skipped = groups.length
    ? [
        '',
        'Descriptions left out, with their times in the original video:',
        ...groups.flatMap((group) => [`${group.heading}:`, ...group.items]),
      ]
    : [];
  const failed = report.failedSections.length
    ? [
        '',
        'Parts that could not be described:',
        ...report.failedSections.map(
          (item) => `${clock(item.start + shift)} to ${clock(item.end + shift)}: ${item.reason}`,
        ),
      ]
    : [];
  return (
    [
      ...head,
      ...merged.map((entry) =>
        entry.order === 0
          ? `${clock(entry.at)} Description: ${entry.text}`
          : `${clock(entry.at)} ${entry.who}: ${entry.text}`,
      ),
      ...skipped,
      ...failed,
    ].join('\n') + '\n'
  );
}

/** "uh" and "um": kept in the words for timing, left out of caption and transcript text. */
const filler = /^(?:u+h+|u+m+|u+h+m+|e+r+m+)[,.!?…]*$/i;
const sentenceEnd = /[.!?…]["'”’)\]]?$/;

/**
 * Caption lines from one section's words (whole-video seconds): a new line at a new voice, a
 * sentence end, a gap of 0.7 s, a frozen pause, or 84 characters.
 */
export function captionLines(words: Word[], placements: Placement[], sectionStart: number): Line[] {
  const pauses = placements
    .filter((item) => item.pause > 0)
    .map((item) => item.pauseAt + sectionStart)
    .sort((a, b) => a - b);
  let pause = 0;
  const lines: Line[] = [];
  for (const word of [...words].sort((a, b) => a.start - b.start)) {
    if (filler.test(word.word)) continue;
    const last = lines[lines.length - 1];
    let paused = false;
    while (pause < pauses.length && pauses[pause] <= word.start + 0.03) {
      paused ||= !!last && pauses[pause] > last.start;
      pause++;
    }
    if (
      !last ||
      paused ||
      last.speaker !== word.speaker ||
      sentenceEnd.test(last.text) ||
      word.start - last.end >= 0.7 ||
      last.text.length + 1 + word.word.length > 84
    ) {
      lines.push({ start: word.start, end: word.end, text: word.word, speaker: word.speaker });
      continue;
    }
    last.text += ' ' + word.word;
    last.end = Math.max(last.end, word.end);
  }
  return lines;
}

const emptyContinuity: Continuity = { kind: '', setting: '', people: [], speakers: [], recent: [] };
const personKey = (person: Person) => person.id ?? person.label.toLowerCase();

/** Everyone met in the video, in the latest form each section left them. */
function everyone(records: SectionRecord[]): Person[] {
  const people = new Map<string, Person>();
  for (const record of records)
    for (const person of record.continuity.people) {
      if (!person.label) continue;
      const key = personKey(person);
      const known = people.get(key);
      people.set(key, { ...person, name: person.name || known?.name || '' });
    }
  return [...people.values()];
}

/**
 * Speaker matches worth printing: the same voice matched to the same person in at least two
 * sections, and more often than to anyone else. One guess is not enough; runs used to disagree.
 */
function agreedSpeakers(records: SectionRecord[]): Continuity['speakers'] {
  const tally = new Map<number, Map<string, number>>();
  for (const record of records) {
    const own = new Map<number, string>();
    for (const item of record.analysis?.speakers ?? []) {
      const person = resolvePerson(item.who, record.continuity.people);
      if (person) own.set(item.speaker, personKey(person));
      else if (looksLikeLabel(item.who)) own.set(item.speaker, item.who.trim().toLowerCase());
    }
    for (const [speaker, key] of own) {
      const counts = tally.get(speaker) ?? new Map<string, number>();
      counts.set(key, (counts.get(key) ?? 0) + 1);
      tally.set(speaker, counts);
    }
  }
  const agreed: Continuity['speakers'] = [];
  for (const [speaker, counts] of tally) {
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked[0][1] >= 2 && (ranked[1]?.[1] ?? 0) < ranked[0][1])
      agreed.push({ speaker, who: ranked[0][0] });
  }
  return agreed;
}

function mostCommonKind(records: SectionRecord[], fallback: string): string {
  const counts = new Map<string, number>();
  for (const record of records) {
    const kind = record.analysis?.kind;
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback;
}

export function buildReport(
  title: string,
  plan: Plan,
  levels: Levels,
  settings: Settings,
  records: SectionRecord[],
  words: Word[],
  extra?: { preview?: boolean; range?: Interval },
): Report {
  const ordered = [...records].sort((a, b) => a.index - b.index);
  const last = ordered[ordered.length - 1]?.continuity ?? emptyContinuity;
  const people = everyone(ordered);
  const names = [...new Set(people.map((person) => person.name).filter(Boolean))];
  const reveals = revealsFor(names, words, settings.notes, last.reveals);
  for (const record of ordered)
    for (const placement of record.placements)
      for (const name of names) {
        const key = nameKey(name);
        const at = record.start + placement.at;
        if (readsName(placement.text, name) && (reveals[key] === undefined || at < reveals[key]))
          reveals[key] = at;
      }
  const ledger: Continuity = { ...last, people, speakers: agreedSpeakers(ordered), reveals };
  const report: Report = {
    version: 2,
    title,
    kind: mostCommonKind(ordered, last.kind),
    sourceSeconds: plan.seconds,
    outputSeconds: 0,
    settings,
    loudness: { ...plan.loudness, ...levels },
    people: people.map((person) =>
      person.name && reveals[nameKey(person.name)] === undefined ? { ...person, name: '' } : person,
    ),
    descriptions: [],
    skipped: [],
    failedSections: [],
    dialogue: [],
    warning:
      'AI descriptions can miss or misread visual details, and dialogue timing depends on speech recognition. Check anything important for yourself.',
    ...(extra?.preview ? { preview: true } : {}),
    ...(extra?.range ? { range: extra.range } : {}),
    ...(plan.language ? { language: plan.language } : {}),
  };
  const introduced = new Set<number>();
  const who = (speaker: number | undefined, at: number) => {
    if (speaker === undefined) return '';
    const printed = speakerAt(ledger, speaker, at);
    const entry = ledger.speakers.find((item) => item.speaker === speaker);
    const person = entry ? resolvePerson(entry.who, people) : undefined;
    if (!person?.name || printed !== person.name || introduced.has(speaker)) return printed;
    introduced.add(speaker);
    return person.label ? `${person.name} (${person.label})` : printed;
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
    for (const line of captionLines(own, record.placements, record.start)) {
      const start = toOutput(line.start - record.start, record.placements) + offset;
      report.dialogue.push({
        ...line,
        start,
        end: start + (line.end - line.start),
        who: who(line.speaker, line.start),
      });
    }
    offset += record.outputSeconds;
  }
  report.outputSeconds = offset;
  return report;
}
