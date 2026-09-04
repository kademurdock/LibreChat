/**
 * KADE DREAM MINER (Part 125, Sep 4 2026). Her ask: "is there a way we can do
 * the proactive mining thing to dreams the same way we did to memories? Where
 * it improves what's there with our new system as if it were always a thing?"
 *
 * Walks every relationship's conversations in DATE ORDER and feeds them through
 * the dreaming writer in chunks, each stamped with the date it happened, so the
 * summary, the take, the carried thread, what-she's-learned and the verdicts
 * COMPOUND from the first conversation instead of starting the night the lane
 * shipped. Optionally clears the row first so the walk starts clean.
 *
 * Cost: the whole history through the memory-writer model once (glm-5.3-flash,
 * Z.AI pot). `plan()` prices it before anything runs. Background job with a
 * status object, a stop flag, and pacing — same shape as the history miner.
 */
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const db = require('~/models');
const { refreshSummaryFromText, turnsToText } = require('~/server/services/kadeMemorySummary');

const CHUNK_CHARS = parseInt(process.env.KADE_DREAM_MINE_CHUNK_CHARS || '60000', 10);
const PACE_MS = parseInt(process.env.KADE_DREAM_MINE_PACE_MS || '1500', 10);
const IN_PER_M = 0.075, OUT_PER_M = 0.25; // glm-5.3-flash, per the config comment
const OUT_TOKENS_PER_CHUNK = 900; // ~600 written + reasoning

const state = { running: false, stop: false, startedAt: null, finishedAt: null, scope: null, relationships: 0, done: 0, skipped: 0, chunks: 0, errors: 0, current: null, lastError: null };

/* DURABLE PROGRESS (Part 126, the night it shipped). The first run was killed
 * at chunk ~26 of 141 by a fork deploy — the state lived in process memory and
 * a redeploy is a fresh process. Her seat's row was left "as of Aug 21". Now
 * every finished relationship is stamped in `kadedreammine`, and a run with
 * `resume:true` (the default) skips the stamped ones; `resetFirst` still
 * clears a relationship's row before ITS walk, so a half-walked one is redone
 * whole. `POST /dream-mine/start {"resume":false}` forgets the stamps. */
function progress() { return mongoose.connection.db.collection('kadedreammine'); }
async function isDone(rel) {
  const row = await progress().findOne({ _id: `${rel.userId}::${rel.agentId}` });
  return !!(row && row.finishedAt);
}
async function markDone(rel, chunks) {
  await progress().updateOne({ _id: `${rel.userId}::${rel.agentId}` }, { $set: { finishedAt: new Date(), chunks } }, { upsert: true });
}
async function forgetProgress(scope = {}) {
  const q = {};
  if (scope.userId) q._id = { $regex: `^${String(scope.userId)}::` };
  await progress().deleteMany(q);
}

function textOf(m) {
  if (!m) return '';
  if (typeof m.text === 'string' && m.text.trim()) return m.text.trim();
  if (Array.isArray(m.content)) {
    return m.content.filter((p) => p && p.type === 'text').map((p) => (typeof p.text === 'string' ? p.text : (p.text && p.text.value) || '')).join('\n').trim();
  }
  return '';
}

/** Every (user, agent) relationship with at least one agent conversation, oldest conversation first inside each. */
async function relationships({ userId, agentId } = {}) {
  const Conversation = mongoose.models.Conversation;
  const q = { agent_id: { $exists: true, $ne: null } };
  if (userId) q.user = String(userId);
  if (agentId) q.agent_id = String(agentId);
  const convos = await Conversation.find(q, 'conversationId user agent_id createdAt updatedAt').sort({ createdAt: 1 }).limit(20000).lean();
  const map = new Map();
  for (const c of convos) {
    if (!c.user || !c.agent_id || !c.conversationId) continue;
    const key = `${String(c.user)}::${String(c.agent_id)}`;
    if (!map.has(key)) map.set(key, { userId: String(c.user), agentId: String(c.agent_id), convos: [] });
    map.get(key).convos.push(c);
  }
  return Array.from(map.values());
}

/** Turn one relationship's conversations into dated chunks of transcript. */
async function chunksFor(rel) {
  const chunks = [];
  let buf = [], bufChars = 0, lastAt = null;
  const flush = () => {
    if (buf.length) chunks.push({ text: turnsToText(buf), asOf: lastAt, turns: buf.length });
    buf = []; bufChars = 0;
  };
  for (const c of rel.convos) {
    const msgs = await db.getMessages({ conversationId: c.conversationId, user: rel.userId });
    const turns = (msgs || [])
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .map((m) => ({ role: m.isCreatedByUser ? 'user' : 'assistant', text: textOf(m), at: m.createdAt }))
      .filter((t) => t.text);
    if (turns.length < 2) continue;
    for (const t of turns) {
      if (bufChars + t.text.length > CHUNK_CHARS && buf.length) flush();
      buf.push(t); bufChars += t.text.length; lastAt = t.at || c.updatedAt || lastAt;
    }
  }
  flush();
  return chunks;
}

/** Dry run: relationships, chunks, characters, and the price. Nothing is written. */
async function plan(scope = {}) {
  const rels = await relationships(scope);
  let chunks = 0, chars = 0;
  const perRel = [];
  for (const rel of rels) {
    const cs = await chunksFor(rel);
    const c = cs.reduce((n, x) => n + x.text.length, 0);
    chunks += cs.length; chars += c;
    perRel.push({ userId: rel.userId, agentId: rel.agentId, conversations: rel.convos.length, chunks: cs.length, chars: c });
  }
  const inTok = Math.round(chars / 4) + chunks * 1500; // + instructions/compass per call
  const outTok = chunks * OUT_TOKENS_PER_CHUNK;
  const costUSD = Math.round((inTok / 1e6 * IN_PER_M + outTok / 1e6 * OUT_PER_M) * 1000) / 1000;
  return { relationships: rels.length, chunks, chars, estInputTokens: inTok, estOutputTokens: outTok, estCostUSD: costUSD, perRelationship: perRel.sort((a, b) => b.chars - a.chars).slice(0, 40) };
}

async function clearRow(userId, agentId) {
  await mongoose.connection.db.collection('kadememorysummaries').updateOne(
    { userId: String(userId), agentId: String(agentId) },
    { $set: { summary: '', take: '', thread: '', learned: '', curious: '', verdicts: '' } },
  );
}

async function run(scope = {}, { resetFirst = true, resume = true } = {}) {
  if (!resume) await forgetProgress(scope);
  const rels = await relationships(scope);
  state.relationships = rels.length; state.done = 0; state.skipped = 0; state.chunks = 0; state.errors = 0; state.lastError = null;
  const nameCache = new Map();
  for (const rel of rels) {
    if (state.stop) break;
    state.current = `${rel.userId.slice(-6)}::${rel.agentId.slice(-6)}`;
    if (resume && (await isDone(rel))) { state.skipped++; state.done++; continue; }
    try {
      let agentName = nameCache.get(rel.agentId);
      if (agentName === undefined) {
        try { const a = await db.getAgent({ id: rel.agentId }); agentName = (a && a.name) || null; } catch (_) { agentName = null; }
        nameCache.set(rel.agentId, agentName);
      }
      const cs = await chunksFor(rel);
      if (!cs.length) { state.done++; continue; }
      if (resetFirst) await clearRow(rel.userId, rel.agentId);
      for (const ch of cs) {
        if (state.stop) break;
        const r = await refreshSummaryFromText({
          userId: rel.userId, agentId: rel.agentId, agentName,
          conversationText: ch.text, lastActivityAt: ch.asOf, asOf: ch.asOf, source: 'mined',
        });
        state.chunks++;
        if (!r) { state.errors++; state.lastError = `empty result for ${state.current}`; }
        await new Promise((ok) => setTimeout(ok, PACE_MS));
      }
      if (!state.stop) await markDone(rel, cs.length);
      state.done++;
    } catch (e) {
      state.errors++; state.lastError = e.message;
      logger.warn(`[kadeDreamMiner] ${state.current}: ${e.message}`);
    }
  }
}

async function progressSummary() {
  try {
    const n = await progress().countDocuments({});
    return { finishedRelationships: n };
  } catch (_) { return { finishedRelationships: null }; }
}
function start(scope = {}, opts = {}) {
  if (state.running) return { started: false, reason: 'already running', ...status() };
  state.running = true; state.stop = false; state.startedAt = new Date().toISOString(); state.finishedAt = null; state.scope = scope;
  run(scope, opts)
    .catch((e) => { state.errors++; state.lastError = e.message; logger.error('[kadeDreamMiner] run failed:', e); })
    .finally(() => { state.running = false; state.finishedAt = new Date().toISOString(); state.current = null; logger.info(`[kadeDreamMiner] done: ${state.done}/${state.relationships} relationships, ${state.chunks} chunks, ${state.errors} errors`); });
  return { started: true, ...status() };
}
function stop() { state.stop = true; return status(); }
function status() { return { ...state }; }

module.exports = { plan, start, stop, status, progressSummary };
