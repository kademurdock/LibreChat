/**
 * Game Parlor sound cues (phase 2 of GAMES_PLAN — see KADE_PATCHES.md).
 *
 * The server-side game engine (api/app/clients/tools/kadegames) knows which
 * sound belongs to every move and lists them in its tool result as
 * "[sound:card_deal]"-style tokens; the agent copies those tokens inline into
 * its reply at the moment the action happens (same carry pattern as the %%%
 * voice performance tags, which live testing proved models reproduce
 * reliably). Everywhere a human READS the message the token must vanish
 * (stripGameSoundTags), and in the live chat the token triggers the actual
 * clip (maybePlayGameSounds).
 *
 * Design notes, hard-won elsewhere in this fork:
 * - Playback only fires while the latest message is actively streaming
 *   (caller gates on isSubmitting && isLatestMessage), so reopening an old
 *   conversation never replays a wall of card noises.
 * - A per-message registry of already-played token offsets survives remounts
 *   (module scope, LRU-capped), so React re-renders/remounts during
 *   streaming can't double-fire a cue (same class of bug as patch C5).
 * - Several cues ship alternate takes (name_2.mp3, name_3.mp3) so repeated
 *   actions don't sound identical; the variant is picked at random.
 * - Fail-soft everywhere: a missing file or an autoplay rejection must never
 *   break the chat. play() errors are swallowed.
 */

export const GAME_SOUND_RE = /\[sound:([a-z0-9_]+)\]/gi;

/** Game Parlor visual-table token (July 3 2026): [table:<gameId>] makes the
 *  chat render a live GameTable widget. Must vanish from every read surface,
 *  exactly like sound cues. */
export const GAME_TABLE_RE = /\[table:([a-z0-9]{1,12})\]/gi;

/** First table id in a piece of streamed text, or null. */
export function gameTableIdIn(text: string): string | null {
  if (!text || text.indexOf('[table:') === -1) {
    return null;
  }
  GAME_TABLE_RE.lastIndex = 0;
  const m = GAME_TABLE_RE.exec(text);
  return m ? m[1].toLowerCase() : null;
}

/** How many takes exist per cue (base file + _2/_3 alternates). */
const VARIANTS: Record<string, number> = {
  card_shuffle: 2, card_deal: 3, card_flip: 3, card_draw: 3, card_slap: 2,
  uno_sting: 2, dice_shake: 3, dice_roll: 3, dice_bad: 2,
  chip_bet: 3, chip_win: 2, chip_stack: 2, coin_flip: 2,
  your_turn: 2, correct_ding: 2, wrong_buzz: 2, timer_tick: 2, timer_up: 2,
  win_fanfare: 2, lose_trombone: 2, draw_game: 2,
  bingo_tumble: 2, bingo_pop: 2, battleship_splash: 2, battleship_boom: 2,
  page_turn: 2, drumroll_short: 2, jackpot_win: 2, coin_shower: 2,
};

export function stripGameSoundTags(text: string): string {
  if (!text || (text.indexOf('[sound:') === -1 && text.indexOf('[table:') === -1)) {
    return text;
  }
  return text
    .replace(GAME_SOUND_RE, '')
    .replace(GAME_TABLE_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^\s+/, '');
}

function srcFor(cue: string): string | null {
  const takes = VARIANTS[cue];
  if (!takes) {
    return null; // unknown cue — engine and client out of sync; stay silent
  }
  const n = 1 + Math.floor(Math.random() * takes);
  return `/assets/sounds/${cue}${n === 1 ? '' : `_${n}`}.mp3`;
}

/**
 * Ordered clip URLs for every [sound:x] token in a piece of text, with the
 * usual random variant pick. Used by Conversation Mode (phase 3) to schedule
 * cue clips in its Web Audio playback queue in sentence order.
 */
export function gameSoundSrcsIn(text: string): string[] {
  if (!text || text.indexOf('[sound:') === -1) {
    return [];
  }
  const out: string[] = [];
  GAME_SOUND_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GAME_SOUND_RE.exec(text)) !== null) {
    const src = srcFor(m[1].toLowerCase());
    if (src) {
      out.push(src);
    }
    if (out.length >= 6) {
      break; // sanity cap per chunk
    }
  }
  return out;
}

/** message id -> set of already-played token character offsets */
const played = new Map<string, Set<number>>();
const MAX_TRACKED_MESSAGES = 60;

/** Small serial queue so a burst of cues in one turn plays as a sequence,
 *  slightly overlapped, instead of a simultaneous mush. */
let queue: string[] = [];
let draining = false;

function drain() {
  if (draining) {
    return;
  }
  const next = queue.shift();
  if (!next) {
    return;
  }
  draining = true;
  try {
    const audio = new Audio(next);
    audio.volume = 0.65;
    // Let the next cue start shortly after this one begins rather than
    // waiting for the full clip — real tables overlap sounds.
    const release = () => {
      draining = false;
      drain();
    };
    audio.addEventListener('playing', () => setTimeout(release, 450), { once: true });
    audio.addEventListener('error', release, { once: true });
    audio.play().catch(release);
  } catch {
    draining = false;
  }
}

/**
 * Scan streamed assistant text for completed [sound:x] tokens and play each
 * occurrence exactly once per message. Call on every text update; gate on
 * "actively streaming" at the call site.
 */
export function maybePlayGameSounds(messageId: string, text: string): void {
  if (!messageId || !text || text.indexOf('[sound:') === -1) {
    return;
  }
  let seen = played.get(messageId);
  if (!seen) {
    if (played.size >= MAX_TRACKED_MESSAGES) {
      const oldest = played.keys().next().value;
      if (oldest !== undefined) {
        played.delete(oldest);
      }
    }
    seen = new Set<number>();
    played.set(messageId, seen);
  }
  GAME_SOUND_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GAME_SOUND_RE.exec(text)) !== null) {
    if (seen.has(m.index)) {
      continue;
    }
    seen.add(m.index);
    const src = srcFor(m[1].toLowerCase());
    if (src) {
      queue.push(src);
    }
  }
  drain();
}
