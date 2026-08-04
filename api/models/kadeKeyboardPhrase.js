/**
 * KADE Aug 4 2026 — per-user KEYBOARD QUICK PHRASES (Kade: "people should be
 * able to customise their own prompt library just like their own dictionary,
 * specific to things they say all the time instead of canned crap"). One flat
 * list per user of short phrases the Kade Keys keyboard offers as one-tap
 * type-ins. The iOS app manages the list here (account-synced, survives a new
 * phone) and mirrors it into the App Group container, where the keyboard
 * extension reads it OFFLINE — a keyboard without "Allow Full Access" never
 * touches the network, so the mirror is the only bridge. Same shape/pattern
 * as kadePronunciation.js, mirrored deliberately.
 */
const mongoose = require('mongoose');

const kadeKeyboardPhraseSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    text: { type: String, required: true, maxlength: 120 },
  },
  { timestamps: true },
);
// One entry per (user, text) — re-adding the same phrase is a no-op refresh
// rather than a duplicate row.
kadeKeyboardPhraseSchema.index({ userId: 1, text: 1 }, { unique: true });

const KadeKeyboardPhrase =
  mongoose.models.KadeKeyboardPhrase ||
  mongoose.model('KadeKeyboardPhrase', kadeKeyboardPhraseSchema);

const MAX_PHRASES_PER_USER = 30;

async function getUserPhrases(userId) {
  const rows = await KadeKeyboardPhrase.find({ userId: String(userId) })
    .sort({ createdAt: 1 })
    .lean();
  return rows.map((r) => ({ id: String(r._id), text: r.text }));
}

async function addUserPhrase(userId, text) {
  const clean = String(text || '').trim().slice(0, 120);
  if (!clean) {
    throw new Error('A phrase is required.');
  }
  const count = await KadeKeyboardPhrase.countDocuments({ userId: String(userId) });
  if (count >= MAX_PHRASES_PER_USER) {
    throw new Error(`That's the limit (${MAX_PHRASES_PER_USER} phrases) — remove one first.`);
  }
  const row = await KadeKeyboardPhrase.findOneAndUpdate(
    { userId: String(userId), text: clean },
    { $set: { text: clean } },
    { new: true, upsert: true },
  ).lean();
  return { id: String(row._id), text: row.text };
}

async function deleteUserPhrase(userId, id) {
  await KadeKeyboardPhrase.deleteOne({ userId: String(userId), _id: id });
}

module.exports = { getUserPhrases, addUserPhrase, deleteUserPhrase };
