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
 *   GET  /ledger?userId=&kind=repayment|grant|refund|all    entries, newest first (voided ones included)
 *   POST /repayments { userId, usd, at, note, clientKey }   idempotent on clientKey
 *   POST /repayments/:id/void { reason }  and  /repayments/:id/restore
 *   POST /refunds { userId, usd, note, clientKey }   Oct 20 2026: credit a balance back, once per clientKey
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
  const Balances = () => options.Balance || mongoose.models.Balance || mongoose.model('Balance');
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
    ...(e.kind === 'refund' || e.balanceAfterUSD != null ? { balanceAfterUSD: e.balanceAfterUSD ?? null } : {}),
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
      const q = kind === 'all' ? {} : { kind: kind === 'grant' || kind === 'refund' ? kind : 'repayment' };
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

  /**
   * KADE Oct 20 2026, her words: "Yes: the fuller refund ($20.91), plus Amber's failed turns..."
   * POST /refunds { userId, usd, note, clientKey, confirmUnpaid? }: gives usd back to a balance.
   *   1. A ledger row of kind 'refund' (never counted as a repayment) claims the clientKey, with
   *      creditState 'paying'; the ledger's unique index makes a second send with the same key
   *      answer duplicate: true and move no money.
   *   2. balances.tokenCredits += round(usd x 1e6), with the same upsert add-credits uses.
   *   3. balanceAfterUSD and creditState 'paid' are written back onto the row.
   * Review fix: a balance write that throws may still have landed (a timeout can hide a write that
   * went through), so the row is KEPT, marked creditState 'unknown', and the answer is 503. A
   * retry with the same key then answers 409 with the person's current balance and pays only
   * when the operator, having checked that balance, sends confirmUnpaid: true (same person and
   * amount). Only one request at a time can claim that second try (creditAttempts guards it).
   * Never a Transaction row: every chat readout sums tokenValue over all transaction rows, so a
   * credits row would be netted against a month's charges.
   */
  router.post(
    '/refunds',
    wrap(async (req, res) => {
      const v = funding.validateRefund(req.body || {});
      if (v.error) return res.status(400).json({ error: v.error });
      const { userId, usd, note, clientKey } = v.value;
      const confirmUnpaid = Boolean(req.body && req.body.confirmUnpaid === true);
      const L = Ledger();
      const toUSD = (credits) => Math.round((Number(credits) || 0) / 1e4) / 100;
      const currentBalanceUSD = async (uid) => {
        const b = await Balances()
          .findOne({ user: new mongoose.Types.ObjectId(String(uid)) }, { tokenCredits: 1 })
          .lean();
        return b ? toUSD(b.tokenCredits) : null;
      };
      const settled = (e) => e && (e.balanceAfterUSD != null || e.creditState === 'paid');
      const person = await Users().findById(userId, { name: 1, username: 1 }).lean();
      if (!person) return res.status(404).json({ error: 'No account for that person.' });
      const name = person.name || person.username || 'them';
      const names = new Map([[userId, name]]);
      const via = req.kadeOps ? 'ops' : 'admin';

      /** Move the money for a claimed row and record what it left. */
      const pay = async (row, retried = false) => {
        const credits = Math.round(usd * 1e6);
        let balance;
        try {
          balance = await Balances()
            .findOneAndUpdate(
              { user: new mongoose.Types.ObjectId(userId) },
              { $inc: { tokenCredits: credits } },
              { new: true, upsert: true, setDefaultsOnInsert: true },
            )
            .lean();
        } catch (e) {
          /* The credit may or may not have landed. Keep the row, so the key can never pay twice. */
          await L.updateOne({ _id: row._id }, { $set: { creditState: 'unknown' } }).catch(() => {});
          logger.error(
            `[kade/funding] refund ${row._id} to ${userId}: balance write failed, credit state unknown: ${e && e.message}`,
          );
          return res.status(503).json({
            error:
              'The balance write failed, so it is not known whether the refund landed. Check the balance before trying again; a retry with the same clientKey will ask you to confirm.',
            creditState: 'unknown',
            entry: { ...view(row, names), creditState: 'unknown' },
          });
        }
        const balanceUSD = toUSD(balance && balance.tokenCredits);
        await L.updateOne({ _id: row._id }, { $set: { balanceAfterUSD: balanceUSD, creditState: 'paid' } }).catch((e) =>
          logger.warn(`[kade/funding] refund ${row._id}: balanceAfterUSD not written: ${e && e.message}`),
        );
        logger.info(
          `[kade/funding] refund +$${usd.toFixed(2)} to ${userId} -> $${balanceUSD.toFixed(2)} via ${via}${retried ? ' (confirmed retry)' : ''}`,
        );
        return res.json({
          ok: true,
          ...(retried ? { retried: true } : {}),
          entry: { ...view({ ...row, balanceAfterUSD: balanceUSD }, names), creditState: 'paid' },
          credits,
          balanceUSD,
          spoken: `Refunded ${funding.dollars(usd)} to ${name}. Their balance is now ${funding.dollars(balanceUSD)}.`,
        });
      };

      /** A row whose credit did not land for sure: tell the operator, or pay on confirmUnpaid. */
      const unsettled = async (existing) => {
        const balanceUSD = await currentBalanceUSD(existing.user).catch(() => null);
        const entry = { ...view(existing, await nameOf([existing.user])), creditState: existing.creditState || 'unknown' };
        if (!confirmUnpaid) {
          return res.status(409).json({
            error:
              'A refund with this clientKey was recorded, but it is not known whether the credit reached the balance. Check the balance; if the refund is not in it, send the same request again with confirmUnpaid: true.',
            entry,
            balanceUSD,
          });
        }
        if (String(existing.user) !== userId || Number(existing.usd) !== usd) {
          return res.status(409).json({ error: 'That clientKey belongs to a different person or amount.', entry, balanceUSD });
        }
        const attempts = Number(existing.creditAttempts) || 0;
        const claimed = await L.findOneAndUpdate(
          { _id: existing._id, balanceAfterUSD: null, creditAttempts: attempts },
          { $set: { creditState: 'paying' }, $inc: { creditAttempts: 1 } },
          { new: true },
        ).lean();
        if (!claimed) {
          return res
            .status(409)
            .json({ error: 'Another request is crediting this refund right now. Check again in a moment.', entry, balanceUSD });
        }
        return pay(claimed, true);
      };

      const duplicateOrUnsettled = async () => {
        const dup = await L.findOne({ clientKey }).lean();
        if (dup && !settled(dup)) return unsettled(dup);
        return res.json({
          ok: true,
          duplicate: true,
          entry: dup ? view(dup, await nameOf([dup.user])) : null,
          balanceUSD: dup && dup.balanceAfterUSD != null ? dup.balanceAfterUSD : null,
        });
      };
      if (await L.exists({ clientKey })) return duplicateOrUnsettled();
      let doc;
      try {
        doc = await L.create({
          user: userId,
          kind: 'refund',
          usd,
          at: new Date(),
          note,
          clientKey,
          addedBy: actorId(req),
          via,
          creditState: 'paying',
          creditAttempts: 1,
        });
      } catch (e) {
        if (e && e.code === 11000) return duplicateOrUnsettled();
        throw e;
      }
      return pay(doc.toObject ? doc.toObject() : doc);
    }),
  );

  return router;
}

const router = createFundingRouter();
router.createFundingRouter = createFundingRouter;
module.exports = router;
