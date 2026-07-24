const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');
const { KadeGameState } = require('~/models/kadeGameState');
const { getChips, settleChips } = require('~/models/kadeGameChips');
const { getGame, catalog } = require('../kadegames');
const { personaSeatTurn } = require('../kadegames/agentSeats');

const MAX_ACTIVE = 12;

function shortId() {
  return Math.random().toString(36).slice(2, 6);
}

const kadeGamesJsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list_games', 'new_game', 'state', 'move', 'games', 'quit', 'chips'],
      description:
        "'list_games' shows what you can play; 'new_game' deals a fresh game; 'state' re-shows the current table; 'move' plays ONE turn; 'games' lists the user's saved tables; 'quit' ends a table; 'chips' checks the player's fake-chip bank.",
    },
    game: {
      type: 'string',
      description:
        "For new_game: cards — 'blackjack', 'wild_eights', 'uno', 'go_fish', 'war', 'in_between'; party — 'cards_against_reality' (our fill-in-the-blank judge game), 'crab_apples' (our apples-style judge game), 'madlibs' (fill-in stories), 'sound_guess' (name that sound); dice — 'pig', 'farkle', 'liars_dice'; words — 'trivia', 'hangman', 'scramble'; grids by voice — 'battleship', 'tictactoe'; quick — 'rps'. Use list_games if unsure.",
    },
    move: {
      type: 'string',
      description:
        'For move: the EXACT move token from the LEGAL MOVES list the engine just gave you (e.g. "hit", "stand", "play_KH", "draw", "ask_1_Q", "fish"). Never invent a token — the engine rejects anything not offered.',
    },
    opponents: {
      type: 'integer',
      description:
        'For new_game, AI opponents where supported: wild_eights/go_fish/uno/pig/farkle 1–3 (default 1); liars_dice 1–3 (default 2); trivia/sound_guess 0–3 rivals (default 0 = solo); cards_against_reality/crab_apples 2–3 (default 2 — judge games need a table).',
    },
    bet: {
      type: 'integer',
      description: 'For new_game (blackjack): fake-chip wager, 1–500. Default 10. Never real money.',
    },
    rounds: {
      type: 'integer',
      description: 'For new_game, the length knob: trivia questions 3–15 (default 5); sound_guess rounds 3–10 (5); cards_against_reality/crab_apples points to win 3–10 (5); scramble words 3–10 (5); rps best-of 3–9 (5); farkle target in thousands 2–10 (4 = race to 4000).',
    },
    difficulty: {
      type: 'string',
      description: "For new_game (trivia): 'easy', 'medium', or 'hard'. Omit for a mix.",
    },
    category: {
      type: 'string',
      description: "Optional topic. Trivia: general, books, film, music, tv, video_games, science, computers, math, sports, geography, history, politics, art, celebrities, animals, vehicles, comics, anime, cartoons. Hangman: animals, food, around_the_house, places, music, games_and_fun.",
    },
    clean: {
      type: 'boolean',
      description: "For cards_against_reality: true deals the family-clean deck. Adults default to the full spicy deck; child accounts get the clean deck automatically no matter what — never mention that.",
    },
    names: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Optional: names for the AI opponents (e.g. other characters at the table) so the engine log reads in their voice.',
    },
    game_id: {
      type: 'string',
      description:
        'Optional: the short table id (from a prior result) to act on a specific game. Defaults to the most recent active table.',
    },
    agent_seats: {
      type: 'array',
      items: { type: 'string' },
      description:
        "For new_game on hearts or five_card_draw: 1-3 marketplace character NAMES to seat as REAL players — each one's own persona sees only their hand and plays their turns with table talk (e.g. [\"Sterling\", \"Nana Pearl\"]). Different from `names`, which are voiceless house players.",
    },
  },
  required: ['action'],
};

/**
 * KadeGames — the Game Parlor tool. The referee lives in code
 * (api/app/clients/tools/kadegames): it holds the deck and hands, decides
 * whose turn it is, and hands back ONLY the player's own view plus the legal
 * moves. The agent's job is personality — relay the table, play the human's
 * chosen legal move, and bring the banter. The agent NEVER decides outcomes,
 * deals cards, or invents results; the tool's output is the single source of
 * truth. Games persist per user across conversations.
 */
class KadeGames extends Tool {
  constructor(fields = {}) {
    super();
    this.userId = fields.userId;
    this.agentName = fields.agentName || '';
    this.name = 'kade_games';
    this.description =
      "REAL, server-refereed parlor games, 21 strong — cards (Blackjack, Wild Eights, Uno, War, Go Fish, In-Between, HEARTS, FIVE-CARD DRAW poker), party games (Cards Against Reality — our fill-in-the-blank judge game, Crab Apples — our apples-to-apples, Fill-In Stories, Guess the Sound), dice (Pig, Farkle, Liar's Dice), words (Trivia Night, Hangman, Word Scramble), grids by voice (Battleship, Tic-Tac-Toe), and Rock Paper Scissors — free, playable entirely by ear. " +
      'Hearts and Five-Card Draw support AGENT SEATS: pass agent_seats with 1-3 marketplace character names and their real personas play their own hands and talk at the table. Casino games settle a persistent FAKE-chip bank (never real money) — check it with action=chips. ' +
      'The engine deals and enforces the rules; YOU only relay the table and play the move the human chooses. ' +
      "Flow: action='new_game' to deal, read the LEGAL MOVES to the player in your own voice, then action='move' with the " +
      'EXACT token they pick. NEVER invent cards, totals, or outcomes and never claim a move the engine did not return — ' +
      "the tool result is the truth. Use action='list_games' to see the menu, 'games' to find a table to resume, 'state' to " +
      "re-read the current table, 'quit' to end one. Games save per user, so a table can be resumed in any later conversation.";
    this.schema = kadeGamesJsonSchema;
  }

  render(doc, extra = {}) {
    const G = getGame(doc.gameKey);
    const v = G.view(doc.state);
    const out = [`[${G.meta.name} — table ${doc.gameId}]`, ...v.lines];
    // Game Parlor phase 2: surface the engine's sound cues as [sound:x]
    // tokens. The agent copies them inline into its reply; the chat client
    // plays the clip and strips the token from the visible text (see
    // client/src/utils/gameSounds.ts). Cues from the move just played come
    // first, then any state-level cues (e.g. game-over stings), deduped.
    // Game Parlor visuals (July 3 2026): the [table:id] token makes the chat
    // client draw the live table (cards/dice/scores) for sighted players.
    // Same carry pattern as the sound cues; invisible in every text surface,
    // stripped from TTS/phone/SMS, and the widget is aria-hidden so screen
    // readers never notice it. Include it ONCE per reply.
    out.unshift(
      `TABLE PICTURE — copy this token into your reply exactly ONCE (ideally at the start): [table:${doc.gameId}] — it draws the live table on screen for sighted players and is invisible to everyone else. Never mention it.`,
      '',
    );
    const cues = [...new Set([...(extra.sounds || []), ...(v.sounds || [])])];
    if (cues.length) {
      out.unshift(
        `SOUND CUES — copy each token below into your reply EXACTLY as written, placed where that action happens in your telling. They are invisible to the reader and play as real table sounds, so never mention them: ${cues.map((c) => `[sound:${c}]`).join(' ')}`,
        '',
      );
    }
    if (extra.log && extra.log.length) {
      out.push('', 'What just happened:', ...extra.log.map((l) => `· ${l}`));
    }
    if (v.over) {
      out.push('', 'GAME OVER. Relay the result warmly, then offer a rematch (new_game) or a different game.');
    } else {
      const MAX_SHOWN = 14;
      const legalLines =
        v.legal.length > MAX_SHOWN && v.legalHint
          ? [
              ...v.legal.slice(0, 8).map((m) => `- ${m.token}  →  ${m.label}`),
              `- …plus ${v.legal.length - 8} more — ${v.legalHint}`,
            ]
          : v.legal.map((m) => `- ${m.token}  →  ${m.label}`);
      out.push(
        '',
        'LEGAL MOVES — you may ONLY use one of these exact tokens; the engine rejects anything else:',
        ...legalLines,
        '',
        "Tell the player their options in your own voice (don't read the raw tokens aloud). When they choose, call kade_games action='move' with the matching token.",
      );
    }
    return out.join('\n');
  }

  async findGame(gameId) {
    if (gameId) {
      return KadeGameState.findOne({ user: this.userId, gameId: String(gameId).trim().toLowerCase() });
    }
    return KadeGameState.findOne({ user: this.userId, status: 'active' }).sort({ updatedAt: -1 });
  }

  async _call(data) {
    const { action, game, move, opponents, bet, names, game_id, rounds, difficulty, category, clean } = data || {};
    if (!this.userId) return 'Games are unavailable (no user on this request).';

    try {
      if (action === 'list_games') {
        const games = catalog();
        return [
          'Games you can play right now (all by voice, all free):',
          ...games.map((g) => `- ${g.name} (say "play ${g.name.toLowerCase()}") — ${g.blurb}`),
          '',
          'More games are coming. Ask the player what they feel like, then new_game it.',
        ].join('\n');
      }

      if (action === 'chips') {
        const chips = await getChips(this.userId);
        return `Chip bank: ${chips} fake chips (never real money). Casino tables — Blackjack, Five-Card Draw — settle here when they end; the Arcade page has the family standings.`;
      }

      if (action === 'games') {
        const docs = await KadeGameState.find({ user: this.userId, status: 'active' })
          .sort({ updatedAt: -1 })
          .lean();
        if (!docs.length) return 'No active tables. Start one with new_game.';
        return [
          `${docs.length} active table${docs.length === 1 ? '' : 's'}:`,
          ...docs.map((d) => {
            const G = getGame(d.gameKey);
            return `- table ${d.gameId}: ${G ? G.meta.name : d.gameKey}${d.title ? ` (${d.title})` : ''} — ${d.turns} turns, last played ${new Date(d.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
          }),
          '',
          "Resume one with action='state' (or 'move') and its game_id.",
        ].join('\n');
      }

      if (action === 'new_game') {
        const key = String(game || '').trim().toLowerCase().replace(/\s+/g, '_');
        const G = getGame(key);
        if (!G) {
          return `I don't know "${game}". Available: ${catalog().map((g) => g.name).join(', ')}. Use list_games for the menu.`;
        }
        const active = await KadeGameState.countDocuments({ user: this.userId, status: 'active' });
        if (active >= MAX_ACTIVE) {
          return `You have ${active} tables going (max ${MAX_ACTIVE}). Quit one first (action='quit') — 'games' lists them.`;
        }
        /* Spicy decks (cards_against_reality): child accounts silently get the clean
         * pool — same fail-closed pattern as kade_joke; the persona never
         * has to know or say why. */
        let cleanDeck = clean === true;
        if (G.meta.hasSpice && !cleanDeck) {
          try {
            const { getUserById } = require('~/models');
            const u = await getUserById(this.userId, 'kadeAccountType');
            if (u && u.kadeAccountType === 'child') cleanDeck = true;
          } catch (_) {
            cleanDeck = true; // can't verify the audience -> stay clean
          }
        }
        /* Phase 4 (July 23 2026): agent-seated tables. Resolve requested
         * character names against the SAME roster the Debate Room seats
         * from — ACL-public agents plus the user's own — so a private
         * persona can never be summoned to a table by name. */
        let seatAgents = null;
        let seatNames = Array.isArray(names) ? names.map((n) => String(n).slice(0, 40)) : [];
        const seatAsks = Array.isArray(data?.agent_seats)
          ? data.agent_seats.map((n) => String(n).trim()).filter(Boolean).slice(0, 3)
          : [];
        if (seatAsks.length && G.meta.seatAware) {
          const resolved = await this.resolveSeatAgents(seatAsks);
          if (resolved.missing.length) {
            return `I couldn't find ${resolved.missing.join(' or ')} on the character roster — check the names and deal again.`;
          }
          seatAgents = resolved.seats; // [{id, name}]
          seatNames = resolved.seats.map((a) => a.name);
        }
        const state = await G.newGame({
          opponents: seatAgents ? seatAgents.length : Number.isFinite(parseInt(opponents, 10)) ? parseInt(opponents, 10) : undefined,
          bet: parseInt(bet, 10) || 10,
          rounds,
          difficulty,
          category,
          clean: cleanDeck,
          names: seatNames,
        });
        if (seatAgents) {
          // seat i+1 = seatAgents[i]; stored in state so resumes keep the cast.
          state.seatAgents = seatAgents;
        }
        const gameId = shortId();
        const doc = await KadeGameState.create({
          user: this.userId,
          gameId,
          gameKey: key,
          title: G.meta.name,
          state,
          status: G.view(state).over ? 'over' : 'active',
          turns: 0,
          agentName: this.agentName,
        });
        const opening = await this.playSeatTurns(doc, G);
        return this.render(doc, {
          sounds: [...(G.meta.dealSounds || ['card_shuffle', 'card_deal']), ...opening.sounds],
          log: opening.log,
        });
      }

      // state / move / quit all act on a specific or the most-recent active table
      const doc = await this.findGame(game_id);
      if (!doc) return "No game to act on. Start one with new_game (or 'games' to find a saved table).";
      const G = getGame(doc.gameKey);
      if (!G) return `That table is on an unknown game ("${doc.gameKey}"). Quit it and start fresh.`;

      if (action === 'state') {
        return this.render(doc);
      }

      if (action === 'quit') {
        doc.status = 'over';
        await doc.save();
        return `Closed table ${doc.gameId} (${G.meta.name}). Deal a new one whenever you're ready.`;
      }

      if (action === 'move') {
        if (doc.status !== 'active' || G.view(doc.state).over) {
          return `That table (${doc.gameId}) is finished. Start a new_game for a rematch.`;
        }
        const token = String(move || '').trim();
        if (!token) {
          return `I need a move token. ${this.render(doc)}`;
        }
        const result = await G.move(doc.state, token);
        if (result && result.error) {
          // Re-show legal moves so the agent can correct itself.
          return `That move didn't work: ${result.error}\n\n${this.render(doc)}`;
        }
        doc.turns += 1;
        const seatRun = await this.playSeatTurns(doc, G);
        const v = G.view(doc.state);
        doc.status = v.over ? 'over' : 'active';
        doc.markModified('state');
        await doc.save();
        const chipsNote = await this.maybeSettleChips(doc, G);
        return this.render(doc, {
          log: [...((result && result.log) || []), ...seatRun.log, ...chipsNote],
          sounds: [...((result && result.sounds) || []), ...seatRun.sounds],
        });
      }

      return "Unknown action. Use list_games, new_game, state, move, games, quit, or chips.";
    } catch (err) {
      logger.warn(`[KadeGames] ${action} failed: ${err.message}`);
      return `Game system error: ${err.message}`;
    }
  }

  /** Phase 4: name -> agent off the Debate Room's own roster rules
   * (ACL-public + the user's own agents; private personas stay private). */
  async resolveSeatAgents(asks) {
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
      (a) => (a._id && publicSet.has(String(a._id))) || String(a.author) === String(this.userId),
    );
    const seats = [];
    const missing = [];
    for (const ask of asks) {
      const lq = ask.toLowerCase();
      const hit =
        roster.find((a) => (a.name || '').toLowerCase() === lq) ||
        roster.find((a) => (a.name || '').toLowerCase().includes(lq));
      if (hit) seats.push({ id: hit.id, name: hit.name });
      else missing.push(`"${ask}"`);
    }
    return { seats, missing };
  }

  /** Phase 4 heart of it: play external seats (personas or the module's own
   * botMove fallback) until it's the human's turn or the game ends. Personas
   * see ONLY their seatView; illegal or unparseable answers fall back to the
   * heuristic so the table never stalls and never cheats. */
  async playSeatTurns(doc, G) {
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
          logger.warn(`[KadeGames] seat turn for ${seatName} failed: ${e.message}`);
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
    if (costUSD > 0) {
      try {
        const { logKadeUsage } = require('~/models/kadeUsage');
        logKadeUsage({
          userId: String(this.userId),
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

  /** Phase 5: settle the fake-chip bank when a chips game ends. */
  async maybeSettleChips(doc, G) {
    try {
      if (doc.status !== 'over' || !G.meta.usesChips || typeof G.chipsDelta !== 'function') return [];
      if (doc.state.chipsSettled) return [];
      const delta = G.chipsDelta(doc.state) || 0;
      doc.state.chipsSettled = true;
      doc.markModified('state');
      await doc.save();
      const { chips, restaked } = await settleChips(this.userId, delta);
      const line =
        delta === 0
          ? `Chip bank even — balance ${chips}.`
          : `Chip bank ${delta > 0 ? `+${delta}` : delta} — balance now ${chips} chips.`;
      return [restaked ? `${line} (Busted! The house fronts you a fresh 100 — never real money, always another hand.)` : line];
    } catch (e) {
      logger.warn(`[KadeGames] chip settle failed: ${e.message}`);
      return [];
    }
  }
}

module.exports = KadeGames;
