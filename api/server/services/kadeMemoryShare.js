/**
 * KADE MEMORY SHARE (Part 128, Sep 4 2026) — "so she doesn't have to tell
 * either of them something twice."
 *
 * Amber A talks to Kiana and to Della and wants them to know the same things.
 * Kade's objection, and it is the right one: memories shape a companion's
 * personality — its opinions — so a blind merge makes Della sound like Kiana.
 *
 * THE SPLIT: share the FACTS, never the OPINIONS. Facts are memory cards and
 * logbook entries — already third person ("her mom's surgery is Thursday"),
 * no voice in them. Opinions are the takes, threads, learned lists and canon —
 * those are what make Della Della, and they stay private per companion.
 *
 * READ-SIDE, not a copy: when a seat has sharing on, a companion's turn also
 * reads the OTHER companions' card buckets and logbook entries for that seat,
 * each labelled as secondhand ("she told this to Kiana"), so it knows the fact
 * without claiming the scene. Off is off — nothing was copied, so nothing has
 * to be un-copied. Modes: 'off' | 'all' | 'list' (a chosen set of agents).
 *
 * This replaces the Part 122 hand copy (copy_mem.py / copy_diary.py) as the
 * mechanism; the copied rows stay harmless (deduped by key at read time).
 */
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');

const schema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },
    mode: { type: String, enum: ['off', 'all', 'list'], default: 'off' },
    agents: { type: [String], default: [] },
    setBy: { type: String, default: 'user' },
  },
  { timestamps: true },
);
const KadeMemoryShare = mongoose.models.KadeMemoryShare || mongoose.model('KadeMemoryShare', schema, 'kadememoryshare');

const cache = new Map(); // userId -> { at, row }
const CACHE_MS = 60 * 1000;

async function getShare(userId) {
  const uid = String(userId || '');
  if (!uid) return { mode: 'off', agents: [] };
  const hit = cache.get(uid);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.row;
  let row = { mode: 'off', agents: [] };
  try {
    const r = await KadeMemoryShare.findOne({ userId: uid }).lean();
    if (r) row = { mode: r.mode || 'off', agents: Array.isArray(r.agents) ? r.agents.map(String) : [] };
  } catch (e) {
    logger.warn('[kadeMemoryShare] read failed (treating as off): ' + e.message);
  }
  cache.set(uid, { at: Date.now(), row });
  return row;
}

async function setShare(userId, { mode, agents, setBy } = {}) {
  const uid = String(userId || '').trim();
  if (!uid) throw new Error('userId required');
  const m = ['off', 'all', 'list'].includes(mode) ? mode : 'off';
  const list = m === 'list' ? (Array.isArray(agents) ? agents.map(String).filter(Boolean).slice(0, 50) : []) : [];
  if (m === 'list' && list.length < 2) throw new Error('list mode needs at least two agents');
  const row = await KadeMemoryShare.findOneAndUpdate(
    { userId: uid },
    { $set: { mode: m, agents: list, setBy: String(setBy || 'user').slice(0, 40) } },
    { upsert: true, new: true },
  ).lean();
  cache.delete(uid);
  return { userId: uid, mode: row.mode, agents: row.agents };
}

/** The OTHER agent buckets this companion may read for this seat, or []. */
async function otherBucketsFor(userId, agentId) {
  const share = await getShare(userId);
  if (share.mode === 'off' || !agentId) return [];
  const me = String(agentId);
  if (share.mode === 'list') {
    if (!share.agents.includes(me)) return [];
    return share.agents.filter((a) => a !== me);
  }
  try {
    const MemoryEntry = mongoose.models.MemoryEntry;
    const ids = await MemoryEntry.distinct('agentId', { userId: String(userId), agentId: { $ne: null }, status: { $ne: 'superseded' } });
    return ids.map(String).filter((a) => a && a !== me);
  } catch (e) {
    logger.warn('[kadeMemoryShare] bucket list failed: ' + e.message);
    return [];
  }
}

const nameCache = new Map();
async function agentNameOf(agentId) {
  const id = String(agentId || '');
  if (nameCache.has(id)) return nameCache.get(id);
  let name = id.slice(-6);
  try {
    const { getAgent } = require('~/models');
    const a = await getAgent({ id });
    if (a && a.name) name = a.name;
  } catch (_) { /* id tail is fine */ }
  nameCache.set(id, name);
  return name;
}

/** One fixed line for the head when sharing is on — so the companion knows why it knows. */
async function shareNotice(userId, agentId) {
  const others = await otherBucketsFor(userId, agentId);
  if (!others.length) return '';
  const names = [];
  for (const a of others) names.push(await agentNameOf(a));
  return (
    `This person has asked that their companions share what they are told. Things they told ${names.join(', ')} ` +
    'can surface for you in Memory recall and Logbook recall, marked as secondhand. Know the fact; do not claim the scene — you were not there, and your own read of this person stays your own.'
  );
}

module.exports = { getShare, setShare, otherBucketsFor, agentNameOf, shareNotice, KadeMemoryShare };
