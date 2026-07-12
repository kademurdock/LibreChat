/**
 * KADE July 12 2026 — per-user, per-agent VOICE overrides ("my Kiana sounds
 * like Voice 27"). Kade's builder voices are the defaults/suggestions; every
 * user can pick their own per character and it follows them across devices,
 * in-app read-aloud, and web calls (phone pending a registry→account map).
 */
const mongoose = require('mongoose');

const kadeVoicePrefSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    agentId: { type: String, required: true },
    voice: { type: String, required: true, maxlength: 120 },
  },
  { timestamps: true },
);
kadeVoicePrefSchema.index({ userId: 1, agentId: 1 }, { unique: true });

const KadeVoicePref =
  mongoose.models.KadeVoicePref || mongoose.model('KadeVoicePref', kadeVoicePrefSchema);

async function getUserVoicePrefs(userId) {
  const rows = await KadeVoicePref.find({ userId: String(userId) }).lean();
  const map = {};
  for (const r of rows) {
    map[r.agentId] = r.voice;
  }
  return map;
}

async function getUserVoicePref(userId, agentId) {
  const row = await KadeVoicePref.findOne({ userId: String(userId), agentId: String(agentId) }).lean();
  return row ? row.voice : null;
}

async function setUserVoicePref(userId, agentId, voice) {
  if (!voice) {
    await KadeVoicePref.deleteOne({ userId: String(userId), agentId: String(agentId) });
    return null;
  }
  await KadeVoicePref.updateOne(
    { userId: String(userId), agentId: String(agentId) },
    { $set: { voice: String(voice).slice(0, 120) } },
    { upsert: true },
  );
  return voice;
}

module.exports = { KadeVoicePref, getUserVoicePrefs, getUserVoicePref, setUserVoicePref };
