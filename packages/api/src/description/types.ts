import { z } from 'zod';

export const settingsSchema = z
  .object({
    voice: z.string().min(1).max(120),
    rate: z.number().min(1).max(3).default(1.5),
    maxRate: z.number().min(1).max(3).default(2.25),
    mode: z.enum(['standard', 'extended']).default('extended'),
  })
  .refine(
    (value) => value.maxRate >= value.rate,
    'Maximum rate must be at least the preferred rate.',
  );
export type Settings = z.infer<typeof settingsSchema>;
export type Interval = { start: number; end: number };
export type Word = Interval & { word: string };
export type Cue = {
  at: number;
  until: number;
  text: string;
  shortText: string;
  importance: number;
  pauseAt?: number;
};
export const analysisSchema = z.object({
  context: z.string().max(2400),
  cues: z
    .array(
      z.object({
        at: z.number().finite().nonnegative(),
        until: z.number().finite().positive(),
        pauseAt: z.number().finite().nonnegative().optional(),
        text: z.string().trim().min(1).max(400),
        shortText: z.string().trim().min(1).max(180),
        importance: z.number().int().min(1).max(3),
      }),
    )
    .max(24),
  protectedSounds: z
    .array(
      z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive() }),
    )
    .max(50),
});
export type Analysis = z.infer<typeof analysisSchema>;
export type Placement = {
  at: number;
  outputAt: number;
  duration: number;
  rate: number;
  text: string;
  inserted: boolean;
  shortened: boolean;
};
export type SegmentResult = {
  file: string;
  seconds: number;
  addedSeconds: number;
  placements: Placement[];
  skipped: { at: number; text: string; reason: string }[];
};
export type Meter = (
  kind: 'vision' | 'transcription' | 'speech',
  reserveUSD: number,
  action: () => Promise<{ costUSD: number }>,
) => Promise<void>;
export type Progress = (stage: string, progress: number) => Promise<void>;
export type Report = {
  version: 1;
  sourceSeconds: number;
  outputSeconds: number;
  settings: Settings;
  descriptions: Placement[];
  skipped: SegmentResult['skipped'];
  warning: string;
};
