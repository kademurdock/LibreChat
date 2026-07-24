const mongoose = require('mongoose');

/**
 * KadeGameChips — the Game Parlor's persistent FAKE-chip bank (July 23 2026,
 * GAMES_PLAN phase 5, "meta" item 41). One row per user, never real money,
 * pure bragging rights: casino-style games settle their net here so a hot
 * blackjack night and a cold poker night live on the same tab. Everyone
 * starts with 500; going broke just means the house fronts a fresh 100 —
 * nobody is ever locked out of a game (Kade's platform, Kade's kindness).
 *
 * Same plain-mongoose pattern as kadeGameState.js. Collection: kadegamechips.
 */
const kadeGameChipsSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, unique: true, required: true },
    chips: { type: Number, default: 500 },
    lifetimeWon: { type: Number, default: 0 },
    lifetimeLost: { type: Number, default: 0 },
  },
  { timestamps: true },
);

const KadeGameChips =
  mongoose.models.KadeGameChips ||
  mongoose.model('KadeGameChips', kadeGameChipsSchema, 'kadegamechips');

async function getChips(userId) {
  const doc = await KadeGameChips.findOneAndUpdate(
    { user: userId },
    { $setOnInsert: { chips: 500 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return doc.chips;
}

/** Settle a net delta. Floor at 0 with a friendly 100-chip re-stake. Returns
 * { chips, restaked }. */
async function settleChips(userId, delta) {
  const inc = { chips: delta };
  if (delta > 0) inc.lifetimeWon = delta;
  if (delta < 0) inc.lifetimeLost = -delta;
  let doc = await KadeGameChips.findOneAndUpdate(
    { user: userId },
    { $inc: inc, $setOnInsert: {} },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  let restaked = false;
  if (doc.chips <= 0) {
    doc = await KadeGameChips.findOneAndUpdate(
      { user: userId },
      { $set: { chips: 100 } },
      { new: true },
    ).lean();
    restaked = true;
  }
  return { chips: doc.chips, restaked };
}

module.exports = { KadeGameChips, getChips, settleChips };
