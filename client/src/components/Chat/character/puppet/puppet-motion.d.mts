export const CHANNELS: readonly string[];
export const EXPRESSIONS: Record<string, Record<string, number>>;
export function hashSeed(text: string): number;
export const TRACK_SHAPES: readonly (readonly [number, number, number])[];

export type PuppetMotionOptions = {
  seed?: number;
  energy?: 'calm' | 'steady' | 'lively' | string;
  expressiveness?: number;
  blink?: 'normal' | 'slow' | 'quick' | string;
  baseSmile?: number;
};
export type PuppetMotionInput = {
  speaking?: boolean;
  level?: number;
  listening?: boolean;
  reduceMotion?: boolean;
  look?: [number, number];
  /** Mouth panel 0..8 (timing-track.mjs) and where it came from; 'track' replaces the random pick. */
  viseme?: number;
  visemeSource?: 'track' | 'loudness' | string;
};
export type PuppetMotion = {
  setExpression(name: string, strength?: number, holdSeconds?: number): void;
  update(dt: number, input?: PuppetMotionInput): Record<string, number>;
};
export function createMotion(options?: PuppetMotionOptions): PuppetMotion;
