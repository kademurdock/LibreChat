const { logger } = require('@librechat/data-schemas');
const { personaSeatTurn } = require('./agentSeats');

/**
 * Shared table mechanics (July 23 2026 night — extracted from KadeGames.js
 * the moment a second consumer appeared: the menu-driven Parlor page. Kade's
 * spec, RS-Games-style: "you actually chose your own cards through the
 * picker... with the option of your agents playing along with you").
 *
 * ONE copy of: seat-name resolution (the Debate Room's ACL roster rules),
 * the external-seat turn loop (personas with botMove fallback), and the
 * chip-bank settle — used by BOTH the kade_games tool (chat/phone surface)
 * and the /api/kade/parlor routes (menu surface). Same tables, same referee,
 * either doorway: a table dealt in chat resumes on the Parlor page and vice
 * versa, because both sides are just these functions over kadegamestates.
 *
 * `collectHistory: true` (the Parlor's setting) appends every log line to
 * state.history — the downloadable transcript. The chat surface skips it
 * (the conversation IS its log).
 */

const HISTORY_CAP = 600;

function pushHistory(state, lines) {
  if (!Array.isArray(state.history)) state.history = [];
  const ts = new Date().toISOString();
  for (const line of lines) {
    state.history.push({ t: ts, line });
  }
  if (state.history.length > HISTORY_CAP) {
    state.history.splice(0, state.history.length - HISTORY_CAP);
  }
}

/** Name -> agent, off the Debate Room's exact roster rules (ACL-public
 * agents + the user's own — a private persona can never be summoned by
 * name). Returns { seats: [{id, name}], missing: ['"ask"'] }. */
async function resolveSeatAgents(userId, asks) {
  const { ResourceType, PermissionBits } = require('librechat-data-provider');
  const { findPubliclyAccessibleResources } = require('~/server/services/PermissionService');
  const db = require('~/models');
  const publicIds = await findPubliclyAccessibleResources({
    resourceType: ResourceType.AGENT,
    requiredPermissions: PermissionBits.VIEW,
  });
  const publicSet = new Set(publicIds.map((oid) => String(oid)));
  const all = (await db.getAgents({})) || [];
  const roster = all.filter(
    (a) => (a._id && publicSet.has(String(a._id))) || String(a.author) === String(userId),
  );
  const seats = [];
  const missing = [];
  for (const ask of asks) {
    const lq = String(ask).toLowerCase().trim();
    const hit =
      roster.find((a) => (a.name || '').toLowerCase() === lq) ||
      roster.find((a) => (a.name || '').toLowerCase().includes(lq));
    if (hit) seats.push({ id: hit.id, name: hit.name });
    else missing.push(`"${ask}"`);
  }
  return { seats, missing };
}

/** Play external seats (personas or botMove) until it's the human's turn or
 * the game ends. Returns { log, sounds } — banter folded into log as
 * `<name> says: ...` lines. Never throws; never stalls; never cheats. */
async function playSeatTurns({ userId, doc, G, collectHistory = false }) {
  const log = [];
  const sounds = [];
  if (!G.meta.seatAware || typeof G.seatView !== 'function') return { log, sounds };
  const state = doc.state;
  let guard = 0;
  let costUSD = 0;
  while (guard++ < 12) {
    const v = G.view(state);
    if (v.over || v.turnSeat === 0) break;
    const seat = v.turnSeat;
    const seatName = state.names[seat];
    let token = null;
    let banter = null;
    const cast = Array.isArray(state.seatAgents) ? state.seatAgents[seat - 1] : null;
    if (cast) {
      try {
        const db = require('~/models');
        const agent = await db.getAgent({ id: cast.id });
        if (agent) {
          const turn = await personaSeatTurn({
            agent,
            seatName,
            gameName: G.meta.name,
            seatViewObj: G.seatView(state, seat),
            humanName: state.names[0] === 'You' ? '' : state.names[0],
          });
          token = turn.token;
          banter = turn.banter;
          costUSD += turn.costUSD || 0;
        }
      } catch (e) {
        logger.warn(`[tableRunner] seat turn for ${seatName} failed: ${e.message}`);
      }
    }
    if (!token && typeof G.botMove === 'function') token = G.botMove(state);
    if (!token) break;
    const r = await G.move(state, token);
    if (r && r.error) {
      // Persona picked something stale? One heuristic retry, then stop.
      const fb = typeof G.botMove === 'function' ? G.botMove(state) : null;
      const r2 = fb ? await G.move(state, fb) : null;
      if (!r2 || r2.error) break;
      if (r2.log) log.push(...r2.log);
      if (r2.sounds) sounds.push(...r2.sounds);
    } else {
      if (r && r.log) log.push(...r.log);
      if (r && r.sounds) sounds.push(...r.sounds);
    }
    if (banter) log.push(`${seatName} says: ${banter}`);
  }
  if (collectHistory && log.length) pushHistory(state, log);
  if (costUSD > 0) {
    try {
      const { logKadeUsage } = require('~/models/kadeUsage');
      logKadeUsage({
        userId: String(userId),
        service: 'game_table',
        quantity: 1,
        unit: 'turns',
        costUSD,
        metadata: { gameId: doc.gameId, gameKey: doc.gameKey },
      });
    } catch (_) {
      /* usage logging must never break a game */
    }
  }
  return { log, sounds };
}

/** Settle the fake-chip bank when a chips game ends. Returns log lines. */
async function maybeSettleChips(userId, doc, G) {
  try {
    if (doc.status !== 'over' || !G.meta.usesChips || typeof G.chipsDelta !== 'function') return [];
    if (doc.state.chipsSettled) return [];
    const delta = G.chipsDelta(doc.state) || 0;
    doc.state.chipsSettled = true;
    doc.markModified('state');
    await doc.save();
    const { settleChips } = require('~/models/kadeGameChips');
    const { chips, restaked } = await settleChips(userId, delta);
    const line =
      delta === 0
        ? `Chip bank even — balance ${chips}.`
        : `Chip bank ${delta > 0 ? `+${delta}` : delta} — balance now ${chips} chips.`;
    return [
      restaked
        ? `${line} (Busted! The house fronts you a fresh 100 — never real money, always another hand.)`
        : line,
    ];
  } catch (e) {
    logger.warn(`[tableRunner] chip settle failed: ${e.message}`);
    return [];
  }
}

module.exports = { resolveSeatAgents, playSeatTurns, maybeSettleChips, pushHistory };
