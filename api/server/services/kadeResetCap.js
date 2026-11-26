'use strict';
/* ----------------------------------------------------------------------------
 * PASSWORD-RESET EMAILS: AT MOST ONE PER ACCOUNT EVERY 15 MINUTES, THREE A DAY
 * (Nov 26 2026, Part 460).
 *
 * On Nov 25 an outside address sent four reset emails to Kade's own account in
 * under an hour. The per-address limiter (resetPasswordLimiter) cannot stop
 * that: it counts per network address, and anyone can change address. This
 * counts per ACCOUNT instead, whoever asks.
 *
 * Each email that goes out leaves one row in the kaderesetsends collection
 * (account id and time, nothing else). Mongo removes a row after a day, so the
 * counts survive a restart and clean themselves up. A request that would go
 * over the cap takes its own row back out and sends nothing.
 *
 * Two requests for the same account in the same instant can both see the
 * other's row and both stand down. That sends no email, which is the safe way
 * to be wrong.
 *
 * The caller never learns whether the cap held: the reset route answers the
 * same words before any of this runs (AuthService.requestPasswordReset).
 * KADE_RESET_CAP=0 turns the cap off.
 * -------------------------------------------------------------------------- */
const mongoose = require('mongoose');

const SHORT_WINDOW_MS = 15 * 60 * 1000;
const SHORT_MAX = 1;
const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DAY_MAX = 3;

const resetSendSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Kept a day so the daily cap survives a restart, then removed by Mongo.
    createdAt: { type: Date, default: Date.now, expires: 24 * 60 * 60 },
  },
  { versionKey: false },
);

function mongoStore() {
  const Model =
    mongoose.models.KadeResetSend ||
    mongoose.model('KadeResetSend', resetSendSchema, 'kaderesetsends');
  return {
    add: async (userId, at) =>
      String((await Model.create({ userId, createdAt: new Date(at) }))._id),
    countSince: (userId, since) =>
      Model.countDocuments({ userId, createdAt: { $gt: new Date(since) } }),
    remove: (id) => Model.deleteOne({ _id: id }),
  };
}

function capIsOn(env = process.env) {
  return String((env && env.KADE_RESET_CAP) ?? '').trim() !== '0';
}

/**
 * @param {{ store: { add: Function, countSince: Function, remove: Function }, now?: () => number }} deps
 */
function createResetCap({ store, now = Date.now }) {
  return {
    /** Claims one send for this account. { ok: true, id } or { ok: false, reason }. */
    async take(userId) {
      const at = now();
      const id = await store.add(userId, at);
      const [lastShort, lastDay] = await Promise.all([
        store.countSince(userId, at - SHORT_WINDOW_MS),
        store.countSince(userId, at - DAY_WINDOW_MS),
      ]);
      if (lastShort > SHORT_MAX || lastDay > DAY_MAX) {
        try {
          await store.remove(id);
        } catch (_) {
          /* the row expires on its own within a day */
        }
        return { ok: false, reason: lastShort > SHORT_MAX ? 'fifteen-minutes' : 'day' };
      }
      return { ok: true, id };
    },
    /** Gives a send back when the email could not go out, so a real retry is not blocked. */
    async release(id) {
      if (!id) {
        return;
      }
      try {
        await store.remove(id);
      } catch (_) {
        /* the row expires on its own within a day */
      }
    },
  };
}

let defaultCap = null;
function resetCap() {
  if (!defaultCap) {
    defaultCap = createResetCap({ store: mongoStore() });
  }
  return defaultCap;
}

module.exports = {
  createResetCap,
  resetCap,
  capIsOn,
  mongoStore,
  SHORT_WINDOW_MS,
  SHORT_MAX,
  DAY_WINDOW_MS,
  DAY_MAX,
};
