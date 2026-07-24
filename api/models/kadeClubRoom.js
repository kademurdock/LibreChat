const mongoose = require('mongoose');

/**
 * KadeClubRoom — THE HOTEL: private passcode rooms in Kade's Clubhouse
 * (July 24 2026, her words: "Also private rooms with pass codes so groups
 * can group up... maybe the private rooms are the hotel or something dumb."
 * For the record: not dumb — rooms-with-keys logic, "get a room" energy).
 *
 * One document per private room. The passcode is stored HASHED (sha256 of
 * key:code) — speakable codes, lowercase letters and numbers only, same
 * voice-friendly rule as everything else on the platform. lastUsedAt is
 * touched on every successful join so stale rooms can be pruned politely.
 *
 * Bespoke to Kade's instance (same plain-mongoose pattern as
 * kadeGameState.js / kadeUsage.js). Collection: kadeclubrooms.
 */
const kadeClubRoomSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true }, // livekit room name, e.g. "hotel-girls-a7k2"
    name: { type: String, required: true }, // human name, e.g. "Girls Night"
    codeHash: { type: String, required: true }, // sha256(key + ':' + code)
    createdBy: { type: String, required: true, index: true }, // user id
    createdByName: { type: String, default: '' },
    lastUsedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

const KadeClubRoom =
  mongoose.models.KadeClubRoom ||
  mongoose.model('KadeClubRoom', kadeClubRoomSchema, 'kadeclubrooms');

module.exports = { KadeClubRoom };
