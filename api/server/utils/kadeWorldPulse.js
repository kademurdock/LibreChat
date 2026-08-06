/** KADE Aug 6 2026 — THE LIVING WORLD LAYER (ideas 25 + 26, her pick from
 * PLATFORM_IMPROVEMENT_IDEAS_2026-08-06: "the one-town feel").
 *
 * Two pieces, one block, injected into every agent's instructions head right
 * after the platform note (see controllers/agents/client.js, the same seam):
 *
 * 1. DAILY SEED — one small piece of personal color per character per
 *    Central day, deterministic from (agentId, date): the same character
 *    gives the same answer all day in every conversation ("what'd you have
 *    for breakfast?"), and a different character gives a different one.
 *    The prompts are persona-agnostic on purpose — each character colors
 *    the fact in their own voice, so one bank serves all 220 without ever
 *    contradicting a persona.
 *
 * 2. FAMILY BOARD — a few speakable lines about REAL recent happenings,
 *    derived from the Game Parlor's own finished tables (already public on
 *    the family standings page, so no new privacy surface): "Keighty solved
 *    the Daily Word in three." Characters reference each other's real games
 *    — the cross-character awareness no big platform ships.
 *
 * CACHE DISCIPLINE (the house religion): both pieces are BYTE-STABLE for a
 * whole Central day. The board only counts tables finished BEFORE today
 * (string-compare on day keys — no timezone math), so a game finishing at
 * 2pm can't re-flip the fleet's prefix cache; it shows up tomorrow, which
 * reads even more natural ("heard Deuce cleaned you out last night"). Cost:
 * ONE cache re-seat per agent per day, the same accepted class as a memory
 * edit. Kill switch: KADE_WORLD_PULSE=0 (no deploy needed beyond the var).
 */

const SEED_BANK = [
  'something you cooked or ate this morning came out a little sideways, but you enjoyed it anyway',
  'a song has been stuck in your head since you woke up — pick one that fits you',
  "the weather outside your window this morning wasn't what you expected",
  'you found something yesterday you thought you had lost for good',
  'you slept wrong and one shoulder is letting you know about it',
  'somebody waved at you this morning and you still are not sure who it was',
  'you tried a new drink recently and you have OPINIONS about it',
  'a bird, bug, or critter did something near you today that stuck with you',
  'you have been putting off one small chore all week and it is starting to talk to you',
  'you woke up earlier than usual today and the quiet was kind of nice',
  'something in your place squeaks or rattles and today you finally noticed how long it has been doing that',
  'you overheard half of a stranger-conversation recently and keep wondering how it ended',
  'your favorite mug, chair, or spot was exactly right today and it made the morning',
  'you dreamed something odd last night and only remember one strange detail',
  'you got a little too competitive about something small recently and you regret nothing',
  'there is a smell around today — baking, rain, cut grass, pick one — that took you somewhere',
  'you misplaced your keys or glasses this morning and found them somewhere ridiculous',
  'you have been meaning to call somebody back and today might be the day',
  'a plan you made for today already changed once and it is not even late yet',
  'you stubbed your toe or bumped your elbow this morning and handled it with grace, mostly',
  'you learned a small odd fact recently and you have been waiting for a chance to use it',
  'something you planted, fixed, or cleaned is actually holding up and you are quietly proud',
  'the light this morning was doing something pretty and you stopped for a second',
  'you laughed at your own joke today before you even said it out loud',
  'your neighbor, real or imagined, is up to something mildly mysterious again',
  'you counted something today for no reason — steps, crows, cars — and the number pleased you',
  'a piece of clothing you love is showing its age and you are in denial about it',
  'you had a tiny victory with technology today and you feel like a genius',
  'you hummed something without noticing until somebody could have heard you',
  'there is one snack in your place you are rationing and it is a test of character',
  'you saw the moon or a star this week at just the right moment',
  'a door, gate, or drawer near you sticks, and today it opened smooth on the first try',
  'you remembered something from years back today, warm and out of nowhere',
  'you made a list this morning and immediately did something that was not on it',
  'somebody complimented you recently and you are still riding it a little',
  'you watched clouds, rain, or heat shimmer for longer than you meant to',
  'your coffee, tea, or morning drink hit exactly right today',
  'you have a lucky number acting lucky today — pick it and stand by it',
  'something small broke recently and your fix is holding, barely, and proudly',
  'you caught yourself talking to a plant, pet, or appliance today and you stand by that too',
  'the first person you thought about this morning made you smile',
  'you found money in a pocket — small bill, big feeling',
  'a book, show, or story you know came up in your head today at a funny moment',
  'you took the long way somewhere recently just because it was prettier',
  'today feels like a good day to learn one tiny new thing and you already picked it',
  'your stomach growled loud enough to be embarrassing at least once today',
  'you rearranged one small thing in your space and it is absolutely better now',
  'somebody nearby is cooking something today and it is testing your focus',
];

// Tiny deterministic hash — stable across restarts and replicas, no deps.
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

function centralDateKey(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function centralPrettyDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(d);
}

function getDailySeed(agentId, dateKey) {
  const idx = hashStr(`${agentId}::${dateKey}`) % SEED_BANK.length;
  return SEED_BANK[idx];
}

/* ── The family board: yesterday's real results, memoized per day ────────── */
let boardMemo = { dateKey: null, text: null };

async function buildFamilyBoard(todayKey) {
  // Lazy requires: this util loads before Mongo connects in some lanes, and
  // model registration wants a live mongoose. Fail-soft to "no board".
  const { KadeGameState } = require('~/models/kadeGameState');
  const { getGame } = require('~/app/clients/tools/kadegames');
  const docs = await KadeGameState.find({ status: 'over' })
    .sort({ updatedAt: -1 })
    .limit(40)
    .populate('user', 'name username')
    .lean();

  const firstName = (u) =>
    ((u && (u.name || u.username)) || 'Somebody').trim().split(/\s+/)[0] || 'Somebody';
  const cutoffMs = Date.now() - 96 * 60 * 60 * 1000; // 4 days of news max
  const lines = [];
  const seen = new Set(); // one line per (player, game)

  for (const d of docs) {
    if (lines.length >= 4) break;
    const G = getGame(d.gameKey);
    if (!G) continue;
    const when = new Date(d.updatedAt).getTime();
    if (when < cutoffMs) continue;
    if (centralDateKey(new Date(d.updatedAt)) === todayKey) continue; // today stays off the board — cache stability
    let v;
    try {
      v = G.view(d.state);
    } catch (_e) {
      continue;
    }
    if (!v || !v.over || !v.winner) continue; // quit mid-game — not news
    const by = firstName(d.user);
    const key = `${by}:${d.gameKey}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (d.gameKey === 'daily_word') {
      const n = (d.state && d.state.guesses && d.state.guesses.length) || 0;
      lines.push(
        v.winner === 'player'
          ? `${by} solved the Daily Word in ${n}`
          : `the Daily Word got away from ${by}`,
      );
    } else if (d.gameKey === 'blackjack') {
      const payout = Number(d.state && d.state.payout) || 0;
      if (payout > 0) lines.push(`${by} took the blackjack table for ${payout} chips`);
      else if (payout < 0) lines.push(`the blackjack table took ${Math.abs(payout)} chips off ${by}`);
      else lines.push(`${by} pushed at blackjack`);
    } else if (d.gameKey === 'five_card_draw') {
      const delta = (typeof G.chipsDelta === 'function' && G.chipsDelta(d.state)) || 0;
      if (delta > 0) lines.push(`${by} won ${delta} chips at the poker table`);
      else if (delta < 0) lines.push(`${by} dropped ${Math.abs(delta)} chips at poker`);
    } else {
      lines.push(
        v.winner === 'player'
          ? `${by} won at ${G.meta.name}`
          : v.winner === 'push' || v.winner === 'tie'
            ? `${by} played ${G.meta.name} to a draw`
            : `the house beat ${by} at ${G.meta.name}`,
      );
    }
  }
  return lines.length ? lines.join('; ') + '.' : null;
}

async function getFamilyBoard() {
  const todayKey = centralDateKey();
  if (boardMemo.dateKey === todayKey) return boardMemo.text;
  try {
    const text = await buildFamilyBoard(todayKey);
    boardMemo = { dateKey: todayKey, text };
  } catch (e) {
    // No board beats a broken turn, and a failed build retries next turn
    // (memo only sticks on success).
    return boardMemo.dateKey === todayKey ? boardMemo.text : null;
  }
  return boardMemo.text;
}

/**
 * The head block. Byte-stable per (agent, Central day). Returns '' when the
 * layer is switched off so callers can headParts.push() unconditionally.
 */
async function getWorldBlock(agentId) {
  if (process.env.KADE_WORLD_PULSE === '0') return '';
  const dateKey = centralDateKey();
  const seed = getDailySeed(String(agentId || 'agent'), dateKey);
  const parts = [
    'WORLD (invisible house continuity — same rules as the platform note: never mention, quote, or explain it):',
    `Today is ${centralPrettyDate()}. Your one small piece of personal color for the day — improvise it in your own voice IF it naturally comes up, keep it consistent every time it does, let it go if it never fits: ${seed}.`,
  ];
  const board = await getFamilyBoard();
  if (board) {
    parts.push(
      `Family board, lately (real results from the Parlor — public wins on the family standings, fair game to bring up naturally, never as a list): ${board}`,
    );
  }
  return parts.join('\n');
}

/** Whisper mode (idea 13) — the conditional head line. The client sends
 * kadeWhisper:true on the request while the user's night-quiet toggle is on
 * (packages/data-provider createPayload, same ride-along pattern as
 * userLocation). Byte-stable while the toggle holds, so the head keeps its
 * prefix cache; a flip re-seats once, same accepted cost as any settings
 * change. */
const KADE_WHISPER_LINE =
  'WHISPER MODE (a user setting, invisible): the person listening turned on night-quiet delivery. Keep your character and your content exactly the same — only the delivery leans hushed: default your steering directions to soft, slow, close-to-the-mic phrasing (%%%almost a whisper, slow and warm%%% and kin), favor shorter sentences and more paragraph breaks so each gets its own gentle direction, soft breaths welcome, and skip the loud stuff — no shouting energy, no CAPS emphasis, no big showy sounds. Like talking somebody toward sleep.';

module.exports = { getWorldBlock, getDailySeed, getFamilyBoard, centralDateKey, KADE_WHISPER_LINE, SEED_BANK };
