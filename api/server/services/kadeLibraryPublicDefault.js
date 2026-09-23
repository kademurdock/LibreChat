'use strict';
/* ── PUBLIC BY DEFAULT (Part 272, Sep 23 2026) ─────────────────────────────
 * Kade: "Make everything I personally upload public unless I say it's private.
 * I'll go back and mark what I want private."
 *
 * Every upload route already shares the librarian's own upload unless it says
 * private. TubeVault's Archive workflow queue said private every time (up to
 * 1.32), so 191 of her uploads sat on her own shelf without her knowing. This
 * shares them, once, on a start where the switches below are set:
 *
 *   KADE_LIBRARY_PUBLIC_OWNER             her user id
 *   KADE_LIBRARY_PUBLIC_BEFORE            ISO time: all her private items created before it
 *   KADE_LIBRARY_PUBLIC_TUBEVAULT_BEFORE  ISO time: only Archive workflow uploads
 *                                         (originalPath tubevault-intake/...) created before it,
 *                                         for the ones an older TubeVault sent after the first run
 *
 * Every item it shares is marked meta.publicByDefault, and an item carrying
 * that mark is never touched again: whatever she makes private afterwards
 * stays private even if a switch is left set. Only ready items (sharing needs
 * a recording). Nothing is moved or deleted, and grown-ups-only is left as it is.
 */

const isId = (s) => /^[a-f0-9]{24}$/i.test(String(s || ''));
const when = (v) => {
  const d = new Date(String(v || '').trim());
  return String(v || '').trim() && !Number.isNaN(d.getTime()) ? d : null;
};

/** The queries a start would run; none when the owner switch is missing or malformed. */
function filters(env = process.env) {
  const owner = String(env.KADE_LIBRARY_PUBLIC_OWNER || '').trim();
  if (!isId(owner)) return [];
  const base = { owner, shared: false, state: 'ready', 'meta.publicByDefault': { $exists: false } };
  const out = [];
  const all = when(env.KADE_LIBRARY_PUBLIC_BEFORE);
  if (all) out.push({ ...base, createdAt: { $lt: all } });
  const lane = when(env.KADE_LIBRARY_PUBLIC_TUBEVAULT_BEFORE);
  if (lane) out.push({ ...base, originalPath: /^tubevault-intake\//, createdAt: { $lt: lane } });
  return out;
}

async function shareOnce({ env = process.env, Model, log } = {}) {
  const list = filters(env);
  if (!list.length) return null;
  Model = Model || require('~/models/kadeBook').KadeBook;
  log = log || require('@librechat/data-schemas').logger;
  const at = new Date();
  let shared = 0;
  const examples = [];
  for (const q of list) {
    // A null meta cannot take a field; give those an empty one first.
    await Model.updateMany({ ...q, meta: null }, { $set: { meta: {} } });
    const sample = await Model.find(q, '_id title').limit(5).lean();
    const r = await Model.updateMany(q, { $set: { shared: true, sharedAt: at, 'meta.publicByDefault': at } });
    shared += r.modifiedCount || 0;
    examples.push(...sample.map((s) => s.title));
  }
  log.info(`[library/public-default] shared ${shared} of her private uploads${examples.length ? '; e.g. ' + examples.slice(0, 5).join(' | ') : ''}`);
  return { shared };
}

function start() {
  if (!filters().length) return;
  const t = setTimeout(() => {
    shareOnce().catch((e) => require('@librechat/data-schemas').logger.warn(`[library/public-default] ${e.message}`));
  }, 60 * 1000);
  if (t.unref) t.unref();
}

module.exports = { filters, shareOnce, start };
