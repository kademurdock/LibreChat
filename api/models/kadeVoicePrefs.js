const mongoose = require('mongoose');

/**
 * KadeVoicePrefs — one document per person for the Voice Changer (Oct 22 2026).
 * Route: /api/kade/voice-changer/prefs. Kept on the server so the website and
 * the iPhone app share the same favourites and recent list.
 *
 *   - favorites : up to 2,000 preset ids (built-in preset ids, or the person's own)
 *   - recent    : up to 100 preset ids, newest first
 *   - settings  : { autoPreview, previewSeconds (2-20), previewDelayMs (0-2000), keepLevel }
 *
 * Same no-TS-build pattern as kadeAsset.js.
 *
 * The collection is 'kadevoicechangerprefs', never 'kadevoiceprefs': that name is already
 * taken by KadeVoicePref (kadeVoicePref.js, the per-character voice picks, which Mongoose
 * files under its default plural), and sharing it would mix the two kinds of record and
 * break this model's unique index on user.
 */
const kadeVoicePrefsSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true },
    favorites: { type: [String], default: [] },
    recent: { type: [String], default: [] },
    settings: {
      autoPreview: { type: Boolean },
      previewSeconds: { type: Number },
      previewDelayMs: { type: Number },
      keepLevel: { type: Boolean },
    },
  },
  { timestamps: true },
);

const KadeVoicePrefs =
  mongoose.models.KadeVoicePrefs ||
  mongoose.model('KadeVoicePrefs', kadeVoicePrefsSchema, 'kadevoicechangerprefs');

module.exports = { KadeVoicePrefs };
