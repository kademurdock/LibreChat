/**
 * KADE July 20 2026 — per-user PRONUNCIATION DICTIONARY (Kade: "I know my
 * name Kade is pronounced Katie. What if everyone had a dictionary they can
 * put their own names in?"). One flat list per user of {term, pronunciation}
 * pairs — `term` is the normal spelling (what STT should recognize, what
 * stays in the written record), `pronunciation` is how it should SOUND when
 * spoken back (what TTS/read-aloud/live-call speech should say instead).
 * Two totally separate consumers read this same list:
 *   - STT (Deepgram keyterms, both the phone/web call path and the
 *     Transcribe feature): only the `term` half matters — biases
 *     recognition toward the correct SPELLING.
 *   - TTS (voice-message read-aloud, phone/Spotter call speech): only the
 *     `pronunciation` half matters — a plain text substitution applied
 *     right before synthesis, since none of Kade-AI's TTS paths (OpenAI,
 *     ElevenLabs' non-dictionary mode, Azure, Inworld, Gemini Live) take a
 *     phoneme hint from arbitrary caller text -- respelling what actually
 *     gets sent to be spoken is the one trick that works on all of them.
 * Same shape/pattern as kadeVoicePref.js, mirrored deliberately.
 */
const mongoose = require('mongoose');

const kadePronunciationSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    term: { type: String, required: true, maxlength: 80 },
    pronunciation: { type: String, required: true, maxlength: 80 },
  },
  { timestamps: true },
);
// One entry per (user, term) -- re-adding the same term overwrites its
// pronunciation rather than duplicating a row.
kadePronunciationSchema.index({ userId: 1, term: 1 }, { unique: true });

const KadePronunciation =
  mongoose.models.KadePronunciation ||
  mongoose.model('KadePronunciation', kadePronunciationSchema);

async function getUserDictionary(userId) {
  const rows = await KadePronunciation.find({ userId: String(userId) }).sort({ term: 1 }).lean();
  return rows.map((r) => ({ id: String(r._id), term: r.term, pronunciation: r.pronunciation }));
}

async function setUserDictionaryEntry(userId, term, pronunciation) {
  const cleanTerm = String(term || '').trim().slice(0, 80);
  if (!cleanTerm) {
    throw new Error('A name/word is required.');
  }
  const cleanPron = String(pronunciation || '').trim().slice(0, 80);
  if (!cleanPron) {
    throw new Error('A pronunciation is required.');
  }
  await KadePronunciation.updateOne(
    { userId: String(userId), term: cleanTerm },
    { $set: { pronunciation: cleanPron } },
    { upsert: true },
  );
  return { term: cleanTerm, pronunciation: cleanPron };
}

async function deleteUserDictionaryEntry(userId, id) {
  await KadePronunciation.deleteOne({ userId: String(userId), _id: id });
}

/**
 * Word-boundary-safe, case-insensitive substitution of each `term` with its
 * `pronunciation` -- the shared "make this text speakable" pass every TTS
 * call site runs right before synthesis. Never touches stored/displayed
 * text, only the ephemeral copy handed to a speech engine. Safe no-op on
 * empty input/dictionary. Kept dependency-free (plain RegExp) so the
 * identical logic can be copied as-is into kade-ai-bridge, which has no
 * shared package with this repo.
 */
function applyPronunciationRespellings(text, dictionary) {
  if (!text || !dictionary || !dictionary.length) {
    return text;
  }
  let out = text;
  for (const entry of dictionary) {
    const term = entry && entry.term;
    const pron = entry && entry.pronunciation;
    if (!term || !pron) {
      continue;
    }
    const escaped = String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let re;
    try {
      re = new RegExp(`\\b${escaped}\\b`, 'gi');
    } catch {
      continue;
    }
    out = out.replace(re, pron);
  }
  return out;
}

module.exports = {
  KadePronunciation,
  getUserDictionary,
  setUserDictionaryEntry,
  deleteUserDictionaryEntry,
  applyPronunciationRespellings,
};
