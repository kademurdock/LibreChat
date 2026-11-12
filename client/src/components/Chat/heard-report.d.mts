export type PlaybackLog = {
  received: number;
  clips: { seq: number; start: number; dur: number }[];
  last: { seq: number; ms: number };
};
export type HeardReport = { type: 'heard'; seq: number; ms: number };
export function createPlaybackLog(): PlaybackLog;
export function noteClipReceived(log: PlaybackLog): number;
export function noteClipScheduled(
  log: PlaybackLog,
  seq: number,
  startSec: number,
  durSec: number,
): void;
export function heardAt(log: PlaybackLog, nowSec: number): { seq: number; ms: number };
export function flushReport(log: PlaybackLog, nowSec: number): HeardReport;
export function heardClock(
  ctx: { currentTime: number; outputLatency?: number } | null | undefined,
): number;
