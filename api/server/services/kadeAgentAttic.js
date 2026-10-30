/**
 * KADE AGENT ATTIC (Oct 29 2026): tuck characters away without unpublishing or deleting them.
 *
 * Kade's yes, Oct 29 2026, on the cleanup plan: about 200 marketplace characters were made in
 * bulk in June and July and never had one conversation, and they fill some fifty category
 * sections in every picker. Unpublishing would not tidy her own picker (she owns them) and
 * would break other people's old chats; deleting cannot be undone. The attic hides a character
 * from every list the server serves (the chat picker and Marketplace, the Agent Builder list,
 * Matchmaker, the Debate Room cast list and Clubhouse guests), for everyone, Kade included.
 * Nothing else changes: GET /api/agents/:id still answers, so an old chat with an attic
 * character still opens and still gets replies, and taking it out of the attic brings it back
 * exactly as it was.
 *
 * Storage: Mongo collection `kadeagentattic`, one document per agent id
 * ({ _id: agentId, agentId, name, at, by, note }). The attic set is cached for a minute.
 * If the attic cannot be read, nothing is hidden (fail open: a lookup error must never empty a
 * picker).
 *
 * Kill switch: KADE_AGENT_ATTIC=0 shows everything again without touching the data.
 */
'use strict';

const COLL = 'kadeagentattic';
const MEMO_MS = 60 * 1000;
const AGENT_ID = /^agent_[A-Za-z0-9_-]{6,64}$/;
const MAX_PER_CALL = 500;

let memo = { at: 0, ids: null };

function on() {
  return process.env.KADE_AGENT_ATTIC !== '0';
}

function coll() {
  return require('mongoose').connection.collection(COLL);
}

function validAgentId(id) {
  return typeof id === 'string' && AGENT_ID.test(id);
}

function forget() {
  memo = { at: 0, ids: null };
}

/** The set of agent ids in the attic (empty when switched off or unreadable). */
async function atticIds() {
  if (!on()) return new Set();
  if (memo.ids && Date.now() - memo.at < MEMO_MS) return memo.ids;
  try {
    const rows = await coll().find({}, { projection: { _id: 1 } }).toArray();
    memo = { at: Date.now(), ids: new Set(rows.map((r) => String(r._id))) };
    return memo.ids;
  } catch (error) {
    try {
      require('@librechat/data-schemas').logger.warn('[kadeAgentAttic] read failed: ' + error.message);
    } catch (_) {
      /* logging is best effort */
    }
    return new Set();
  }
}

async function isInAttic(agentId) {
  if (!agentId) return false;
  return (await atticIds()).has(String(agentId));
}

/** Drop attic characters from a list of agent docs (or anything with an `id`). */
async function withoutAttic(agents) {
  const attic = await atticIds();
  if (!attic.size) return agents;
  return agents.filter((a) => !(a && attic.has(String(a.id))));
}

/**
 * Put agents into the attic (attic=true) or take them out (attic=false).
 * Returns { changed, skipped } where skipped lists ids that were not valid agent ids.
 */
async function setAttic(agentIds, attic, { by = 'admin', note = '', names = {} } = {}) {
  const ids = [...new Set((Array.isArray(agentIds) ? agentIds : []).map(String))];
  const valid = ids.filter(validAgentId).slice(0, MAX_PER_CALL);
  const skipped = ids.filter((id) => !validAgentId(id));
  if (!valid.length) return { changed: 0, skipped };
  let changed = 0;
  if (attic) {
    const at = new Date();
    const ops = valid.map((id) => ({
      updateOne: {
        filter: { _id: id },
        update: {
          $setOnInsert: { agentId: id, at },
          $set: {
            by: String(by).slice(0, 80),
            note: String(note).slice(0, 200),
            ...(names[id] ? { name: String(names[id]).slice(0, 80) } : {}),
          },
        },
        upsert: true,
      },
    }));
    const out = await coll().bulkWrite(ops, { ordered: false });
    changed = (out.upsertedCount || 0) + (out.modifiedCount || 0);
  } else {
    const out = await coll().deleteMany({ _id: { $in: valid } });
    changed = out.deletedCount || 0;
  }
  forget();
  return { changed, skipped };
}

async function listAttic() {
  return coll().find({}).sort({ at: -1 }).toArray();
}

module.exports = {
  COLL,
  atticIds,
  isInAttic,
  withoutAttic,
  setAttic,
  listAttic,
  validAgentId,
  _forget: forget,
};
