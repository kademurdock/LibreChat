export type PuppetCommand = { op: 'M' | 'L' | 'Q' | 'C' | 'Z'; v: number[] };
export type PuppetPath = PuppetCommand[];
export type PuppetDrive = [string, number][];
export type PuppetStop = { at: number; color: string; opacity?: number };
export type PuppetGradient =
  | { kind: 'linear'; start: [number, number]; end: [number, number]; stops: PuppetStop[] }
  | {
      kind: 'radial';
      center: [number, number];
      radius: number;
      focal?: [number, number];
      stops: PuppetStop[];
    };
export type PuppetGroup = {
  id: string;
  parent: string | null;
  pivot: [number, number];
  tx?: PuppetDrive;
  ty?: PuppetDrive;
  r?: PuppetDrive;
  sx?: PuppetDrive;
  sy?: PuppetDrive;
};
export type PuppetShape = {
  id: string;
  g: string;
  d: PuppetPath;
  m?: { c: string; d: PuppetPath; n?: boolean }[];
  fill?: string;
  stroke?: string;
  sw?: number;
  op?: number;
  oc?: PuppetDrive;
  clip?: string;
  hide?: [string, number][];
  cap?: 'round' | 'butt' | 'square';
};
export type PuppetScene = {
  schema: 'kade-puppet-scene/1';
  size: [number, number];
  view?: [number, number, number, number];
  backdrop?: { top: string; bottom: string } | null;
  gradients: Record<string, PuppetGradient>;
  groups: PuppetGroup[];
  shapes: PuppetShape[];
  rig?: Record<string, unknown>;
  motion?: {
    energy?: 'calm' | 'steady' | 'lively';
    expressiveness?: number;
    blink?: 'normal' | 'slow' | 'quick';
    baseSmile?: number;
  };
  description?: string;
  recipeHash?: string;
};
export type PuppetChannels = Record<string, number>;
export type PuppetMatrix = [number, number, number, number, number, number];
export type PuppetSceneCache = {
  scene: PuppetScene | null;
  ctx: CanvasRenderingContext2D | null;
  grads: Record<string, CanvasGradient>;
  paths: WeakMap<PuppetPath, Path2D>;
};

export function groupMatrices(scene: PuppetScene, ch: PuppetChannels): Record<string, PuppetMatrix>;
export function morphPath(shape: PuppetShape, ch: PuppetChannels): PuppetPath;
export function shapeOpacity(shape: PuppetShape, ch: PuppetChannels): number;
export function createSceneCache(): PuppetSceneCache;
export function drawScene(
  ctx: CanvasRenderingContext2D,
  scene: PuppetScene,
  ch?: PuppetChannels,
  box?: { x: number; y: number; w: number; h: number } | null,
  cache?: PuppetSceneCache | null,
): void;
