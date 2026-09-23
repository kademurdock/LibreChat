/* ----------------------------------------------------------------------------
 * PASSWORD RESET BY PHONE CALL (Sep 22 2026, Kade: "If you wanna invent a self
 * service password recovery that would be great").
 *
 * The website's email reset works for accounts with a real email address.
 * Accounts that sign in with a PHONE NUMBER carry a placeholder address
 * (p<10 digits>@phone.kade-ai.invalid, see kadeLoginId.js), so an emailed link
 * can never reach them and a forgotten password meant waiting for Kade. This
 * lets them reset it themselves: the platform's own number calls the phone on
 * the account and reads a six-digit code aloud (a spoken code needs no carrier
 * text-message registration, and it is friendlier for blind family members).
 *
 *   POST /api/kade/phone-reset/start  { phone }
 *     Always the same answer, whether or not the number has an account, so
 *     the form cannot be used to learn who is on the platform.
 *   POST /api/kade/phone-reset/finish { phone, code, password }
 *     Sets the password exactly the way /admin/set-password does (bcrypt 10,
 *     8 to 128 characters) and signs every session out.
 *   GET  /reset-by-phone               the page (kadePages.phoneResetHtml)
 *
 * The code is 6 random digits, stored only as a bcrypt hash, good for 10
 * minutes; five wrong tries end it. Limits: one call per number every two
 * minutes and three a day, 40 calls a day for the whole platform, and 10 start
 * requests per network address an hour. The bridge places the call
 * (POST /account-code-call, BRIDGE_SECRET) and never logs the code. Nothing
 * here logs a password, a code or a full phone number. The rules themselves
 * are in kadePhoneResetCore.js, tested by kadePhoneReset.selftest.js.
 * -------------------------------------------------------------------------- */
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { createPhoneReset } = require('./kadePhoneResetCore');

const phoneResetSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    used: { type: Boolean, default: false },
    // Rows are kept a day so the daily limits survive a restart, then removed.
    createdAt: { type: Date, default: Date.now, expires: 24 * 60 * 60 },
  },
  { versionKey: false },
);

function mongoStore() {
  const Model =
    mongoose.models.KadePhoneReset || mongoose.model('KadePhoneReset', phoneResetSchema, 'kadephoneresets');
  const plain = (d) =>
    d ? { ...d, createdAt: new Date(d.createdAt).getTime(), expiresAt: new Date(d.expiresAt).getTime() } : null;
  return {
    create: (doc) => Model.create({ ...doc, createdAt: new Date(doc.createdAt), expiresAt: new Date(doc.expiresAt) }),
    recent: async (phone, since) =>
      (await Model.find({ phone, createdAt: { $gt: new Date(since) } }).lean()).map(plain),
    countAll: (since) => Model.countDocuments({ createdAt: { $gt: new Date(since) } }),
    latestActive: async (phone, at) =>
      plain(
        await Model.findOne({ phone, used: false, expiresAt: { $gt: new Date(at) } })
          .sort({ createdAt: -1 })
          .lean(),
      ),
    addAttempt: async (id) =>
      (await Model.findByIdAndUpdate(id, { $inc: { attempts: 1 } }, { new: true }).lean()).attempts,
    useAll: (phone) => Model.updateMany({ phone, used: false }, { $set: { used: true } }),
  };
}

/** Asks the bridge to place the call. The bridge owns the Twilio number. */
async function bridgeCodeCall(to, code) {
  const secret = process.env.BRIDGE_SECRET;
  if (!secret) {
    throw new Error('BRIDGE_SECRET missing');
  }
  const base = (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`${base}/account-code-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bridge-secret': secret },
      body: JSON.stringify({ to, code }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      throw new Error(`bridge answered ${r.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Mounts the two routes on the /api/kade router (public: the person is locked out). */
function mountPhoneReset(router) {
  let service = null;
  const get = () => {
    if (!service) {
      const { findUser, updateUser, deleteAllUserSessions } = require('~/models');
      service = createPhoneReset({
        findUser,
        updateUser,
        deleteAllUserSessions,
        store: mongoStore(),
        callCode: bridgeCodeCall,
        hash: (value) => bcrypt.hashSync(value, 10),
        compare: (value, digest) => bcrypt.compareSync(value, digest),
        logger,
      });
    }
    return service;
  };
  const wrap = (fn) => async (req, res) => {
    try {
      const out = await fn(req);
      return res.status(out.status).json(out.body);
    } catch (error) {
      logger.error('[phone-reset] error:', error);
      return res.status(500).json({ message: 'Something went wrong. Try again in a few minutes, or ask Kade.' });
    }
  };
  router.post('/phone-reset/start', wrap((req) => get().start({ phone: req.body?.phone, ip: req.ip })));
  router.post(
    '/phone-reset/finish',
    wrap((req) => get().finish({ phone: req.body?.phone, code: req.body?.code, password: req.body?.password })),
  );
}

module.exports = { mountPhoneReset };
