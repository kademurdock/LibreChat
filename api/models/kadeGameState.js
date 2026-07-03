const mongoose = require('mongoose');

/**
 * KadeGameState — live, server-refereed game tables for the Game Parlor
 * (July 3 2026, Kade's ask). One document per active game per user. The
 * engine (api/app/clients/tools/kadegames) owns the deck, the hands, whose
 * turn it is, and the legal moves; this just persists that state so a table
 * survives across conversations and phone calls ("deal me in" resumes it).
 *
 * Bespoke to Kade's instance (same plain-mongoose pattern as kadeGameSave.js /
 * kadeUsage.js, no data-schemas TS build step). Collection: kadegamestates.
 */
const kadeGameStateSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, required: true },
    gameId: { type: String, required: true }, // short public handle, e.g. "a1b2"
    gameKey: { type: String, required: true }, // 'blackjack' | 'wild_eights' | 'go_fish' | ...
    title: { type: String, default: '' },
    state: { type: mongoose.Schema.Types.Mixed, required: true }, // full engine state
    status: { type: String, default: 'active' }, // 'active' | 'over'
    turns: { type: Number, default: 0 },
    agentName: { type: String, default: '' },
  },
  { timestamps: true },
);
kadeGameStateSchema.index({ user: 1, gameId: 1 }, { unique: true });
kadeGameStateSchema.index({ user: 1, status: 1, updatedAt: -1 });

const KadeGameState =
  mongoose.models.KadeGameState ||
  mongoose.model('KadeGameState', kadeGameStateSchema, 'kadegamestates');

module.exports = { KadeGameState };
