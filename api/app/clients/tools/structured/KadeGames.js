const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');
const { KadeGameState } = require('~/models/kadeGameState');
const { getGame, catalog } = require('../kadegames');

const MAX_ACTIVE = 12;

function shortId() {
  return Math.random().toString(36).slice(2, 6);
}

const kadeGamesJsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list_games', 'new_game', 'state', 'move', 'games', 'quit'],
      description:
        "'list_games' shows what you can play; 'new_game' deals a fresh game; 'state' re-shows the current table; 'move' plays ONE turn; 'games' lists the user's saved tables; 'quit' ends a table.",
    },
    game: {
      type: 'string',
      description:
        "For new_game: which game — 'blackjack', 'wild_eights', 'go_fish', 'uno', 'pig' (press-your-luck dice), or 'trivia' (real quiz questions). Use list_games if unsure.",
    },
    move: {
      type: 'string',
      description:
        'For move: the EXACT move token from the LEGAL MOVES list the engine just gave you (e.g. "hit", "stand", "play_KH", "draw", "ask_1_Q", "fish"). Never invent a token — the engine rejects anything not offered.',
    },
    opponents: {
      type: 'integer',
      description:
        'For new_game (wild_eights / go_fish / uno / pig / trivia): how many AI opponents at the table. Cards/dice: 1–3 (default 1). Trivia: 0–3 rivals (default 0 = solo quiz).',
    },
    bet: {
      type: 'integer',
      description: 'For new_game (blackjack): fake-chip wager, 1–500. Default 10. Never real money.',
    },
    rounds: {
      type: 'integer',
      description: 'For new_game (trivia): how many questions, 3–15. Default 5.',
    },
    difficulty: {
      type: 'string',
      description: "For new_game (trivia): 'easy', 'medium', or 'hard'. Omit for a mix.",
    },
    category: {
      type: 'string',
      description: "For new_game (trivia): optional topic — general, books, film, music, tv, video_games, science, computers, math, sports, geography, history, politics, art, celebrities, animals, vehicles, comics, anime, cartoons.",
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
      'REAL, server-refereed parlor games (Blackjack, Wild Eights, Go Fish, Pig dice, Trivia Night, Uno) — free, no cost, playable entirely by voice. ' +
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
      out.push(
        '',
        'LEGAL MOVES — you may ONLY use one of these exact tokens; the engine rejects anything else:',
        ...v.legal.map((m) => `- ${m.token}  →  ${m.label}`),
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
    const { action, game, move, opponents, bet, names, game_id, rounds, difficulty, category } = data || {};
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
        const state = await G.newGame({
          opponents: Number.isFinite(parseInt(opponents, 10)) ? parseInt(opponents, 10) : undefined,
          bet: parseInt(bet, 10) || 10,
          rounds,
          difficulty,
          category,
          names: Array.isArray(names) ? names.map((n) => String(n).slice(0, 40)) : [],
        });
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
        return this.render(doc, { sounds: G.meta.dealSounds || ['card_shuffle', 'card_deal'] });
      }

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
          return `I need a move token.\n\n${this.render(doc)}`;
        }
        const result = G.move(doc.state, token);
        if (result && result.error) {
          return `That move didn't work: ${result.error}\n\n${this.render(doc)}`;
        }
        const v = G.view(doc.state);
        doc.turns += 1;
        doc.status = v.over ? 'over' : 'active';
        doc.markModified('state');
        await doc.save();
        return this.render(doc, { log: (result && result.log) || [], sounds: (result && result.sounds) || [] });
      }

      return "Unknown action. Use list_games, new_game, state, move, games, or quit.";
    } catch (err) {
      logger.warn(`[KadeGames] ${action} failed: ${err.message}`);
      return `Game system error: ${err.message}`;
    }
  }
}

module.exports = KadeGames;
