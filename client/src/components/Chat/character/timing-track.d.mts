export type TimingTrack = {
  v: 1;
  src: string;
  set: 'oxr' | 'iw11';
  dur: number;
  vis: [number, number, string][];
  w?: [number, number, string][];
  cov: [number, number][];
};
export const TRACK_VERSION: 1;
export const LEAD_MS: number;
export const MOUTH_PANEL: Readonly<
  Record<'oxr' | 'iw11', Readonly<Record<string, number | number[]>>>
>;
export function shapePanel(shape: string, set: string, strength?: number): number | null;
export function readTimingTrack(
  buffer: ArrayBuffer | Uint8Array | null | undefined,
): TimingTrack | null;
export function trackFits(track: TimingTrack | null | undefined, seconds: number): boolean;
export function trackAt(
  track: TimingTrack | null | undefined,
  ms: number,
): { shape: string | null; set: string | null; covered: boolean };
export function trackPanelAt(
  track: TimingTrack | null | undefined,
  ms: number,
  strength?: number,
): number | null;
export function wordAnchors(
  track: TimingTrack | null | undefined,
  text: string,
): { offset: number; ms: number }[];
export function trackMoments(
  track: TimingTrack | null | undefined,
): { ms: number; expression: string }[];
export function faceTimingsAllowed(): boolean;
