/**
 * Listening while a video is still being described (Nov 2026).
 *
 * Every finished section is already kept on its own (its sound as FLAC, with the film's own sound
 * and the descriptions mixed in) before the next one begins, and the job's manifest says which are
 * kept. Until the whole copy is assembled none of that can be heard. These two functions decide
 * what may be played now and whether starting now will run into the part still being made.
 * KADE_DESCRIPTION_LISTEN_AHEAD=0 turns the feature off.
 */
export const listenAheadOn = (): boolean => process.env.KADE_DESCRIPTION_LISTEN_AHEAD !== '0';

/**
 * The sections that can be played in order from the start of this run's scope: every section up to
 * the first one that is not kept yet. A later section that happens to be kept (a redo, a carried
 * copy) is never offered past a gap, so the film is never heard out of order.
 */
export function readyPrefix(
  manifest: ReadonlyArray<number | null | undefined>,
  scope: ReadonlyArray<number>,
): number[] {
  const ready: number[] = [];
  for (const index of scope) {
    const kept = manifest[index];
    if (kept === null || kept === undefined) break;
    ready.push(index);
  }
  return ready;
}

export type StartAdvice = {
  /** Film seconds ready to play now. */
  readySeconds: number;
  /** Film seconds this run will cover. */
  totalSeconds: number;
  /** Whole seconds to wait so that playing from the start never reaches the part being made;
   *  0 means start now; undefined means there is no estimate yet. */
  waitSeconds?: number;
};

/**
 * Playing from the start never catches the render when the render will be finished before the
 * listener gets to the end: remaining wall time is no more than the film's length at her speed.
 * Both lines are straight (the ready part grows steadily, she plays steadily), so if the ends are
 * in order every point between is. The wait is how long until that holds.
 */
export function startAdvice(
  readySeconds: number,
  totalSeconds: number,
  etaSeconds: number | undefined,
  speed: number = 1,
): StartAdvice {
  const ready = Math.max(0, readySeconds);
  const total = Math.max(ready, totalSeconds);
  if (ready >= total) return { readySeconds: ready, totalSeconds: total, waitSeconds: 0 };
  if (etaSeconds === undefined || !Number.isFinite(etaSeconds) || ready <= 0)
    return { readySeconds: ready, totalSeconds: total };
  const pace = Math.min(4, Math.max(0.25, Number.isFinite(speed) ? speed : 1));
  return {
    readySeconds: ready,
    totalSeconds: total,
    waitSeconds: Math.max(0, Math.ceil(etaSeconds - total / pace)),
  };
}
