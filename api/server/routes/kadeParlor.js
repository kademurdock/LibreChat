const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { KadeGameState } = require('~/models/kadeGameState');
const { getGame, catalog } = require('~/app/clients/tools/kadegames');
const {
  resolveSeatAgents,
  playSeatTurns,
  maybeSettleChips,
  pushHistory,
} = require('~/app/clients/tools/kadegames/tableRunner');

/**
 * THE PARLOR — menu-driven Game Room (July 23 2026 night, Kade's spec after
 * looking at RS Games: "a menu type thing... you actually chose your own
 * cards through the picker... with the option of your agents playing along
 * with you... one of my text to speech voices... be the narrator house host
 * ref voice... chat some game talk with the agent you're playing with...
 * game logues to download for memories sake or bragging writes").
 *
 * SAME tables, SAME referee as the kade_games tool — these routes and the
 * chat/phone surface are two doorways into one kadegamestates document, so
 * a table dealt here resumes on a phone call ("deal me in") and vice versa.
 * No LLM anywhere in the mechanics: the engine's legal-move tokens render
 * as real buttons. Personas only ever PLAY SEATS (tableRunner) or chat
 * table talk — never referee.
 *
 * The page itself is served at /parlor (route wired in server/index.js),
 * built on kadePages' SHARED_HEAD so it inherits the whole accessible page
 * family's styling, token helper, and safe-area handling.
 */

const router = express.Router();
const MAX_ACTIVE = 12;

function shortId() {
  return Math.random().toString(36).slice(2, 6);
}

/* Per-game menu options (mirrors the kade_games schema prose, machine-shaped).
 * [min, max, default] for numbers; arrays for enums. */
const GAME_OPTIONS = {
  blackjack: { bet: [1, 500, 10] },
  wild_eights: { opponents: [1, 3, 1] },
  uno: { opponents: [1, 3, 1] },
  go_fish: { opponents: [1, 3, 1] },
  war: {},
  in_between: {},
  pig: { opponents: [1, 3, 1] },
  farkle: { opponents: [1, 3, 1], rounds: [2, 10, 4] },
  liars_dice: { opponents: [1, 3, 2] },
  trivia: {
    opponents: [0, 3, 0],
    rounds: [3, 15, 5],
    difficulty: ['easy', 'medium', 'hard'],
    category: ['general', 'books', 'film', 'music', 'tv', 'video_games', 'science', 'computers', 'math', 'sports', 'geography', 'history', 'politics', 'art', 'celebrities', 'animals', 'vehicles', 'comics', 'anime', 'cartoons'],
  },
  hangman: { category: ['animals', 'food', 'around_the_house', 'places', 'music', 'games_and_fun'] },
  scramble: { rounds: [3, 10, 5] },
  battleship: {},
  tictactoe: {},
  rps: { rounds: [3, 9, 5] },
  madlibs: {},
  sound_guess: { opponents: [0, 3, 0], rounds: [3, 10, 5] },
  cards_against_reality: { opponents: [2, 3, 2], rounds: [3, 10, 5], clean: true },
  crab_apples: { opponents: [2, 3, 2], rounds: [3, 10, 5] },
  hearts: { seats: 3 },
  five_card_draw: { opponents: [1, 3, 2], seats: 3 },
};

function tablePayload(doc, G, extra = {}) {
  const v = G.view(doc.state);
  return {
    gameId: doc.gameId,
    gameKey: doc.gameKey,
    name: G.meta.name,
    status: doc.status,
    over: !!v.over,
    turnSeat: typeof v.turnSeat === 'number' ? v.turnSeat : 0,
    lines: v.lines || [],
    legal: v.over ? [] : v.legal || [],
    legalHint: v.legalHint || '',
    names: doc.state.names || [],
    seatAgents: Array.isArray(doc.state.seatAgents) ? doc.state.seatAgents.map((a) => a.name) : [],
    historyCount: Array.isArray(doc.state.history) ? doc.state.history.length : 0,
    log: extra.log || [],
    sounds: [...new Set([...(extra.sounds || []), ...((v.sounds || []))])],
  };
}

async function findTable(userId, gameId) {
  return KadeGameState.findOne({ user: userId, gameId: String(gameId).trim().toLowerCase() });
}

/* ── Menu ─────────────────────────────────────────────────────────────── */
router.get('/games', requireJwtAuth, async (_req, res) => {
  try {
    const games = catalog().map((g) => {
      const G = getGame(g.key);
      return {
        ...g,
        seatAware: !!(G && G.meta.seatAware),
        usesChips: !!(G && G.meta.usesChips),
        options: GAME_OPTIONS[g.key] || {},
      };
    });
    return res.json({ games });
  } catch (e) {
    logger.error('[parlor/games] error:', e);
    return res.status(500).json({ error: 'Could not load the menu.' });
  }
});

/* ── Deal ─────────────────────────────────────────────────────────────── */
router.post('/new', requireJwtAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const key = String(req.body?.game || '').trim().toLowerCase().replace(/\s+/g, '_');
    const G = getGame(key);
    if (!G) return res.status(400).json({ error: `Unknown game "${key}".` });
    const active = await KadeGameState.countDocuments({ user: userId, status: 'active' });
    if (active >= MAX_ACTIVE) {
      return res.status(400).json({ error: `You have ${active} tables going (max ${MAX_ACTIVE}) — quit one first.` });
    }

    let cleanDeck = req.body?.clean === true;
    if (G.meta.hasSpice && !cleanDeck) {
      try {
        const { getUserById } = require('~/models');
        const u = await getUserById(userId, 'kadeAccountType');
        if (u && u.kadeAccountType === 'child') cleanDeck = true;
      } catch (_) {
        cleanDeck = true;
      }
    }

    let seatAgents = null;
    let seatNames = [];
    const seatAsks = Array.isArray(req.body?.agent_seats)
      ? req.body.agent_seats.map((n) => String(n).trim()).filter(Boolean).slice(0, 3)
      : [];
    if (seatAsks.length && G.meta.seatAware) {
      const resolved = await resolveSeatAgents(userId, seatAsks);
      if (resolved.missing.length) {
        return res.status(400).json({ error: `Couldn't find ${resolved.missing.join(' or ')} on the character roster.` });
      }
      seatAgents = resolved.seats;
      seatNames = resolved.seats.map((a) => a.name);
    }

    /* PHASE 2 (July 24 2026, her word: "You can build that other second
     * phase too"): party tables. Host asks for N open seats for friends;
     * those seats deal in like everyone else but the turn loop WAITS on
     * them (tableRunner.seatKind) until a real person joins by code —
     * RS-Games style. Agents can share the same table. */
    const openSeats = Math.max(0, Math.min(3, parseInt(req.body?.party_open_seats, 10) || 0));
    const isParty = openSeats > 0 && G.meta.seatAware;
    const opponents = parseInt(req.body?.opponents, 10);
    const totalRivals = isParty
      ? (seatAgents ? seatAgents.length : 0) + openSeats
      : (seatAgents ? seatAgents.length : Number.isFinite(opponents) ? opponents : undefined);
    const openNames = isParty
      ? Array.from({ length: openSeats }, (_, i) => `Open seat ${i + 1}`)
      : [];
    const state = await G.newGame({
      opponents: totalRivals,
      bet: parseInt(req.body?.bet, 10) || 10,
      rounds: req.body?.rounds,
      difficulty: req.body?.difficulty,
      category: req.body?.category,
      clean: cleanDeck,
      names: [...seatNames, ...openNames],
    });
    if (seatAgents) state.seatAgents = seatAgents;
    if (isParty) {
      const code = Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 4).toUpperCase();
      const seatsMap = {};
      const agentCount = seatAgents ? seatAgents.length : 0;
      for (let i = 1; i < (state.names || []).length; i++) {
        // Seats past agents+openSeats are engine auto-fills (hearts always
        // deals 4) — they play as BOTS, never wait as ghosts.
        seatsMap[String(i)] =
          i <= agentCount
            ? { kind: 'agent' }
            : i <= agentCount + openSeats
              ? { kind: 'open' }
              : { kind: 'bot' };
      }
      state.party = {
        code,
        hostName: (req.user.name || 'The host').split(/\s+/)[0],
        seats: seatsMap,
        memberIds: [],
      };
    }

    const gameId = shortId();
    const doc = await KadeGameState.create({
      user: userId,
      gameId,
      gameKey: key,
      title: G.meta.name,
      state,
      status: G.view(state).over ? 'over' : 'active',
      turns: 0,
      agentName: 'The Parlor',
    });
    const who = Array.isArray(doc.state.names) && doc.state.names.length
      ? ` with ${doc.state.names.join(', ')}`
      : '';
    pushHistory(doc.state, [`Table ${gameId} — ${G.meta.name} dealt${who}.`]);
    const opening = await playSeatTurns({ userId, doc, G, collectHistory: true });
    const v = G.view(doc.state);
    doc.status = v.over ? 'over' : 'active';
    doc.markModified('state');
    await doc.save();
    const chipsNote = await maybeSettleChips(userId, doc, G);
    const dealExtra = {
      log: [...opening.log, ...chipsNote],
      sounds: [...(G.meta.dealSounds || ['card_shuffle', 'card_deal']), ...opening.sounds],
    };
    if (isParty) {
      // Party deals answer in the PARTY shape so the client immediately has
      // the join code, seat kinds, and the cue to start polling.
      return res.json({ ...partyPayload(doc, G, 0, dealExtra), historyCursor: (doc.state.history || []).length });
    }
    return res.json(tablePayload(doc, G, dealExtra));
  } catch (e) {
    logger.error('[parlor/new] error:', e);
    return res.status(500).json({ error: 'Could not deal that table.' });
  }
});

/* ── State / Move / Quit ──────────────────────────────────────────────── */
router.get('/state/:gameId', requireJwtAuth, async (req, res) => {
  try {
    const doc = await findTable(req.user.id, req.params.gameId);
    if (!doc) return res.status(404).json({ error: 'No such table.' });
    const G = getGame(doc.gameKey);
    if (!G) return res.status(410).json({ error: 'That table is on an unknown game.' });
    if (doc.state && doc.state.party) {
      // Host resuming a party table gets the party shape (seat 0) so the
      // client knows to poll and to route moves through party-move.
      return res.json({ ...partyPayload(doc, G, 0), historyCursor: (doc.state.history || []).length });
    }
    return res.json(tablePayload(doc, G));
  } catch (e) {
    logger.error('[parlor/state] error:', e);
    return res.status(500).json({ error: 'Could not read that table.' });
  }
});

router.post('/move/:gameId', requireJwtAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const doc = await findTable(userId, req.params.gameId);
    if (!doc) return res.status(404).json({ error: 'No such table.' });
    const G = getGame(doc.gameKey);
    if (!G) return res.status(410).json({ error: 'That table is on an unknown game.' });
    if (doc.status !== 'active' || G.view(doc.state).over) {
      return res.status(400).json({ error: 'That table is finished — deal a new one.' });
    }
    const token = String(req.body?.move || '').trim();
    if (!token) return res.status(400).json({ error: 'No move given.' });
    const result = await G.move(doc.state, token);
    if (result && result.error) {
      return res.status(400).json({ error: result.error, ...tablePayload(doc, G) });
    }
    if (result && result.log) pushHistory(doc.state, result.log);
    doc.turns += 1;
    const seatRun = await playSeatTurns({ userId, doc, G, collectHistory: true });
    const v = G.view(doc.state);
    doc.status = v.over ? 'over' : 'active';
    doc.markModified('state');
    await doc.save();
    const chipsNote = await maybeSettleChips(userId, doc, G);
    if (chipsNote.length) {
      pushHistory(doc.state, chipsNote);
      doc.markModified('state');
      await doc.save();
    }
    return res.json(tablePayload(doc, G, {
      log: [...((result && result.log) || []), ...seatRun.log, ...chipsNote],
      sounds: [...((result && result.sounds) || []), ...seatRun.sounds],
    }));
  } catch (e) {
    logger.error('[parlor/move] error:', e);
    return res.status(500).json({ error: 'That move did not go through.' });
  }
});

router.post('/quit/:gameId', requireJwtAuth, async (req, res) => {
  try {
    const doc = await findTable(req.user.id, req.params.gameId);
    if (!doc) return res.status(404).json({ error: 'No such table.' });
    doc.status = 'over';
    pushHistory(doc.state, ['Table closed by the player.']);
    doc.markModified('state');
    await doc.save();
    return res.json({ ok: true });
  } catch (e) {
    logger.error('[parlor/quit] error:', e);
    return res.status(500).json({ error: 'Could not close that table.' });
  }
});

/* ── PHASE 2: party tables — join by code, per-seat views, your-turn moves ── */
async function findPartyTable(userId, gameId) {
  return KadeGameState.findOne({
    gameId: String(gameId).trim().toLowerCase(),
    $or: [{ user: userId }, { 'state.party.memberIds': String(userId) }],
  });
}

function memberSeat(doc, userId) {
  if (String(doc.user) === String(userId)) return 0;
  const seats = doc.state.party?.seats || {};
  for (const [k, v] of Object.entries(seats)) {
    if (v && v.kind === 'guest' && String(v.userId) === String(userId)) return Number(k);
  }
  return -1;
}

function partyPayload(doc, G, seat, extra = {}) {
  const v = G.view(doc.state);
  const sv = seat === 0 ? null : G.seatView(doc.state, seat);
  const turnSeat = typeof v.turnSeat === 'number' ? v.turnSeat : 0;
  const seats = doc.state.party?.seats || {};
  const legal = v.over
    ? []
    : turnSeat === seat
      ? (seat === 0 ? v.legal || [] : sv?.legal || [])
      : [];
  return {
    gameId: doc.gameId,
    gameKey: doc.gameKey,
    name: G.meta.name,
    over: !!v.over,
    party: true,
    code: doc.state.party?.code,
    seat,
    turnSeat,
    turnName: (doc.state.names || [])[turnSeat] || '',
    yourTurn: !v.over && turnSeat === seat,
    lines: seat === 0 ? v.lines || [] : sv?.lines || [],
    legal,
    names: doc.state.names || [],
    seatKinds: Object.fromEntries(Object.entries(seats).map(([k, x]) => [k, x.kind])),
    historyCount: Array.isArray(doc.state.history) ? doc.state.history.length : 0,
    log: extra.log || [],
    sounds: extra.sounds || [],
  };
}

/** Join a friend's table by its 4-character code. */
router.post('/join', requireJwtAuth, async (req, res) => {
  try {
    const code = String(req.body?.code || '').trim().toUpperCase().slice(0, 8);
    if (!code) return res.status(400).json({ error: 'Need a join code.' });
    const doc = await KadeGameState.findOne({ status: 'active', 'state.party.code': code });
    if (!doc) return res.status(404).json({ error: 'No open table with that code.' });
    const G = getGame(doc.gameKey);
    if (!G) return res.status(410).json({ error: 'That table is on an unknown game.' });
    const userId = String(req.user.id);
    const already = memberSeat(doc, userId);
    if (already >= 0) {
      return res.json(partyPayload(doc, G, already, { log: ['(You were already seated.)'] }));
    }
    const seats = doc.state.party.seats || {};
    const openEntry = Object.entries(seats).find(([, v]) => v && v.kind === 'open');
    if (!openEntry) return res.status(400).json({ error: 'That table is full.' });
    const seat = Number(openEntry[0]);
    const firstName = (req.user.name || 'A friend').trim().split(/\s+/)[0] || 'A friend';
    seats[openEntry[0]] = { kind: 'guest', userId, name: firstName };
    doc.state.party.memberIds = [...(doc.state.party.memberIds || []), userId];
    if (Array.isArray(doc.state.names)) doc.state.names[seat] = firstName;
    pushHistory(doc.state, [`${firstName} sat down at seat ${seat}.`]);
    doc.markModified('state');
    await doc.save();
    return res.json(partyPayload(doc, G, seat, { log: [`You're seated at ${doc.state.party.hostName || 'the host'}'s ${G.meta.name} table.`] }));
  } catch (e) {
    logger.error('[parlor/join] error:', e);
    return res.status(500).json({ error: 'Could not join that table.' });
  }
});

/** Poll the shared table: YOUR view, whose turn, history tail. */
router.get('/party-state/:gameId', requireJwtAuth, async (req, res) => {
  try {
    const doc = await findPartyTable(String(req.user.id), req.params.gameId);
    if (!doc || !doc.state.party) return res.status(404).json({ error: 'No such party table.' });
    const G = getGame(doc.gameKey);
    if (!G) return res.status(410).json({ error: 'Unknown game.' });
    const seat = memberSeat(doc, String(req.user.id));
    if (seat < 0) return res.status(403).json({ error: 'You are not seated at this table.' });
    const since = Math.max(0, parseInt(req.query.since, 10) || 0);
    const history = (doc.state.history || []).slice(since).map((h) => h.line);
    return res.json({ ...partyPayload(doc, G, seat, { log: history }), historyCursor: (doc.state.history || []).length });
  } catch (e) {
    logger.error('[parlor/party-state] error:', e);
    return res.status(500).json({ error: 'Could not read the table.' });
  }
});

/** Play YOUR seat's move on a shared table. */
router.post('/party-move/:gameId', requireJwtAuth, async (req, res) => {
  try {
    const userId = String(req.user.id);
    const doc = await findPartyTable(userId, req.params.gameId);
    if (!doc || !doc.state.party) return res.status(404).json({ error: 'No such party table.' });
    const G = getGame(doc.gameKey);
    if (!G) return res.status(410).json({ error: 'Unknown game.' });
    if (doc.status !== 'active' || G.view(doc.state).over) {
      return res.status(400).json({ error: 'That table is finished.' });
    }
    const seat = memberSeat(doc, userId);
    if (seat < 0) return res.status(403).json({ error: 'You are not seated at this table.' });
    const v = G.view(doc.state);
    if ((typeof v.turnSeat === 'number' ? v.turnSeat : 0) !== seat) {
      return res.status(409).json({ error: `Hold on — it's ${(doc.state.names || [])[v.turnSeat] || 'someone else'}'s turn.` });
    }
    const token = String(req.body?.move || '').trim();
    if (!token) return res.status(400).json({ error: 'No move given.' });
    const result = await G.move(doc.state, token);
    if (result && result.error) return res.status(400).json({ error: result.error });
    if (result && result.log) pushHistory(doc.state, result.log);
    doc.turns += 1;
    const seatRun = await playSeatTurns({ userId: String(doc.user), doc, G, collectHistory: true });
    const after = G.view(doc.state);
    doc.status = after.over ? 'over' : 'active';
    doc.markModified('state');
    await doc.save();
    return res.json({ ...partyPayload(doc, G, seat, {
      log: [...((result && result.log) || []), ...seatRun.log],
      sounds: [...((result && result.sounds) || []), ...seatRun.sounds],
    }), historyCursor: (doc.state.history || []).length });
  } catch (e) {
    logger.error('[parlor/party-move] error:', e);
    return res.status(500).json({ error: 'That move did not go through.' });
  }
});

/* ── Table talk (July 23 spec: "chat some game talk with the agent") ──── */
router.post('/talk/:gameId', requireJwtAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const doc = await findTable(userId, req.params.gameId);
    if (!doc) return res.status(404).json({ error: 'No such table.' });
    const G = getGame(doc.gameKey);
    const text = String(req.body?.text || '').trim().slice(0, 300);
    if (!text) return res.status(400).json({ error: 'Say something first.' });
    const cast = Array.isArray(doc.state.seatAgents) ? doc.state.seatAgents : [];
    if (!cast.length) {
      return res.status(400).json({ error: 'Nobody with a personality is seated at this table.' });
    }
    const askName = String(req.body?.to || '').toLowerCase().trim();
    const pick = (askName && cast.find((c) => c.name.toLowerCase().includes(askName))) || cast[0];
    const db = require('~/models');
    const agent = await db.getAgent({ id: pick.id });
    if (!agent) return res.status(410).json({ error: `${pick.name} is not around anymore.` });

    const axios = require('axios');
    const key = process.env.OPENROUTER_KEY;
    if (!key) return res.status(503).json({ error: 'Table talk is resting right now.' });
    const history = (doc.state.history || []).slice(-10).map((h) => h.line);
    const system = [
      `You are ${pick.name}, seated at a ${G ? G.meta.name : doc.gameKey} table in the Kade-AI Game Parlor. Stay fully in character.`,
      '',
      'Your persona:',
      String(agent.instructions || '(no special persona — be yourself)').slice(0, 1400),
      '',
      'The player just said something to you at the table. Reply with ONE short spoken line — under 30 words, no stage directions, no markdown, no card claims beyond what the table log shows.',
    ].join('\n');
    const userMsg = ['Recent table log:', ...history, '', `Player says: ${text}`].join('\n');
    const r = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: agent.model || 'google/gemini-3.1-flash-lite',
        // 160 not 80: a reasoning-happy model can think through a tight cap and
        // hand back empty content (seen once on the first live table-talk try).
        max_tokens: 160,
        messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
        usage: { include: true },
      },
      {
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://kademurdock.com', 'X-Title': 'Kade-AI Game Parlor' },
        timeout: 45000,
      },
    );
    let line = String(r.data?.choices?.[0]?.message?.content || '').replace(/%%%[^%]*%%%/g, ' ').replace(/["“”*_#]/g, '').replace(/\s{2,}/g, ' ').trim().slice(0, 240);
    if (!line) return res.status(502).json({ error: `${pick.name} just smiled and said nothing.` });
    pushHistory(doc.state, [`You say: ${text}`, `${pick.name} says: ${line}`]);
    doc.markModified('state');
    await doc.save();
    try {
      const { logKadeUsage } = require('~/models/kadeUsage');
      const cost = typeof r.data?.usage?.cost === 'number' ? r.data.usage.cost : ((r.data?.usage?.total_tokens || 0) / 1e6) * 1.0;
      logKadeUsage({ userId: String(userId), service: 'game_table', quantity: 1, unit: 'turns', costUSD: cost, metadata: { gameId: doc.gameId, kind: 'table_talk' } });
    } catch (_) { /* never break the table */ }
    return res.json({ name: pick.name, line });
  } catch (e) {
    logger.error('[parlor/talk] error:', e);
    return res.status(500).json({ error: 'Table talk hiccuped — try again.' });
  }
});

/* ── The transcript ("game logues to download for memories sake") ─────── */
router.get('/log/:gameId', requireJwtAuth, async (req, res) => {
  try {
    // Party guests get the transcript too (findPartyTable covers solo hosts).
    const doc = await findPartyTable(String(req.user.id), req.params.gameId);
    if (!doc) return res.status(404).json({ error: 'No such table.' });
    const G = getGame(doc.gameKey);
    const lines = (doc.state.history || []).map((h) => {
      const when = new Date(h.t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      return `[${when}] ${h.line}`;
    });
    const text = [
      `Kade-AI Game Parlor — ${G ? G.meta.name : doc.gameKey}, table ${doc.gameId}`,
      `Players: ${(doc.state.names || []).join(', ')}`,
      `Status: ${doc.status === 'over' ? 'finished' : 'still in play'} — ${doc.turns} turns`,
      ''.padEnd(60, '='),
      ...(lines.length ? lines : ['(no plays recorded on this table yet)']),
      ''.padEnd(60, '='),
      'Kept for memories and bragging rights. — kademurdock.com/parlor',
    ].join('\n');
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="kade-parlor-${doc.gameKey}-${doc.gameId}.txt"`);
    return res.send(text);
  } catch (e) {
    logger.error('[parlor/log] error:', e);
    return res.status(500).json({ error: 'Could not build that transcript.' });
  }
});

const { parlorHtml } = require('./kadePages');
router.page = (_req, res) => res.type('html').send(parlorHtml);

module.exports = router;
