'use strict';
/**
 * KADE SONG CHARGE (Nov 10 2026): a YuE2 song costs the person who starts it 12 cents.
 *
 * Her words: "no limits on who can use, or the amount of songs. Rather, subtract ten cents or
 * 12 cents or something like that from their own balance." and "Yes the booth should charge 12
 * cents also, it's free for me of course."
 *
 * The rule, in one place for the Sound Booth page and for a character (tools/structured/KadeStudio.js
 * reaches the booth through the booth's own /render, so this is the only code that charges):
 *   - the unit is ONE TAKE (review fix, Nov 10: a take is a whole song on a GPU, about 5 cents of
 *     her money before wake-up and idle, so four takes for one flat 12 cents lost money on every
 *     request). A request may ask for one to four takes (yue.ts yueInput) and is one job in the
 *     queue (audio/jobs.ts): it is held once, for 12 cents times its takes. KADE_SONG_CHARGE_PER_TAKE=0
 *     goes back to one flat price per request, however many takes;
 *   - the price is the same for every account, and is not multiplied by the platform factor or
 *     halved for the Family pack. The administrator pays nothing and no row is written for her;
 *   - the money is HELD before the booth is asked (one conditional update on the Balance record:
 *     it only succeeds when the balance covers the price, so two starts cannot both spend the last
 *     12 cents). A balance that is too low is refused in a plain sentence and nothing is sent;
 *   - the hold becomes a charge when the booth answers that the job was accepted. Any other answer
 *     (a refusal, "you already have a request in progress", an unconfirmed submission) gives the
 *     money straight back;
 *   - when the job ends the row is closed, once: every take that was not saved gets its 12 cents
 *     back (all of it when nothing was saved: it failed, or it was stopped before a GPU began
 *     rendering it). A song stopped after rendering began with nothing saved is not refunded (the
 *     GPU time was spent). With the flat price, a request with at least one saved take keeps it all;
 *   - a charged row whose job never ends (a take stuck saving, a status call that keeps failing) is
 *     closed by sweep() after KADE_SONG_STUCK_HOURS (2): unsaved takes are refunded. The same sweep
 *     gives back holds left by a crash, for everyone, on a timer (kadeSoundBooth.js), not only when
 *     that person next starts a song.
 *
 * The same row remembers which character and conversation asked for the song, and holds the
 * one-time claim for the "your song is ready" message (services/kadeStudio.js deliver), so two
 * servers during a deploy cannot post it twice.
 *
 * Kade's real GPU cost is not written here: it stays on the take (KadeAsset.costUSD) as before.
 * The kadeusage row for a charge carries costUSD 0 and chargedUSD 0.12, so her "what this really
 * cost me" readouts do not move and the person's usage page shows what they paid.
 *
 * Switches (read per call):
 *   KADE_SONG_CHARGE=0          no charge at all: YuE2 is free to everyone, as it was
 *   KADE_SONG_PRICE_CENTS=12    the price; 0 also means free
 *   KADE_SONG_HOLD_MINUTES=10   a hold with no job after this long is given back
 *   KADE_SONG_CHARGE_PER_TAKE=0 one flat price per request instead of the price times its takes
 *   KADE_SONG_STUCK_HOURS=2     a charged song still not ended after this long is closed and refunded
 *   KADE_SONG_SWEEP=0           the timed sweep does nothing (holds are still swept at a person's next start)
 *
 * No '~' requires at load time, so node --test loads it.
 */

const crypto = require('crypto');

const CHARGES = 'kadesongcharges';
const SERVICE = 'yue2_song';

function chargeOn(env = process.env) {
  return String((env && env.KADE_SONG_CHARGE) ?? '') !== '0';
}

function priceCents(env = process.env) {
  const raw = env && env.KADE_SONG_PRICE_CENTS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return 12;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 12;
  return Math.min(500, Math.round(n));
}

function holdMinutes(env = process.env) {
  const n = Number(env && env.KADE_SONG_HOLD_MINUTES);
  return Number.isFinite(n) && n >= 1 ? Math.min(120, n) : 10;
}

function perTakeOn(env = process.env) {
  return String((env && env.KADE_SONG_CHARGE_PER_TAKE) ?? '') !== '0';
}

function stuckHours(env = process.env) {
  const n = Number(env && env.KADE_SONG_STUCK_HOURS);
  return Number.isFinite(n) && n >= 0.5 ? Math.min(48, n) : 2;
}

/** The number of takes a request asks for, read the way the booth's own parser reads it (1 to 4, whole). */
function takesOf(count) {
  return typeof count === 'number' && Number.isInteger(count) && count >= 1 && count <= 4 ? count : 1;
}

const isAdmin = (account) => String((account && account.role) || '').toUpperCase() === 'ADMIN';

/** "12 cents", "1 cent", "$1.50". */
function sayCents(cents) {
  if (cents >= 100) return `$${(cents / 100).toFixed(2)}`;
  return `${cents} cent${cents === 1 ? '' : 's'}`;
}

/**
 * What a YuE2 request costs this account: the price of one take times its takes (or one flat
 * price with KADE_SONG_CHARGE_PER_TAKE=0).
 * @param {number} [takes] how many takes the request asks for (1 to 4); 1 when not given
 * @returns {{ free: boolean, admin: boolean, cents: number, unitCents: number, takes: number, perTake: boolean, usd: number, credits: number }}
 */
function priceFor(account, env = process.env, takes = 1) {
  const admin = isAdmin(account);
  const unit = chargeOn(env) ? priceCents(env) : 0;
  const free = admin || unit === 0;
  const perTake = perTakeOn(env);
  const n = takesOf(takes);
  const cents = free ? 0 : perTake ? unit * n : unit;
  return { free, admin, cents, unitCents: free ? 0 : unit, takes: n, perTake, usd: cents / 100, credits: cents * 10000 };
}

/** The price line beside the start control, in reading order; null for an account that pays nothing. */
function priceSentence(account, env = process.env) {
  const p = priceFor(account, env);
  if (p.free) return null;
  if (p.perTake) {
    return (
      `Each YuE2 take you start takes ${sayCents(p.unitCents)} from your balance: one take is ${sayCents(p.unitCents)}, four takes are ${sayCents(p.unitCents * 4)}. ` +
      `A take that fails gets its ${sayCents(p.unitCents)} back, and so does a song you stop before it starts rendering.`
    );
  }
  return (
    `Each YuE2 song you start takes ${sayCents(p.cents)} from your balance, however many takes you ask for. ` +
    `If the song fails, or you stop it before it starts rendering, the ${sayCents(p.cents)} goes back to your balance.`
  );
}

let indexed = false;
function coll(deps) {
  if (deps && deps.coll) return deps.coll;
  const c = require('mongoose').connection.collection(CHARGES);
  if (!indexed) {
    indexed = true;
    /* Small lookups by job, by charge and by person; never awaited, never fatal. */
    for (const keys of [{ jobId: 1 }, { chargeId: 1 }, { userId: 1, createdAt: -1 }]) {
      Promise.resolve()
        .then(() => c.createIndex(keys))
        .catch(() => {});
    }
  }
  return c;
}

function unwrap(found) {
  const doc = found && (found.value !== undefined ? found.value : found);
  return doc && doc._id !== undefined ? doc : null;
}

/* ------------------------------------------------------------------ the wallet */

/**
 * The person's Balance record (1,000,000 tokenCredits = $1), the same one chat turns and paid
 * extras draw from. take() is one conditional update, so it either takes the whole price or
 * nothing. A first-time account is given its normal start balance first, the way the pre-turn
 * check does (kadeRealCost.voiceWalletUpdate). With balances switched off on the platform nothing
 * is metered and the song is not charged.
 */
function defaultWallet() {
  const Balance = () => require('mongoose').models.Balance;
  async function balanceConfig() {
    try {
      const { getAppConfig } = require('~/server/services/Config');
      const { getBalanceConfig } = require('@librechat/api');
      return getBalanceConfig(await getAppConfig({})) || null;
    } catch (_) {
      return undefined; /* could not be read: treated as metered, never as free */
    }
  }
  const tryTake = (Model, userId, credits) =>
    Model.findOneAndUpdate(
      { user: userId, tokenCredits: { $gte: credits } },
      { $inc: { tokenCredits: -credits } },
      { new: true },
    ).lean();
  return {
    async take(userId, credits) {
      const Model = Balance();
      if (!Model) return { ok: true, unmetered: true };
      let hit = await tryTake(Model, userId, credits);
      if (hit) return { ok: true, left: hit.tokenCredits };
      const config = await balanceConfig();
      if (config === null || (config && config.enabled === false)) return { ok: true, unmetered: true };
      const current = await Model.findOne({ user: userId }, { tokenCredits: 1 }).lean();
      if ((!current || current.tokenCredits == null) && config && config.startBalance != null) {
        await require('./kadeRealCost').voiceWalletUpdate({ balanceConfig: config, Balance: Model })({ user: userId, incrementValue: 0 });
        hit = await tryTake(Model, userId, credits);
        if (hit) return { ok: true, left: hit.tokenCredits };
      }
      const now = await Model.findOne({ user: userId }, { tokenCredits: 1 }).lean();
      return { ok: false, have: (now && now.tokenCredits) || 0 };
    },
    async give(userId, credits) {
      const Model = Balance();
      if (!Model) return;
      await Model.updateOne({ user: userId }, { $inc: { tokenCredits: credits } });
    },
  };
}

/** The kadeusage row for a charge or a refund, so the person's usage page shows it. Never debits. */
function defaultUsage() {
  return {
    async row(doc) {
      const { KadeUsage } = require('~/models/kadeUsage');
      await KadeUsage.create(doc);
    },
  };
}

function wallet(deps) {
  return (deps && deps.wallet) || defaultWallet();
}
function usage(deps) {
  return (deps && deps.usage) || defaultUsage();
}
function warn(deps, line) {
  try {
    if (deps && typeof deps.log === 'function') return deps.log(line);
    require('@librechat/data-schemas').logger.warn(line);
  } catch (_) {
    /* never throws */
  }
}

/* -------------------------------------------------------------------- the hold */

/**
 * Give back holds this person left behind: money taken for a start whose answer never came
 * (a crash between the hold and the booth's reply). Never throws.
 */
async function sweepStaleHolds(userId, deps = {}) {
  try {
    const env = deps.env || process.env;
    const cutoff = new Date(Date.now() - holdMinutes(env) * 60000);
    for (let i = 0; i < 5; i += 1) {
      const stale = await coll(deps).findOne({ userId: String(userId), state: 'held', createdAt: { $lt: cutoff } });
      if (!stale) return;
      await refund({ chargeId: stale.chargeId, reason: 'the start never finished' }, deps);
    }
  } catch (e) {
    warn(deps, `[kadeSongCharge] stale hold sweep failed: ${e && e.message}`);
  }
}

/**
 * Take the price before the booth is asked.
 * @returns {Promise<{ ok: true, free: true } | { ok: true, free: false, chargeId: string, cents: number }
 *   | { ok: false, reason: 'low-balance', error: string, cents: number }>}
 */
async function hold({ userId, account, origin = 'booth', takes = 1 }, deps = {}) {
  const env = deps.env || process.env;
  const price = priceFor(account, env, takes);
  if (price.free) return { ok: true, free: true };
  const uid = String(userId);
  await sweepStaleHolds(uid, deps);
  const took = await wallet(deps).take(uid, price.credits);
  if (!took.ok) {
    const have = Math.max(0, Math.floor((Number(took.have) || 0) / 10000));
    return {
      ok: false,
      reason: 'low-balance',
      cents: price.cents,
      error:
        `Your balance is too low for this song. ${price.perTake && price.takes > 1 ? `${price.takes} YuE2 takes take` : 'A YuE2 song takes'} ${sayCents(price.cents)} and your balance is ${have < 1 ? 'under 1 cent' : `about ${sayCents(have)}`}. ` +
        'Nothing was started and nothing was charged. Your words are kept.',
    };
  }
  if (took.unmetered) return { ok: true, free: true };
  const chargeId = `c${crypto.randomBytes(8).toString('hex')}`;
  try {
    await coll(deps).insertOne({
      chargeId,
      userId: uid,
      credits: price.credits,
      cents: price.cents,
      unitCredits: price.unitCents * 10000,
      takes: price.takes,
      perTake: price.perTake,
      state: 'held',
      origin,
      createdAt: new Date(),
    });
  } catch (e) {
    await wallet(deps).give(uid, price.credits).catch(() => {});
    throw e;
  }
  return { ok: true, free: false, chargeId, cents: price.cents };
}

/**
 * The booth has answered. started = it accepted the job (it has an id and is queued).
 * A start keeps the money and writes the usage row; anything else gives it back.
 * @returns {Promise<'charged' | 'refunded' | 'none'>}
 */
async function settle({ chargeId, started, jobId, projectId, reason }, deps = {}) {
  if (!chargeId) return 'none';
  if (!started || !jobId) {
    const back = await refund({ chargeId, reason: reason || 'the song was not started' }, deps);
    return back ? 'refunded' : 'none';
  }
  const row = unwrap(
    await coll(deps).findOneAndUpdate(
      { chargeId, state: 'held' },
      { $set: { state: 'charged', jobId: String(jobId), settledAt: new Date(), ...(projectId ? { projectId: String(projectId) } : {}) } },
      { returnDocument: 'after' },
    ),
  );
  if (!row) return 'none';
  try {
    await usage(deps).row({
      user: row.userId,
      service: SERVICE,
      quantity: 1,
      unit: 'songs',
      costUSD: 0,
      chargedUSD: row.credits / 1e6,
      metadata: { requestId: row.chargeId, jobId: String(jobId), origin: row.origin, flatPrice: true },
    });
  } catch (e) {
    warn(deps, `[kadeSongCharge] usage row not written for ${row.chargeId}: ${e && e.message}`);
  }
  /* Review fix: the queue may have ended this job in the moment between the booth's answer and the
   * write above; its update hook then found no charged row and will not run again. Look once now.
   * Not awaited: the booth's answer does not wait on it. */
  if (deps && typeof deps.job === 'function') {
    Promise.resolve()
      .then(() => deps.job(String(jobId)))
      .then((job) => (job ? afterJobUpdate(job, deps) : null))
      .catch((e) => warn(deps, `[kadeSongCharge] look after settle failed for ${row.chargeId}: ${e && e.message}`));
  }
  return 'charged';
}

/**
 * Give one charge back, exactly once. The claim is one atomic write on the row (state leaves
 * 'held' or 'charged'); only the caller whose write matched moves money. If the money could not
 * be moved the claim is let go, so a later pass can try again.
 * @returns {Promise<boolean>} true when THIS call refunded it
 */
async function refund({ chargeId, jobId, reason, credits, savedTakes }, deps = {}) {
  const key = chargeId ? { chargeId } : jobId ? { jobId: String(jobId) } : null;
  if (!key) return false;
  const c = coll(deps);
  const before = await c.findOne({ ...key, state: { $in: ['held', 'charged'] } });
  if (!before) return false;
  /* All of it unless a smaller amount is named (the takes that were not saved). Never more than was taken. */
  const whole = Number(before.credits) || 0;
  const amount = credits == null ? whole : Math.max(0, Math.min(whole, Math.round(Number(credits) || 0)));
  if (amount <= 0) return false;
  const after = amount >= whole ? 'refunded' : 'part-refunded';
  const now = new Date();
  const claimed = unwrap(
    await c.findOneAndUpdate(
      { chargeId: before.chargeId, state: before.state },
      {
        $set: {
          state: after,
          refundedAt: now,
          closedAt: now,
          refundedCredits: amount,
          refundedCents: Math.round(amount / 10000),
          refundReason: String(reason || 'refund').slice(0, 160),
          ...(savedTakes == null ? {} : { savedTakes }),
        },
      },
      { returnDocument: 'after' },
    ),
  );
  if (!claimed) return false;
  try {
    await wallet(deps).give(claimed.userId, amount);
  } catch (e) {
    await c
      .updateOne(
        { chargeId: claimed.chargeId, state: after },
        { $set: { state: before.state }, $unset: { refundedAt: 1, closedAt: 1, refundedCredits: 1, refundedCents: 1, refundReason: 1, savedTakes: 1 } },
      )
      .catch(() => {});
    throw e;
  }
  if (before.state === 'charged') {
    try {
      await usage(deps).row({
        user: claimed.userId,
        service: SERVICE,
        quantity: 1,
        unit: 'songs',
        costUSD: 0,
        chargedUSD: -(amount / 1e6),
        metadata: { refund_for: claimed.chargeId, jobId: claimed.jobId, reason: String(reason || 'refund').slice(0, 120), flatPrice: true },
      });
    } catch (e) {
      warn(deps, `[kadeSongCharge] refund usage row not written for ${claimed.chargeId}: ${e && e.message}`);
    }
  }
  return true;
}

/* ------------------------------------------------- the job's life (booth hooks.update) */

const ACTIVE = ['submitting', 'queued', 'running', 'saving', 'pending'];

/** Can the queue still save a take of this job? An unconfirmed job is never followed again, whatever its takes say. */
function stillGoing(job) {
  const takes = Array.isArray(job && job.takes) ? job.takes : [];
  return job.state !== 'uncertain' && (ACTIVE.includes(job.state) || takes.some((t) => t && ACTIVE.includes(t.state)));
}

/**
 * Close a charged row against how its job ended: keep the price of what was saved, give the rest
 * back. One atomic write either way (the row leaves 'charged', or gains closedAt), so it happens
 * once however many callers arrive (the queue's hook, the look after settle, the timed sweep).
 * @returns {Promise<'refunded' | 'kept' | 'none'>}
 */
async function closeOut(row, job, reason, deps = {}) {
  const takes = Array.isArray(job && job.takes) ? job.takes : [];
  const saved = takes.filter((t) => t && t.state === 'done').length;
  const whole = Number(row.credits) || 0;
  const unit = Number(row.unitCredits) || whole;
  /* Stopped by the person after a GPU had begun, with nothing saved: the time was spent. */
  const spent = job && job.state === 'cancelled' && row.rendering === true && saved === 0;
  const keep = spent ? whole : row.perTake === true ? Math.min(whole, saved * unit) : saved > 0 ? whole : 0;
  const back = whole - keep;
  if (back > 0) return (await refund({ chargeId: row.chargeId, reason, credits: back, savedTakes: saved }, deps)) ? 'refunded' : 'none';
  const hit = await coll(deps).updateOne(
    { chargeId: row.chargeId, state: 'charged', closedAt: { $exists: false } },
    { $set: { closedAt: new Date(), savedTakes: saved } },
  );
  return hit && (hit.modifiedCount || hit.matchedCount) ? 'kept' : 'none';
}

/**
 * Called each time the queue writes a YuE2 job's state (kadeSoundBooth.js, the YuE2 router's
 * update hook). Notes the moment a GPU begins rendering, and when the job has ended closes the
 * charge: unsaved takes are refunded (see closeOut). Never throws.
 * @param {{ id: string, state: string, takes?: Array<{ state: string }> }} job
 * @returns {Promise<'refunded' | 'kept' | 'none'>}
 */
async function afterJobUpdate(job, deps = {}) {
  try {
    if (!job || !job.id) return 'none';
    const c = coll(deps);
    const takes = Array.isArray(job.takes) ? job.takes : [];
    const rendering = job.state === 'running' || takes.some((t) => t && ['running', 'saving', 'done'].includes(t.state));
    if (rendering) {
      await c.updateOne({ jobId: String(job.id), rendering: { $ne: true } }, { $set: { rendering: true } });
    }
    if (stillGoing(job)) return 'kept';
    const row = await c.findOne({ jobId: String(job.id), state: 'charged', closedAt: { $exists: false } });
    if (!row) return 'none';
    const reason =
      job.state === 'cancelled' ? 'stopped before it rendered' : takes.some((t) => t && t.state === 'done') ? 'a take was not saved' : 'the song failed';
    return await closeOut(row, job, reason, deps);
  } catch (e) {
    warn(deps, `[kadeSongCharge] afterJobUpdate failed for ${job && job.id}: ${e && e.message}`);
    return 'none';
  }
}

/**
 * The timed pass (kadeSoundBooth.js runs it every few minutes; safe on two servers, every step is
 * an atomic claim). 1. Holds left behind by a crash or a deploy, anybody's, are given back.
 * 2. A charged row still open after KADE_SONG_STUCK_HOURS: if its job has ended it is closed the
 * normal way (the hook missed it); if the job is still "active" it is stuck, and the takes that
 * were not saved are refunded. Step 2 needs deps.job(jobId). Never throws.
 * @returns {Promise<{ holds: number, closed: number }>}
 */
async function sweep(deps = {}) {
  const out = { holds: 0, closed: 0 };
  const env = deps.env || process.env;
  if (String((env && env.KADE_SONG_SWEEP) ?? '') === '0') return out;
  try {
    const c = coll(deps);
    const now = Date.now();
    const holdCut = new Date(now - holdMinutes(env) * 60000);
    for (let i = 0; i < 20; i += 1) {
      const stale = await c.findOne({ state: 'held', createdAt: { $lt: holdCut } });
      if (!stale) break;
      if (await refund({ chargeId: stale.chargeId, reason: 'the start never finished' }, deps)) out.holds += 1;
      else break;
    }
    if (typeof deps.job !== 'function') return out;
    const stuckCut = new Date(now - stuckHours(env) * 3600000);
    const seen = [];
    for (let i = 0; i < 20; i += 1) {
      const row = await c.findOne({ state: 'charged', closedAt: { $exists: false }, settledAt: { $lt: stuckCut }, chargeId: { $nin: seen } });
      if (!row) break;
      seen.push(row.chargeId);
      const job = await deps.job(String(row.jobId));
      let did;
      if (job && !stillGoing(job)) did = await afterJobUpdate(job, deps);
      else did = await closeOut(row, { state: 'failed', takes: (job && job.takes) || [] }, 'the song never finished', deps);
      if (did !== 'none') {
        out.closed += 1;
        warn(deps, `[kadeSongCharge] sweep closed ${row.chargeId} (${did}), still open after ${stuckHours(env)} h`);
      }
    }
  } catch (e) {
    warn(deps, `[kadeSongCharge] sweep failed: ${e && e.message}`);
  }
  return out;
}

/* ---------------------------------------------- who asked, and the one-time delivery */

/**
 * Remember the character and conversation that asked for this job. A job with no charge row
 * (the administrator's, or with the charge switched off) gets one that holds only this.
 */
async function attach({ jobId, userId, projectId, agentId, agentName, conversationId, lane, title }, deps = {}) {
  if (!jobId || !userId || !agentId) return false;
  const c = coll(deps);
  const fields = {
    origin: 'character',
    agentId: String(agentId),
    agentName: String(agentName || '').slice(0, 80),
    conversationId: conversationId ? String(conversationId) : null,
    lane: lane || 'text',
    title: String(title || '').slice(0, 120),
    ...(projectId ? { projectId: String(projectId) } : {}),
  };
  const hit = await c.updateOne({ jobId: String(jobId), userId: String(userId) }, { $set: fields });
  if (hit && (hit.modifiedCount || hit.matchedCount)) return true;
  await c.insertOne({
    chargeId: `f${crypto.randomBytes(8).toString('hex')}`,
    userId: String(userId),
    jobId: String(jobId),
    credits: 0,
    cents: 0,
    state: 'free',
    createdAt: new Date(),
    ...fields,
  });
  return true;
}

/**
 * Claim the "your song is ready" message for a job a character started. One atomic write: the
 * first server to ask gets the row, every later ask gets null.
 */
async function claimDelivery(jobId, deps = {}) {
  if (!jobId) return null;
  return unwrap(
    await coll(deps).findOneAndUpdate(
      { jobId: String(jobId), origin: 'character', deliveredAt: { $exists: false } },
      { $set: { deliveredAt: new Date() } },
      { returnDocument: 'after' },
    ),
  );
}

async function noteDelivery(jobId, delivery, deps = {}) {
  try {
    await coll(deps).updateOne({ jobId: String(jobId) }, { $set: { delivery } });
  } catch (_) {
    /* a note only */
  }
}

/** This person's newest song row (the character's status and cancel look here). */
async function latest(userId, deps = {}) {
  return coll(deps).findOne({ userId: String(userId), jobId: { $exists: true } }, { sort: { createdAt: -1 } });
}

async function byJob(jobId, userId, deps = {}) {
  if (!jobId) return null;
  return coll(deps).findOne({ jobId: String(jobId), userId: String(userId) });
}

/* --------------------------------------------- the booth's /render (middleware body) */

const OLD_COST_LINE = /YuE2 does not deduct from your credit balance yet[\s\S]*?(?:use more\.|$)/;

/** The estimate the page reads out, with the price in it. `data` is the booth's own answer. */
function withPrice(data, price, state) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || price.free) return data;
  const many = price.perTake && price.takes > 1;
  const each = sayCents(price.unitCents);
  const said =
    state === 'charged'
      ? many
        ? `${sayCents(price.cents)} was taken from your balance, ${each} for each of ${price.takes} takes. A take that fails gets its ${each} back.`
        : `${sayCents(price.cents)} was taken from your balance for this song. If the song fails, the ${sayCents(price.cents)} goes back.`
      : many
        ? `Starting this takes ${sayCents(price.cents)} from your balance, ${each} for each of ${price.takes} takes.`
        : price.perTake
          ? `Starting this song takes ${sayCents(price.cents)} from your balance.`
          : `Starting this song takes ${sayCents(price.cents)} from your balance, however many takes you ask for.`;
  const out = { ...data, charge: { cents: price.cents, state: state || 'quoted' } };
  if (out.estimate && typeof out.estimate.spoken === 'string') {
    const spoken = OLD_COST_LINE.test(out.estimate.spoken) ? out.estimate.spoken.replace(OLD_COST_LINE, said) : `${out.estimate.spoken} ${said}`;
    out.estimate = { ...out.estimate, spoken, costUSD: price.usd };
  } else if (state === 'charged') {
    out.estimate = { spoken: said, costUSD: price.usd };
  }
  return out;
}

/**
 * The booth's YuE2 start, with the charge around it. Mounted just before the YuE2 router, after
 * the booth's own gates (ACE, trained styles), for a signed-in request whose engine is yue2.
 * It never changes what the router decides; it holds the price first, and settles when the
 * router answers. `next` runs the router.
 */
async function boothGate(req, res, next, deps = {}) {
  const env = deps.env || process.env;
  const body = (req && req.body) || {};
  const account = req && req.user;
  const price = priceFor(account, env, body.count);
  if (price.free) return next();
  const json = res.json.bind(res);
  if (body.estimateOnly) {
    res.json = (data) => json(res.statusCode < 400 ? withPrice(data, price, 'quoted') : data);
    return next();
  }
  let held;
  try {
    held = await hold({ userId: String(account.id || account._id), account, origin: 'booth', takes: body.count }, deps);
  } catch (e) {
    warn(deps, `[kadeSongCharge] hold failed: ${e && e.message}`);
    return res.status(503).json({ error: 'The balance could not be checked just now. Nothing was started and nothing was charged. Try again.' });
  }
  if (!held.ok) return res.status(402).json({ error: held.error, lowBalance: true, priceCents: held.cents });
  if (held.free) return next();
  let settled = false;
  const finish = async (data) => {
    if (settled) return 'none';
    settled = true;
    const started = res.statusCode === 200 && !!data && typeof data === 'object' && !!data.jobId && data.ok !== false;
    try {
      return await settle(
        { chargeId: held.chargeId, started, jobId: data && data.jobId, projectId: data && data.projectId, reason: 'the booth did not start the song' },
        deps,
      );
    } catch (e) {
      warn(deps, `[kadeSongCharge] settle failed for ${held.chargeId}: ${e && e.message}`);
      return 'none';
    }
  };
  /* The answer waits for the one small write that settles the hold, so it can say what was taken. A second answer for
   * the same request (the router's own catch) is dropped, as Express would refuse it anyway. */
  let answered = false;
  res.json = (data) => {
    if (answered) return res;
    answered = true;
    const code = res.statusCode;
    finish(data)
      .then((state) => {
        res.statusCode = code;
        json(state === 'charged' ? withPrice(data, price, 'charged') : data);
      })
      .catch((e) => warn(deps, `[kadeSongCharge] answer not sent for ${held.chargeId}: ${e && e.message}`));
    return res;
  };
  /* An answer that never came through res.json (a crash in the router): the hold goes back.
   * A connection that only closed early is given time, because the router still finishes the
   * start and answers into the closed socket, and that answer settles the hold properly. */
  if (typeof res.on === 'function') {
    res.on('close', () => {
      if (settled) return;
      const timer = setTimeout(() => void finish(null), deps.closeGraceMs ?? 180000);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }
  return next();
}

module.exports = {
  CHARGES,
  SERVICE,
  chargeOn,
  priceCents,
  priceFor,
  priceSentence,
  sayCents,
  hold,
  settle,
  refund,
  afterJobUpdate,
  attach,
  claimDelivery,
  noteDelivery,
  latest,
  byJob,
  withPrice,
  boothGate,
  sweepStaleHolds,
  sweep,
  perTakeOn,
  takesOf,
};
