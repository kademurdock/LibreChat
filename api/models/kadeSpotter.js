/**
 * KADE July 16 2026 — the SPOTTER: each account's ONE personal live companion
 * (Gemini Live lane). Name + voice (one of Google's 8 prebuilt Live voices) +
 * personality, designed by the user at /spotter (free text, quiz, or
 * generate-for-me). The web-voice ticket carries this to the bridge, so the
 * same Spotter answers no matter which character the call started with —
 * that's the whole realism play: the live voice change stops being a fourth
 * wall break because the Spotter IS somebody, and it's somebody YOU built.
 */
const mongoose = require('mongoose');

const kadeSpotterSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, maxlength: 40 },
    voice: { type: String, required: true, maxlength: 24 },
    persona: { type: String, default: '', maxlength: 12000 },
    // Session 21i: the private, textable LibreChat agent auto-created from this
    // Spotter so text + calls are ONE identity that shares memory. Linked here
    // once ensureSpotterAgent has created it.
    agentId: { type: String, default: null },
  },
  { timestamps: true },
);

const KadeSpotter =
  mongoose.models.KadeSpotter || mongoose.model('KadeSpotter', kadeSpotterSchema);

async function getSpotter(userId) {
  const row = await KadeSpotter.findOne({ userId: String(userId) }).lean();
  return row ? { name: row.name, voice: row.voice, persona: row.persona || '', agentId: row.agentId || null } : null;
}

async function setSpotter(userId, { name, voice, persona }) {
  await KadeSpotter.updateOne(
    { userId: String(userId) },
    { $set: { name: String(name).slice(0, 40), voice: String(voice).slice(0, 24), persona: String(persona || '').slice(0, 12000) } },
    { upsert: true },
  );
  return getSpotter(userId);
}

async function deleteSpotter(userId) {
  await KadeSpotter.deleteOne({ userId: String(userId) });
}

module.exports = { KadeSpotter, getSpotter, setSpotter, deleteSpotter };
