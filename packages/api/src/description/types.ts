import { z } from 'zod';

export const detailLevels = ['essential', 'standard', 'rich'] as const;
export const volumeLevels = ['softer', 'balanced', 'louder'] as const;
export type Settings = {
  voice: string;
  /** Usual narration speed, 1 to 3. */
  rate: number;
  /** Fastest narration speed allowed to fit a gap. */
  maxRate: number;
  /** `extended` may pause the picture; `standard` keeps the original runtime. */
  mode: 'standard' | 'extended';
  detail: (typeof detailLevels)[number];
  volume: (typeof volumeLevels)[number];
  notes: string;
  closeLook?: boolean;
  firstLook?: boolean;
  /** Describe only this part of the source, in source seconds. Absent means the whole video. */
  range?: Interval;
};
export const settingsSchema: z.ZodType<Settings, z.ZodTypeDef, unknown> = z
  .object({
    voice: z.string().min(1).max(120),
    rate: z.number().min(1).max(3).default(1.5),
    maxRate: z.number().min(1).max(3).default(2.25),
    mode: z.enum(['standard', 'extended']).default('extended'),
    detail: z.enum(detailLevels).default('standard'),
    volume: z.enum(volumeLevels).default('balanced'),
    closeLook: z.boolean().default(false),
    firstLook: z.boolean().default(false),
    notes: z
      .string()
      .max(600)
      .default('')
      .transform((value) => value.replace(/[\r\n\t]+/g, ' ').trim()),
    range: z
      .object({ start: z.number().finite().min(0), end: z.number().finite().positive() })
      .refine(
        (value) => value.end - value.start >= 1,
        'The part to describe must be at least one second long.',
      )
      .optional(),
  })
  .refine(
    (value) => value.maxRate >= value.rate,
    'The fastest narration speed must be at least the preferred speed.',
  );
export type Interval = { start: number; end: number };
/** A named point in the source, such as a YouTube chapter. */
export type Chapter = { start: number; title: string };
export type Word = Interval & { word: string; speaker?: number };
export type Line = Interval & { text: string; speaker?: number };

export const contentKinds = [
  'film or TV',
  'animation',
  'commercial or promo',
  'logo, ident or bumper',
  'music video',
  'talk, interview or podcast',
  'news or documentary',
  'sports',
  'how-to or tutorial',
  'video game',
  'home video',
  'other',
] as const;

/**
 * Where a person's name came from: spoken, shown on screen, given in her notes, or known: a
 * well-known fictional character (cartoon, puppet, mascot, game or comic) recognized on sight.
 */
export type NameSource = 'said' | 'shown' | 'notes' | 'known' | '';
export type Person = {
  label: string;
  name: string;
  look: string;
  /** Stable id (P1, P2…) so a person keeps one entry when the model rewords the label. */
  id?: string;
  nameFrom?: NameSource;
  /** Clip-relative time the name was shown or said, when the model reports it. */
  nameAt?: number;
};
export type Cue = {
  at: number;
  until: number;
  pauseAt?: number;
  text: string;
  shortText: string;
  importance: number;
  /** Ids of the people this cue mentions. */
  who?: string[];
};
export type Analysis = {
  kind: string;
  setting: string;
  people: Person[];
  speakers: { speaker: number; who: string }[];
  cues: Cue[];
  protectedSounds: Interval[];
};

const time = z.number().finite();
const label = (max: number) =>
  z
    .string()
    .transform((value) => value.replace(/\s+/g, ' ').trim().slice(0, max))
    .catch('');
const list = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z
    .array(z.unknown())
    .catch([])
    .transform((items) =>
      items.flatMap((entry) => {
        const parsed = item.safeParse(entry);
        return parsed.success ? [parsed.data as z.output<T>] : [];
      }),
    )
    .transform((items) => items.slice(0, max));
/** Reads a model reply leniently: bad entries are dropped instead of failing the whole reply. */
export const analysisSchema: z.ZodType<Analysis, z.ZodTypeDef, unknown> = z.object({
  kind: label(60),
  setting: label(300),
  people: list(
    z.object({
      label: label(80),
      name: label(80),
      look: label(200),
      id: label(12).optional(),
      nameFrom: z
        .preprocess(
          (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
          z.enum(['said', 'shown', 'notes', 'known', '']),
        )
        .optional()
        .catch(undefined),
      nameAt: time.optional().catch(undefined),
    }),
    60,
  ),
  speakers: list(z.object({ speaker: z.number().int().min(0).max(99), who: label(80) }), 30),
  cues: list(
    z.object({
      at: time,
      until: time,
      pauseAt: time.optional().catch(undefined),
      text: label(420),
      shortText: label(200),
      importance: z.number().int().min(1).max(3).catch(2),
      who: z.array(label(12)).max(12).optional().catch(undefined),
    }),
    80,
  ),
  protectedSounds: list(z.object({ start: time, end: time }), 80),
});

/** What one section hands the next so people, places and phrasing stay consistent. */
export type Continuity = {
  kind: string;
  setting: string;
  people: Person[];
  speakers: Analysis['speakers'];
  /** The last descriptions actually spoken (the short text when that is what was voiced). */
  recent: string[];
  /** Lowercase name -> whole-video source seconds when the listener could first know it. */
  reveals?: Record<string, number>;
  /** What the listener has heard so far: visual labels, and each spoken name with its label. */
  heard?: { labels: string[]; names: Record<string, string> };
  /** Descriptions planned for the previous clip that were left out, so were never heard. */
  left?: string[];
  /** Person key -> index of the last section the person was seen in, for eviction by recency. */
  seen?: Record<string, number>;
};

export type Placement = {
  /** Section-relative source time where the narration starts. */
  at: number;
  /** Section-relative output time where the narration starts. */
  outputAt: number;
  duration: number;
  rate: number;
  text: string;
  /** Source time where the picture freezes (equal to `at` for a full pause). */
  pauseAt: number;
  /** Seconds of frozen picture added; 0 when the narration fits the soundtrack. */
  pause: number;
  inserted: boolean;
  shortened: boolean;
  importance: number;
  /** Soundtrack gain (dB, negative) under this line, when ducking is set per line. */
  dip?: number;
};
export type Skip = { at: number; text: string; reason: string };
/** Why a section could not be described: worth retrying, refused by the model, or bad input. */
export type FailureClass = 'transient' | 'refused' | 'input';
export type SectionRecord = {
  index: number;
  start: number;
  end: number;
  analysis: Analysis | null;
  failure?: string;
  failureClass?: FailureClass;
  placements: Placement[];
  skipped: Skip[];
  outputSeconds: number;
  continuity: Continuity;
};
export type Plan = {
  version: 2;
  seconds: number;
  audio: boolean;
  fps: { num: number; den: number };
  /**
   * Integrated loudness (LUFS) and sample peak (dBFS) of the original soundtrack, plus the
   * loudness of the dialogue alone and the loudness range when they were measured.
   */
  loudness: { program: number; peak: number; dialogue?: number; lra?: number };
  sections: Interval[];
  /** The part of the source this plan covers, in source seconds; absent for the whole video. */
  range?: Interval;
  /** Scene cuts and long still pictures found while planning, in working-source seconds. */
  cuts?: number[];
  stills?: Interval[];
  /** Seconds of speech per UTF-8 byte at 1x for the job's voice, measured from voiced clips. */
  secondsPerByte?: number;
  /** Dialogue language reported by speech recognition (BCP 47, such as "en" or "es"). */
  language?: string;
  /** A capture with sound on only one channel; that channel is copied to both. */
  oneSided?: 'left' | 'right';
};
/** Soundtrack gain, narration loudness (LUFS, stereo) and the gain under narration. */
export type Levels = { gain: number; narration: number; duck: number };
export type Meter = (
  kind: 'vision' | 'transcription' | 'speech',
  reserveUSD: number,
  action: () => Promise<{ costUSD: number }>,
) => Promise<void>;
export type Progress = (stage: string, progress: number) => Promise<void>;
export type Report = {
  version: 2;
  title: string;
  kind: string;
  sourceSeconds: number;
  outputSeconds: number;
  settings: Settings;
  loudness: Plan['loudness'] & Levels;
  people: Person[];
  descriptions: Placement[];
  skipped: Skip[];
  failedSections: { start: number; end: number; reason: string }[];
  /** Speech in output time, with the speaker's name or label when known. */
  dialogue: (Line & { who: string })[];
  warning: string;
  /** True when only the first part was described as a preview. */
  preview?: boolean;
  /** The part of the source that was described, in source seconds. */
  range?: Interval;
  language?: string;
};

/** Raised when a job must stop rather than skip one item, such as reaching its allowance. */
export class Halt extends Error {}
