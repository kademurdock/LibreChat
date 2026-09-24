import { z } from 'zod';
import type { Analysis, SectionRecord } from './types';
import { toOutput } from './timing';

export type Edit = { id: string; text: string; shortText: string; omit: boolean };
export type ScriptCue = Edit & { at: number; until: number; outputAt: number; importance: number };
const speech = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) =>
      [...value].every(
        (letter) => letter.charCodeAt(0) >= 32 || ['\n', '\r', '\t'].includes(letter),
      ),
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

export function scriptCues(records: SectionRecord[]): ScriptCue[] {
  let offset = 0;
  return records.flatMap((record) => {
    const start = offset;
    offset += record.outputSeconds;
    return (record.analysis?.cues ?? []).map((cue, index) => ({
      id: `${record.index}:${index}`,
      at: record.start + cue.at,
      until: record.start + cue.until,
      outputAt: start + toOutput(cue.at, record.placements),
      text: cue.text,
      shortText: cue.shortText || cue.text.slice(0, 200),
      importance: cue.importance,
      omit: false,
    }));
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
export const libraryPathSchema: z.ZodType<string> = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .transform((value) => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
  .refine(
    (value) =>
      value.length > 0 &&
      value.split('/').every((part) => part.trim().length > 0 && !['.', '..'].includes(part)) &&
      [...value].every((letter) => letter.charCodeAt(0) >= 32),
    'Choose a folder name without empty parts, dots or control characters.',
  );
