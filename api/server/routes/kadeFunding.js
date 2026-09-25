'use strict';
/**
 * KADE Sep 25 2026 (Part 291) — /api/kade/funding: what each person's use really cost Kade, what
 * they have paid her back, and the ledger she keeps of it.
 *
 * Every route takes Kade's admin sign-in OR the server-to-server ops secret (x-kade-ops-secret =
 * KADE_OPS_SECRET, see middleware/kadeOpsSecret). An ops call has no signed-in person, so nothing
 * here acts as anyone's account; entries it records say via 'ops'.
 *
 *   GET  /people?period=this_month|all_time         everyone with a cost or a repayment
 *   GET  /summary?userId=&period=&from=&to=          one person (the admin's own when userId is empty)
 *   GET  /ledger?userId=&kind=repayment|grant|all    entries, newest first (voided ones included)
 *   POST /repayments { userId, usd, at, note, clientKey }   idempotent on clientKey
 *   POST /repayments/:id/void { reason }  and  /repayments/:id/restore
 *
 * People ask about their own figures through the agent tool kade_funding_balance, not here.
 */
const express = require('express');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { opsOrAdmin } = require('~/server/middleware/kadeOpsSecret');
const { isAdminRole } = require('~/server/services/kadeRealCost');

const PERIODS = new Set(['this_month', 'all_time']);

function createFundingRouter(options = {}) {
  const router = express.Router();
  const funding = options.funding || require('~/server/services/kadeFunding');
  /* undefined = the service's own database dependencies */
  const deps = options.deps;
  const Ledger = () => options.Ledger || require('~/models/kadeFunding').KadeFundingEntry;
  const Users = () => options.User || mongoose.models.User || mongoose.model('User');
  const guard = options.guard || opsOrAdmin((req) => isAdminRole(req.user && req.user.role));
  const actorId = (req) => (req.user && (req.user.id || req.user._id) ? String(req.user.id || req.user._id) : null);

  const view = (e, names = new Map()) => ({
    id: String(e._id),
    userId: String(e.user),
    name: names.get(String(e.user)) || '',
    kind: e.kind || 'repayment',
    usd: e.usd,
    at: e.at,
    note: e.note || '',
    via: e.via || 'admin',
    voidedAt: e.voidedAt || null,
    voidReason: e.voidReason || '',
  });
  const nameOf = async (ids) => {
    const unique = [...new Set(ids.map(String))].filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (!unique.length) return new Map();
    const users = await Users().find({ _id: { $in: unique } }, { name: 1, username: 1 }).lean();
    return new Map(users.map((u) => [String(u._id), u.name || u.username || '']));
  };
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      logger.warn(`[kade/funding] ${req.method} ${req.path}: ${e && e.message}`);
      res.status(503).json({ error: 'Funding figures are not available right now.' });
    }
  };
  const windowOf = (req) =>
    funding.windowFor(PERIODS.has(req.query.period) ? req.query.period : 'all_time', {
      from: req.query.from,
      to: req.query.to,
    });

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(guard);

  router.get(
    '/summary',
    wrap(async (req, res) => {
      const userId = String(req.query.userId || actorId(req) || '');
      if (!userId) return res.status(400).json({ error: 'Say whose figures to read (userId).' });
      const s = await funding.fundingSummary(userId, windowOf(req), deps);
      if (!s) return res.status(404).json({ error: 'No such person.' });
      res.json({ ...s, spoken: funding.spokenLine(s, { self: userId === actorId(req) }) });
    }),
  );

  router.get(
    '/people',
    wrap(async (req, res) => {
      const window = windowOf(req);
      const people = await funding.fundingPeople(window, deps);
      const others = people.filter((p) => !p.admin);
      const sum = (k) => funding.cents(others.reduce((s, p) => s + (p[k] || 0), 0));
      const totals = { othersRealUSD: sum('realCostUSD'), paidBackUSD: sum('paidBackUSD') };
      totals.differenceUSD = funding.cents(totals.othersRealUSD - totals.paidBackUSD);
      const d = funding.dollars;
      const spoken =
        totals.othersRealUSD <= 0 && totals.paidBackUSD <= 0
          ? "Nobody else's use has cost you anything yet."
          : `Other people's use has really cost you ${d(totals.othersRealUSD)}. They have paid you back ${d(totals.paidBackUSD)}, so ` +
            (totals.differenceUSD > 0
              ? `you have covered ${d(totals.differenceUSD)} more than they paid back.`
              : totals.differenceUSD < 0
                ? `they are ${d(totals.differenceUSD)} ahead.`
                : "you're all square.");
      res.json({
        generatedAt: new Date().toISOString(),
        window: { from: window.from ? new Date(window.from).toISOString() : null, to: window.to ? new Date(window.to).toISOString() : null },
        totals,
        spoken,
        people,
        notes: [
          'Really cost = each chat meter row at the real provider price, plus pictures, video, phone, voice-call estimates and the rest at their recorded real price.',
          'Paid back = only repayments recorded here. Credit added with the +$5 button is kept as a grant and never counts.',
          "Your own row includes everyone's app and phone voice-chat turns, which run through your account.",
          'Fixed monthly bills are not split per person.',
        ],
      });
    }),
  );

  router.get(
    '/ledger',
    wrap(async (req, res) => {
      const kind = String(req.query.kind || 'repayment');
      const q = kind === 'all' ? {} : { kind: kind === 'grant' ? 'grant' : 'repayment' };
      if (req.query.userId && mongoose.Types.ObjectId.isValid(String(req.query.userId))) {
        q.user = new mongoose.Types.ObjectId(String(req.query.userId));
      }
      const rows = await Ledger().find(q).sort({ at: -1, _id: -1 }).limit(500).lean();
      const names = await nameOf(rows.map((r) => r.user));
      res.json({ entries: rows.map((r) => view(r, names)) });
    }),
  );

  router.post(
    '/repayments',
    wrap(async (req, res) => {
      const v = funding.validateRepayment(req.body || {});
      if (v.error) return res.status(400).json({ error: v.error });
      const { userId, usd, at, note, clientKey } = v.value;
      const L = Ledger();
      const duplicate = async () => {
        const dup = await L.findOne({ clientKey }).lean();
        return res.json({ ok: true, duplicate: true, entry: dup ? view(dup, await nameOf([dup.user])) : null });
      };
      if (clientKey && (await L.exists({ clientKey }))) return duplicate();
      const person = await Users().findById(userId, { name: 1, username: 1 }).lean();
      if (!person) return res.status(404).json({ error: 'No account for that person.' });
      const name = person.name || person.username || 'them';
      let doc;
      try {
        doc = await L.create({
          user: userId,
          kind: 'repayment',
          usd,
          at,
          note,
          clientKey,
          addedBy: actorId(req),
          via: req.kadeOps ? 'ops' : 'admin',
        });
      } catch (e) {
        if (e && e.code === 11000 && clientKey) return duplicate();
        throw e;
      }
      logger.info(`[kade/funding] repayment $${usd.toFixed(2)} for ${userId} recorded via ${req.kadeOps ? 'ops' : 'admin'}`);
      const s = await funding.fundingSummary(userId, {}, deps);
      res.json({
        ok: true,
        entry: view(doc.toObject(), new Map([[userId, name]])),
        summary: s,
        spoken: `Recorded ${funding.dollars(usd)} from ${name}.` + (s ? ` ${funding.spokenLine(s, { self: false })}` : ''),
      });
    }),
  );

  const flip = (toVoid) =>
    wrap(async (req, res) => {
      if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) return res.status(400).json({ error: 'Bad entry id.' });
      const set = toVoid
        ? { voidedAt: new Date(), voidedBy: actorId(req), voidReason: String((req.body && req.body.reason) || '').slice(0, 200) }
        : { voidedAt: null, voidedBy: null, voidReason: '' };
      const doc = await Ledger()
        .findOneAndUpdate(
          { _id: req.params.id, kind: 'repayment', voidedAt: toVoid ? null : { $ne: null } },
          { $set: set },
          { new: true },
        )
        .lean();
      if (!doc) {
        return res
          .status(404)
          .json({ error: toVoid ? 'That entry is gone or already removed.' : 'That entry is not removed.' });
      }
      logger.info(`[kade/funding] repayment ${req.params.id} ${toVoid ? 'removed' : 'put back'} via ${req.kadeOps ? 'ops' : 'admin'}`);
      const names = await nameOf([doc.user]);
      const s = await funding.fundingSummary(String(doc.user), {}, deps);
      res.json({
        ok: true,
        entry: view(doc, names),
        summary: s,
        spoken: s ? funding.spokenLine(s, { self: false }) : '',
      });
    });
  router.post('/repayments/:id/void', flip(true));
  router.post('/repayments/:id/restore', flip(false));

  return router;
}

const router = createFundingRouter();
router.createFundingRouter = createFundingRouter;
module.exports = router;
