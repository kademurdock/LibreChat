/**
 * KADE Nov 12 2026 (Kade's decision 24: "Same on every device"). The LISTENER's own voice settings,
 * one row per account: voice speed (pace), filler words and little sounds (fillers), and delivery
 * (Steady / Balanced / Lively) per character. Before this they lived only on each device (iPhone
 * UserDefaults, Android SharedPreferences, website localStorage).
 *
 * Every field has its own stamp (`paceAt`, `fillersAt`, `deliveryAt`), set by the server when the field
 * is written. A device remembers the last stamp it saw; a different stamp means another device changed
 * it. A field that was never written is absent (not null): `pace: null` means "the character's speed".
 *
 * Read and written by GET/PUT /api/kade/voice-prefs (services/kadeListenerPrefs.js).
 */
const mongoose = require('mongoose');

const kadeListenerPrefSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true },
    pace: { type: Number, default: undefined },
    paceAt: { type: Date, default: undefined },
    fillers: { type: Boolean, default: undefined },
    fillersAt: { type: Date, default: undefined },
    delivery: { type: Map, of: String, default: undefined },
    deliveryAt: { type: Date, default: undefined },
  },
  { timestamps: true, minimize: true },
);

const KadeListenerPref =
  mongoose.models.KadeListenerPref || mongoose.model('KadeListenerPref', kadeListenerPrefSchema);

async function getListenerPref(userId) {
  return KadeListenerPref.findOne({ userId: String(userId) }).lean();
}

/** `update` is a Mongo update document built by services/kadeListenerPrefs.buildUpdate. */
async function updateListenerPref(userId, update) {
  return KadeListenerPref.findOneAndUpdate({ userId: String(userId) }, update, {
    upsert: true,
    new: true,
    lean: true,
    setDefaultsOnInsert: false,
  });
}

module.exports = { KadeListenerPref, getListenerPref, updateListenerPref };
