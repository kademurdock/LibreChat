/**
 * KADE BACKGROUND TASKS (Oct 16 2026): "go work on it and get back to me."
 *
 * Kade: "I want to use chars the way I use claude code and codex ... The more my
 * characters can do agentically, the better." Her decisions the same night:
 * Kade and adult family get this, never kids' accounts; it is billed to the
 * person who asked, like a chat turn; the price is shown first, with a ceiling.
 *
 * A task is the CHARACTER itself working: its persona, its tools, the person's
 * memory, run as a hidden turn on the person's own seat with a bigger step
 * budget (services/kadeCharacterTurn.js). When it finishes, the result arrives
 * as the character's own message in the conversation where it was asked for,
 * and a push opens that conversation.
 *
 *   quote   the price before anything runs: about what a job like this costs
 *           and the most it can cost (the step ceiling bounds it). A start must
 *           carry the quote's id, so a price is always shown first.
 *   start   one running task per person; a daily cap per person.
 *   status / list / cancel.
 *
 * The runner lives in this process. Oct 17 2026: a deploy no longer cuts a job
 * off. On SIGTERM the server first waits for its running jobs (drain(),
 * registered in server/index.js to run BEFORE the HTTP server closes, because
 * the job's hidden turn runs over loopback) and refuses new starts meanwhile;
 * Railway's drain window (RAILWAY_DEPLOYMENT_DRAINING_SECONDS) bounds the
 * wait. The nightly restart waits too: the clock's restart route refuses while
 * busy() counts a job. A job still running when the window closes is marked
 * interrupted at once and the character says so in the conversation; the
 * 5-minute sweep catches anything a hard kill left behind. Nothing is retried
 * on its own, because a retry spends the person's money again.
 *
 * Kill switch: KADE_TASKS=0.
 */
'use strict';

const crypto = require('crypto');
const { logger } = require('@librechat/data-schemas');

const TASKS = 'kadetasks';
const QUOTES = 'kadetaskquotes';
const DEFAULT_STEPS = 20;
const MAX_STEPS = 40;
const PER_DAY = Number(process.env.KADE_TASKS_PER_DAY || 12);
/* A round re-reads the character's whole context; this is a working size, measured on the
 * main cast (head plus memory plus a few tool results), not a guess at the floor. */
const TOKENS_PER_ROUND = Number(process.env.KADE_TASK_TOKENS_PER_ROUND || 30000);
const OUTPUT_PER_ROUND = 600;
const QUOTE_MINUTES = 60;

/* Jobs running in THIS process (taskId -> promise that settles when the job is over), and
 * whether the process is shutting down. A start reserves its slot before its first await, so
 * a drain that begins mid-start still waits for it. */
const inflight = new Map();
let draining = false;
const DRAINING_ERROR =
  'the site is restarting for an update in the next few minutes, so a job started now would be cut off. ' +
  'The price still stands for an hour: ask them to say yes again in a few minutes';

function on() {
  return process.env.KADE_TASKS !== '0';
}

function coll(name) {
  return require('mongoose').connection.collection(name);
}

function db() {
  return require('~/models');
}

function money(usd) {
  if (usd < 0.01) return 'under a cent';
  if (usd < 1) return `about ${Math.max(1, Math.round(usd * 100))} cents`;
  return `about $${usd.toFixed(2)}`;
}

/** What the person may do: adults on their own seat. Children never learn they were turned away. */
async function personMayAsk(req) {
  const user = req && req.user;
  if (!user || !user.id) return { ok: false, why: 'not signed in' };
  if (req.kadeHiddenRun === true) return { ok: false, why: 'a background task cannot start another one' };
  const onBehalf = req.kadeOnBehalfOf && req.kadeOnBehalfOf.id;
  if (onBehalf && String(onBehalf) !== String(user.id)) return { ok: false, why: 'phone lane' };
  if (req.kadeOnBehalfOfUnresolved === true) return { ok: false, why: 'phone lane' };
  /* Oct 20 2026: read with kadeRealCost.PAYER_FIELDS so the quote is this account's own price
   * (factor 1 for a Family pack member). */
  const { PAYER_FIELDS } = require('~/server/services/kadeRealCost');
  const u = await db().getUserById(String(user.id), `kadeAccountType ${PAYER_FIELDS}`);
  if (u && u.kadeAccountType === 'child') return { ok: false, why: 'child', soft: true };
  return { ok: true, role: (u && u.role) || user.role, account: u || user };
}

/** Price of a job of `steps` rounds for this character, at the asker's price. */
async function priceFor({ agentId, steps, role, account }) {
  /* Only the model: a full agent record carries every saved version. */
  const agent = await require('mongoose').models.Agent.findOne({ id: String(agentId) }).select('model').lean();
  const model = agent && agent.model;
  const { platformFactor, userPriceFactor } = require('~/server/services/kadeRealCost');
  const factor = platformFactor();
  const per = (tokenType) => {
    try {
      const v = db().getMultiplier({ model, tokenType, endpoint: 'agents' });
      return Number.isFinite(v) ? v / factor : 0;
    } catch (_) {
      return 0;
    }
  };
  const inRate = per('prompt') || 0.5;
  const outRate = per('completion') || 1.5;
  const round = (TOKENS_PER_ROUND * inRate + OUTPUT_PER_ROUND * outRate) / 1e6;
  const priceFactor = userPriceFactor(account || role);
  const typical = round * Math.min(steps, 6) * priceFactor;
  const most = round * steps * priceFactor;
  return { typical, most, model };
}

async function quote({ req, agentId, goal, steps = DEFAULT_STEPS }) {
  if (!on()) return { ok: false, error: 'background tasks are switched off right now' };
  const who = await personMayAsk(req);
  if (!who.ok) return { ok: false, error: who.why, soft: who.soft };
  const s = Math.max(4, Math.min(MAX_STEPS, Math.round(Number(steps) || DEFAULT_STEPS)));
  const g = String(goal || '').trim();
  if (g.length < 8) return { ok: false, error: 'say the job in a full sentence first' };
  const { typical, most } = await priceFor({ agentId, steps: s, role: who.role, account: who.account });
  const quoteId = `q${crypto.randomBytes(6).toString('hex')}`;
  await coll(QUOTES).insertOne({
    quoteId,
    userId: String(req.user.id),
    agentId,
    goal: g.slice(0, 2000),
    steps: s,
    typicalUSD: typical,
    mostUSD: most,
    createdAt: new Date(),
  });
  return {
    ok: true,
    quoteId,
    steps: s,
    spoken: `A job like this usually costs ${money(typical)}, and ${money(most)} at the very most (that is the ceiling: ${s} rounds of work). Ask them before you start it.`,
  };
}

async function countToday(userId) {
  const since = new Date(Date.now() - 86400000);
  return coll(TASKS).countDocuments({ userId: String(userId), createdAt: { $gte: since } });
}

async function start({ req, agentId, agentName, quoteId, conversationId }) {
  if (!on()) return { ok: false, error: 'background tasks are switched off right now' };
  const who = await personMayAsk(req);
  if (!who.ok) return { ok: false, error: who.why, soft: who.soft };
  const userId = String(req.user.id);
  const q = await coll(QUOTES).findOne({ quoteId: String(quoteId || ''), userId, agentId });
  if (!q) return { ok: false, error: 'quote first: tell them the price, and start only after they say yes' };
  if (Date.now() - new Date(q.createdAt).getTime() > QUOTE_MINUTES * 60000) {
    return { ok: false, error: 'that price is over an hour old; quote again' };
  }
  if (q.usedAt) return { ok: false, error: 'that quote already started a task' };
  const running = await coll(TASKS).findOne({ userId, status: 'running' });
  if (running) return { ok: false, error: `one task at a time: "${running.title}" is still running` };
  if ((await countToday(userId)) >= PER_DAY) return { ok: false, error: `that is ${PER_DAY} tasks in a day; the next one can start tomorrow` };
  /* Checked last, with nothing awaited between the check and the reservation. The quote stays
   * unused, so the same price can start the job on the new server. */
  if (draining) return { ok: false, error: DRAINING_ERROR, draining: true };
  const taskId = `t${crypto.randomBytes(6).toString('hex')}`;
  let release;
  inflight.set(
    taskId,
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const done = () => {
    inflight.delete(taskId);
    release();
  };
  try {
    await coll(QUOTES).updateOne({ _id: q._id }, { $set: { usedAt: new Date() } });
  } catch (e) {
    done();
    throw e;
  }
  const title = q.goal.length > 80 ? `${q.goal.slice(0, 77).replace(/\s+\S*$/, '')}…` : q.goal;
  const convo = conversationId && conversationId !== 'new' ? String(conversationId) : null;
  const task = {
    taskId,
    userId,
    agentId,
    agentName: agentName || '',
    goal: q.goal,
    title,
    steps: q.steps,
    quotedTypicalUSD: q.typicalUSD,
    quotedMostUSD: q.mostUSD,
    conversationId: convo,
    timezone: req.body && typeof req.body.timezone === 'string' ? req.body.timezone : undefined,
    status: 'running',
    createdAt: new Date(),
    bootId: BOOT_ID,
  };
  try {
    await coll(TASKS).insertOne(task);
  } catch (e) {
    done();
    throw e;
  }
  setImmediate(() => {
    run(task)
      .catch((e) => logger.error('[kadeTasks] runner crashed: ' + (e && e.message)))
      .finally(done);
  });
  return { ok: true, taskId, title, steps: q.steps };
}

/** What the person was charged for the hidden turn (credits are millionths of a dollar). */
async function chargedUSD(userId, conversationId) {
  try {
    const rows = await coll('transactions')
      .find({ user: require('mongoose').Types.ObjectId.createFromHexString(String(userId)), conversationId: String(conversationId) })
      .project({ tokenValue: 1 })
      .toArray();
    return rows.reduce((sum, r) => sum + Math.abs(Number(r.tokenValue) || 0), 0) / 1e6;
  } catch (_) {
    return null;
  }
}

async function run(task) {
  const { speakFirst } = require('~/server/services/kadeCharacterTurn');
  const started = new Date(task.createdAt).toISOString();
  const note =
    `BACKGROUND JOB you said you would take on for them, started ${started}. The job: ${task.goal}\n` +
    `Do it now. Use your tools as many times as it takes (you have up to ${task.steps} rounds), check what you find, then write the message ` +
    'you are sending them with the results. Say plainly what you found, how you know it, and what you could not find. If a choice is theirs to make, ask it in the message. ' +
    'Keep it easy to listen to: plain sentences, no tables, links written out only when they matter.';
  const stream = { id: null };
  const stopWatch = watchCancel(task, stream);
  try {
    const out = await speakFirst({
      userId: task.userId,
      agentId: task.agentId,
      note,
      conversationId: task.conversationId || undefined,
      kind: 'task',
      requested: true,
      steps: task.steps,
      timezone: task.timezone,
      /* About 25 seconds a round, never past 15 minutes (the default 4 minutes cut real jobs short). */
      timeoutMs: Math.min(15 * 60000, 60000 + task.steps * 25000),
      onStart: ({ streamId }) => {
        stream.id = streamId;
        return coll(TASKS).updateOne({ taskId: task.taskId }, { $set: { streamId } });
      },
      /* A cancelled task never posts what it had so far. */
      /* Done the moment the answer is in the conversation, before the push. */
      onPosted: (placed, composed) =>
        coll(TASKS).updateOne(
          { taskId: task.taskId },
          {
            $set: {
              status: 'done',
              finishedAt: new Date(),
              conversationId: placed.conversationId,
              messageId: placed.messageId,
              toolCalls: composed.toolCalls,
              preview: String(composed.text || '').replace(/%%%[^%\n]{0,160}%%%/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300),
            },
          },
        ),
      /* Also held back once a shutdown gave up on it: the person was already told. */
      beforePost: async () => {
        const now = await coll(TASKS).findOne({ taskId: task.taskId });
        return !!(now && now.status === 'running');
      },
    });
    if (out.posted === false) {
      await coll(TASKS).updateOne(
        { taskId: task.taskId, status: 'cancel-requested' },
        { $set: { status: 'cancelled', finishedAt: new Date(), chargedUSD: await chargedUSD(task.userId, out.composeConversationId) } },
      );
      return;
    }
    await coll(TASKS).updateOne(
      { taskId: task.taskId },
      {
        $set: {
          status: 'done',
          finishedAt: new Date(),
          conversationId: out.conversationId,
          messageId: out.messageId,
          toolCalls: out.toolCalls,
          preview: String(out.text || '').replace(/%%%[^%\n]{0,160}%%%/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300),
          chargedUSD: out.composeConversationId ? await chargedUSD(task.userId, out.composeConversationId) : null,
        },
      },
    );
  } catch (e) {
    const why = String((e && e.message) || e).slice(0, 300);
    logger.warn(`[kadeTasks] ${task.taskId} failed: ${why}`);
    /* A stopped job ends quietly (stopping it is what broke the turn); only a job still running
     * is called failed, never one a shutdown already gave up on and explained. */
    const stopped = await coll(TASKS).updateOne(
      { taskId: task.taskId, status: 'cancel-requested' },
      { $set: { status: 'cancelled', finishedAt: new Date(), error: why } },
    );
    if (stopped.modifiedCount) return;
    const r = await coll(TASKS).updateOne(
      { taskId: task.taskId, status: 'running' },
      { $set: { status: 'failed', finishedAt: new Date(), error: why } },
    );
    if (r.modifiedCount) {
      await tellFailure(task, 'I could not finish it this time.').catch(() => {});
    }
  } finally {
    stopWatch();
  }
}

/** A plain message from the character when work did not finish (no model call). */
async function tellFailure(task, sentence) {
  const { post, notifyPost } = require('~/server/services/kadeCharacterTurn');
  const text = `${sentence} The job was: ${task.title}. Nothing more was charged after it stopped. Say the word and I will try again.`;
  const placed = await post({ userId: task.userId, agentId: task.agentId, text, conversationId: task.conversationId || undefined, kind: 'task-failed' });
  await notifyPost({ userId: task.userId, agentId: task.agentId, agentName: task.agentName, text, conversationId: placed.conversationId, requested: true });
}

async function list({ userId, limit = 10 }) {
  const rows = await coll(TASKS)
    .find({ userId: String(userId) })
    .sort({ createdAt: -1 })
    .limit(Math.min(50, limit))
    .toArray();
  return rows.map((t) => ({
    taskId: t.taskId,
    agentId: t.agentId,
    agentName: t.agentName,
    title: t.title,
    status: t.status,
    createdAt: t.createdAt,
    finishedAt: t.finishedAt || null,
    conversationId: t.conversationId || null,
    preview: t.preview || '',
    error: t.error || '',
    quotedMostUSD: t.quotedMostUSD,
    chargedUSD: t.chargedUSD ?? null,
  }));
}

async function cancel({ userId, taskId }) {
  const t = await coll(TASKS).findOne({ userId: String(userId), taskId: String(taskId || '') });
  if (!t) return { ok: false, error: 'no such task' };
  if (t.status !== 'running') return { ok: false, error: `it is already ${t.status}` };
  await coll(TASKS).updateOne({ _id: t._id }, { $set: { status: 'cancel-requested', cancelRequestedAt: new Date() } });
  /* Stop the hidden turn itself, through the site's own abort, as the person. When the job runs
   * on another server (a deploy's old one, still finishing), its own watcher does this. */
  if (t.streamId && inflight.has(t.taskId)) {
    abortedHere.add(t.streamId);
    await abortStream(userId, t.streamId);
  }
  return { ok: true, note: 'Stopped. What already ran is still charged, and nothing is posted.' };
}

const abortedHere = new Set();

async function abortStream(userId, streamId) {
  try {
    const user = await db().getUserById(String(userId), '_id username email provider role');
    const token = await db().generateToken(user, 5 * 60 * 1000);
    await fetch(`http://127.0.0.1:${process.env.PORT || 3080}/api/agents/chat/abort`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({ streamId }),
    });
  } catch (e) {
    logger.warn('[kadeTasks] abort call failed (the result will still be held back): ' + e.message);
  }
}

/* Oct 17 2026: during a deploy the old server finishes its jobs while the person's taps reach the
 * new one, so a Stop can land on a server that is not running the job. The server that is
 * running it looks every 15 seconds and stops its own hidden turn. */
const CANCEL_LOOK_MS = Number(process.env.KADE_TASK_CANCEL_LOOK_MS || 15000);

function watchCancel(task, stream) {
  let busyLooking = false;
  const timer = setInterval(async () => {
    if (busyLooking || !stream.id || abortedHere.has(stream.id)) return;
    busyLooking = true;
    try {
      const now = await coll(TASKS).findOne({ taskId: task.taskId }, { projection: { status: 1 } });
      if (now && now.status === 'cancel-requested' && !abortedHere.has(stream.id)) {
        abortedHere.add(stream.id);
        logger.info(
          `[kadeTasks] ${task.taskId} was stopped from another server; stopping its turn here`,
        );
        await abortStream(task.userId, stream.id);
      }
    } catch (_) {
      /* the next look tries again */
    } finally {
      busyLooking = false;
    }
  }, CANCEL_LOOK_MS);
  if (timer.unref) timer.unref();
  return () => {
    clearInterval(timer);
    if (stream.id) abortedHere.delete(stream.id);
  };
}

/* How long a shutdown waits for running jobs: Railway's drain window less 45 seconds for the HTTP
 * close and the "lost my place" note. Without a window set, the longest a job can run. */
function drainBudgetMs() {
  const explicit = process.env.KADE_TASK_DRAIN_MS;
  if (explicit !== undefined && explicit !== '' && Number.isFinite(Number(explicit))) {
    return Math.max(0, Number(explicit));
  }
  const railway = Number(process.env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS);
  if (Number.isFinite(railway) && railway > 0) return Math.max(5000, railway * 1000 - 45000);
  return 17.5 * 60000;
}

/** A job the shutdown could not wait for: say so now instead of 20 minutes later. */
async function giveUp(taskId) {
  const t = await coll(TASKS).findOne({ taskId });
  if (!t) return;
  const r = await coll(TASKS).updateOne(
    { taskId, status: { $in: ['running', 'cancel-requested'] } },
    { $set: { status: 'interrupted', finishedAt: new Date(), interruptedBy: 'shutdown' } },
  );
  if (r.modifiedCount && t.status === 'running') {
    await tellFailure(t, 'The site restarted while I was working on your job, so I lost my place.');
  }
}

/**
 * Shutdown: refuse new jobs and wait for this server's running ones, up to the drain budget.
 * Registered as a drain task (server/index.js), so it runs while the HTTP server still listens.
 */
async function drain({ budgetMs = drainBudgetMs() } = {}) {
  draining = true;
  if (!inflight.size) return { waitedMs: 0, cutOff: 0 };
  const t0 = Date.now();
  logger.info(
    `[kadeTasks] shutting down: waiting up to ${Math.round(budgetMs / 1000)} s for ${inflight.size} background task(s) ` +
      `(${[...inflight.keys()].join(', ')}); new starts are refused`,
  );
  let timer;
  await Promise.race([
    Promise.allSettled([...inflight.values()]),
    new Promise((resolve) => {
      timer = setTimeout(resolve, budgetMs);
    }),
  ]);
  clearTimeout(timer);
  const left = [...inflight.keys()];
  for (const taskId of left) {
    let cap;
    await Promise.race([
      giveUp(taskId).catch((e) =>
        logger.warn(`[kadeTasks] ${taskId} not marked interrupted: ${e.message}`),
      ),
      new Promise((resolve) => {
        cap = setTimeout(resolve, 20000);
      }),
    ]);
    clearTimeout(cap);
  }
  const waitedMs = Date.now() - t0;
  logger.info(
    `[kadeTasks] shutdown wait over after ${Math.round(waitedMs / 1000)} s: ` +
      (left.length ? `${left.length} task(s) cut off and told` : 'every task finished'),
  );
  return { waitedMs, cutOff: left.length };
}

/** What a restart would cut off right now: jobs running here, and fresh running jobs anywhere. */
async function busy() {
  let fresh = null;
  try {
    fresh = await coll(TASKS).countDocuments({
      status: { $in: ['running', 'cancel-requested'] },
      createdAt: { $gte: new Date(Date.now() - LOST_AFTER_MS) },
    });
  } catch (_) {
    /* the database not answering is no reason to hold a restart for this server's own count */
  }
  return {
    here: inflight.size,
    running: Math.max(fresh || 0, inflight.size),
    draining,
    dbCounted: fresh !== null,
  };
}

/** The nightly restart holds new starts just before it exits (and lets go if it backs out). */
function holdStarts(on) {
  draining = on === true;
}

function runningHere() {
  return inflight.size;
}

/* Each process start has its own id (recorded on the task, for the logs). */
const BOOT_ID = crypto.randomBytes(6).toString('hex');
/* No task outlives this: the work limit is 15 minutes. A task still "running" after it was cut
 * off by a restart or a deploy. Age, never the boot id, decides: during a deploy the old server
 * keeps working for a while, and a new server that called those tasks lost would post a false
 * failure next to a real answer. */
const LOST_AFTER_MS = 20 * 60000;

async function sweepInterrupted() {
  try {
    const lost = await coll(TASKS)
      .find({ status: { $in: ['running', 'cancel-requested'] }, createdAt: { $lt: new Date(Date.now() - LOST_AFTER_MS) } })
      .toArray();
    for (const t of lost) {
      const r = await coll(TASKS).updateOne(
        { _id: t._id, status: t.status },
        { $set: { status: 'interrupted', finishedAt: new Date() } },
      );
      if (r.modifiedCount && t.status === 'running') {
        await tellFailure(t, 'The site restarted while I was working on your job, so I lost my place.').catch(() => {});
      }
    }
    if (lost.length) logger.info(`[kadeTasks] marked ${lost.length} task(s) interrupted by a restart`);
  } catch (e) {
    logger.warn('[kadeTasks] interrupted sweep skipped: ' + e.message);
  }
}

/** Check every five minutes (started from server boot). */
function startTaskSweep() {
  const timer = setInterval(() => {
    sweepInterrupted().catch(() => {});
  }, 5 * 60000);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  quote,
  start,
  list,
  cancel,
  sweepInterrupted,
  startTaskSweep,
  priceFor,
  money,
  personMayAsk,
  drain,
  drainBudgetMs,
  busy,
  holdStarts,
  runningHere,
};
