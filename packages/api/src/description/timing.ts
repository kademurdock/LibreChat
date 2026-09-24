import type { Cue, Interval, Placement, Settings } from './types';

export function mergeIntervals(intervals: Interval[], seconds: number, padding = 0): Interval[] {
  const ordered = intervals
    .filter(
      (item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start,
    )
    .map((item) => ({
      start: Math.max(0, item.start - padding),
      end: Math.min(seconds, item.end + padding),
    }))
    .filter((item) => item.end > item.start)
    .sort((a, b) => a.start - b.start);
  const result: Interval[] = [];
  for (const item of ordered) {
    const last = result[result.length - 1];
    if (last && item.start <= last.end + 0.12) last.end = Math.max(last.end, item.end);
    else result.push({ ...item });
  }
  return result;
}

export function gaps(blocked: Interval[], seconds: number): Interval[] {
  const result: Interval[] = [];
  let cursor = 0;
  for (const span of mergeIntervals(blocked, seconds)) {
    if (span.start - cursor >= 0.25) result.push({ start: cursor, end: span.start });
    cursor = span.end;
  }
  if (seconds - cursor >= 0.25) result.push({ start: cursor, end: seconds });
  return result;
}

export function fitCue(
  cue: Cue,
  rawSeconds: number,
  settings: Settings,
  blocked: Interval[],
  seconds: number,
): Placement | null {
  if (!Number.isFinite(rawSeconds) || rawSeconds <= 0) return null;
  for (const gap of gaps(blocked, seconds)) {
    const start = Math.max(gap.start, cue.at);
    const end = Math.min(gap.end, cue.until, seconds);
    const available = end - start - 0.08;
    if (available <= 0) continue;
    const rate = Math.max(settings.rate, rawSeconds / available);
    if (rate > settings.maxRate) continue;
    return {
      at: start,
      outputAt: start,
      duration: rawSeconds / rate,
      rate,
      text: cue.text,
      inserted: false,
      shortened: false,
    };
  }
  return null;
}

export function insertionPoint(at: number, blocked: Interval[], seconds: number): number {
  let point = Math.min(Math.max(0.02, at), seconds - 0.02);
  for (const span of [...blocked].sort((a, b) => a.start - b.start)) {
    if (span.start < point && point < span.end) point = span.end;
  }
  return Math.min(point, seconds - 0.02);
}

export function outputTimeline(placements: Placement[]): Placement[] {
  let shift = 0;
  return [...placements]
    .sort((a, b) => a.at - b.at || Number(b.inserted) - Number(a.inserted))
    .map((item) => {
      const placed = { ...item, outputAt: item.at + shift };
      if (item.inserted) shift += item.duration + 0.16;
      return placed;
    });
}

export function tempoFilters(rate: number): string {
  if (!Number.isFinite(rate) || rate < 1 || rate > 3) throw new Error('Invalid narration rate.');
  return rate > 2 ? `atempo=2,atempo=${(rate / 2).toFixed(6)}` : `atempo=${rate.toFixed(6)}`;
}
