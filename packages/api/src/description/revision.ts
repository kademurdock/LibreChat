import { z } from 'zod';
import type { Analysis, Cue, Placement, SectionRecord } from './types';
import { toOutput } from './timing';

export type Edit = { id: string; text: string; shortText: string; omit: boolean };
export type ScriptCue = Edit & {
  section: number;
  at: number;
  until: number;
  /** Position in the described copy, where the transcript and players count time. */
  outputAt: number;
  importance: number;
  /** True when this description was voiced in the copy. */
  spoken: boolean;
  /** The words actually voiced (the short version when that is what fitted). */
  spokenText: string;
  /** Why it was left out, when it was. */
  reason?: string;
};

const breaking = /[\p{Cc}\u{2028}\u{2029}]/gu;
const hidden = /[\u{202A}-\u{202E}\u{2066}-\u{2069}\u{200B}\u{FEFF}\u{00AD}]/gu;
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Text as NVDA should hear it: NFC, line breaks and control characters turned into spaces,
 * bidi controls, zero-width spaces and soft hyphens removed, spaces collapsed. Zero-width
 * joiners stay, because emoji sequences and some scripts need them.
 */
export function cleanLabel(value: string): string {
  return value
    .replace(loneSurrogate, '')
    .normalize('NFC')
    .replace(breaking, ' ')
    .replace(hidden, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cuts to at most `max` characters without splitting an emoji or other two-unit character. */
export function clip(value: string, max: number): string {
  return Array.from(value).slice(0, max).join('');
}

/** V4-SEAM: replace with ./prompt speakable (package P exports the model's own speech cleaning). */
function speakable(value: string): string {
  return value
    .replace(/[[\]{}()*_#~`|<>]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Typed text made safe to voice: no brackets the voice engine reads as tags, no line breaks. */
export function cleanSpoken(value: string): string {
  return speakable(cleanLabel(value));
}

const speech = (max: number) =>
  z
    .string()
    .max(max * 2)
    .transform(cleanSpoken)
    .pipe(
      z
        .string()
        .min(1, 'A description needs some words.')
        .max(max, `A description can be up to ${max} characters.`),
    );
export const editsSchema: z.ZodType<Edit[], z.ZodTypeDef, unknown> = z
  .array(
    z.object({
      id: z.string().regex(/^\d+:\d+$/),
      text: speech(420),
      shortText: speech(200),
      omit: z.boolean().default(false),
    }),
  )
  .max(8000)
  .superRefine((edits, ctx) => {
    if (new Set(edits.map((edit) => edit.id)).size !== edits.length)
      ctx.addIssue({ code: 'custom', message: 'A description was edited more than once.' });
  });

/** The placement that voiced a cue: same words first, else the nearest line inside its window. */
function placedFor(cue: Cue, unused: Placement[]): Placement | undefined {
  let found = unused.findIndex((item) => item.text === cue.text || item.text === cue.shortText);
  if (found < 0) {
    let best = Infinity;
    unused.forEach((item, index) => {
      const distance = Math.abs(item.at - cue.at);
      if (item.at >= cue.at - 1 && item.at <= cue.until + 1 && distance < best) {
        best = distance;
        found = index;
      }
    });
  }
  return found < 0 ? undefined : unused.splice(found, 1)[0];
}

/** Every description of a copy, in order, with where it sits in the copy and whether it was voiced. */
export function scriptCues(records: SectionRecord[]): ScriptCue[] {
  let offset = 0;
  return [...records]
    .sort((a, b) => a.index - b.index)
    .flatMap((record) => {
      const start = offset;
      offset += record.outputSeconds;
      const unused = [...record.placements];
      return (record.analysis?.cues ?? []).map((cue, index) => {
        const placed = placedFor(cue, unused);
        const left = placed
          ? undefined
          : record.skipped.find((item) => item.text === cue.text || item.text === cue.shortText);
        return {
          id: `${record.index}:${index}`,
          section: record.index,
          at: record.start + cue.at,
          until: record.start + cue.until,
          outputAt: start + (placed ? placed.outputAt : toOutput(cue.at, record.placements)),
          text: cue.text,
          shortText: cue.shortText || clip(cue.text, 200),
          importance: cue.importance,
          omit: false,
          spoken: !!placed,
          spokenText: placed?.text ?? '',
          ...(left ? { reason: left.reason } : {}),
        };
      });
    });
}

export function revise(analysis: Analysis | null, section: number, edits: Edit[]): Analysis | null {
  if (!analysis) return null;
  const indexed = new Map(edits.map((edit) => [edit.id, edit]));
  return {
    ...analysis,
    cues: analysis.cues.flatMap((cue, index) => {
      const edit = indexed.get(`${section}:${index}`);
      if (!edit) return [cue];
      if (edit.omit) return [];
      return [{ ...cue, text: edit.text, shortText: edit.shortText }];
    }),
  };
}

export const defaultLibraryPath = 'Audio/Described Movies & TV/Described by Kade-AI';
export const libraryPathSchema: z.ZodType<string, z.ZodTypeDef, unknown> = z
  .string()
  .max(400)
  .transform((value) =>
    value
      .replace(/\\/g, '/')
      .replace(/^[\s/]+|[\s/]+$/g, '')
      .split('/')
      .map(cleanLabel)
      .join('/'),
  )
  .refine(
    (value) =>
      value.length > 0 &&
      value.split('/').every((part) => part.length > 0 && !['.', '..'].includes(part)),
    'Choose a folder name without empty parts or dots.',
  );

/** Her Audio shelves mirror the Video ones: a described copy of Video/X/Y is filed under Audio/X/Y. */
export function describedShelf(source?: string): string {
  const parts = (source ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map(cleanLabel)
    .filter((part) => part && !['.', '..'].includes(part));
  if (parts.length < 2 || parts[0].toLowerCase() !== 'video') return defaultLibraryPath;
  return ['Audio', ...parts.slice(1)].join('/');
}

/** Reuses the spelling of folders that already exist, so "audio/commercials" files into "Audio/Commercials". */
export function matchFolder(path: string, folders: string[]): string {
  const known = new Map<string, string>();
  for (const folder of folders) {
    const parts = folder.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      if (!known.has(prefix.toLowerCase())) known.set(prefix.toLowerCase(), prefix);
    }
  }
  let result: string[] = [];
  for (const part of path.split('/')) {
    const candidate = [...result, part].join('/');
    const existing = known.get(candidate.toLowerCase());
    result = existing ? existing.split('/') : [...result, part];
  }
  return result.join('/');
}
