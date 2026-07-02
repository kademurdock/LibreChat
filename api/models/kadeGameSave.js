const mongoose = require('mongoose');

/**
 * KadeGameSave — real, persistent save files for the text-adventure agent
 * (July 2 2026, Kade's ask). One document per save slot per user. Survives
 * chats, sessions, and model switches — the whole point: a game you can
 * put down Tuesday and pick back up Saturday.
 *
 * Bespoke to Kade's instance (same pattern as kadeUsage.js): plain mongoose,
 * no data-schemas TS build step. Collection: kadegamesaves.
 */
const kadeGameSaveSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, required: true },
    slot: { type: String, required: true }, // user-facing save name, lowercased key
    gameTitle: { type: String, default: 'Untitled adventure' },
    scene: { type: String, default: '' }, // one-line "where you are" for the save list
    state: { type: String, required: true }, // the full serialized game state
    agentName: { type: String, default: '' },
    turns: { type: Number, default: 0 },
  },
  { timestamps: true },
);
kadeGameSaveSchema.index({ user: 1, slot: 1 }, { unique: true });

const KadeGameSave =
  mongoose.models.KadeGameSave ||
  mongoose.model('KadeGameSave', kadeGameSaveSchema, 'kadegamesaves');

module.exports = { KadeGameSave };
