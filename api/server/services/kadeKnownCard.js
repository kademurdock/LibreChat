/**
 * WHAT I KNOW ABOUT YOU (Nov 11 2026, card 8 of the home agent plan).
 *
 * A person can hear what a character knows about them, fix it, and have it forgotten:
 *   count          counts by group first ("six things you told me, one from an errand"), because a
 *                  full read-back is long by ear.
 *   read           one group: told, errand, mail, others (facts about someone else), or all.
 *   correct        "you remember that wrong": the card is rewritten as the person's own correction
 *                  (locked, so the keeper cannot write the old belief back), and the old wording is
 *                  tombstoned.
 *   forget         one fact: deleted in code, with its trail, its summaries marked for rewrite, its
 *                  card-check marks, and any moment or logbook line carrying it. A tombstone stops
 *                  every writer from bringing it back (services/kadeKnownTombstones.js). The tool
 *                  answer reads back what was forgotten.
 *   forget_source  everything from one source ("forget everything from my mail"). One command.
 *   forget_all     everything this character knows about them. Asks first: the count is said, and
 *                  only a plain yes in the person's NEXT message does it.
 *
 * WHAT IT READS: the person's memory cards this character can see, which is the shared bucket plus
 * the character's own (the same scoping every card read uses). Reminder cards are not facts and are
 * left out. Each card has a source tag (knownSource: told, errand, mail; a card with none was told)
 * and an about-someone-else tag (aboutOther; on older cards it is read from the card's key or
 * subject naming a relative or friend).
 *
 * THE SIZE: about 2,000 characters a person is a SOFT target, reported in every count ("over":
 * true). Kade has not decided the cap, so nothing is ever deleted to meet it.
 *
 * WHO MAY ASK: the signed-in app or website only. A phone call, a paired phone, a hidden
 * background run and an unknown caller are refused before anything is read (plan section 4:
 * "Signed-in voice or the app only"; card 3: a paired phone never hears memory). The lane comes
 * from kadeLaneTrustAdapter.js, which uses the safety lane's laneTrust when it exists.
 *
 * Off: KADE_KNOWN_CARD=0 (the tool is not offered and refuses).
 * No '~' requires at load time, so node --test loads it.
 */
'use strict';

const crypto = require('crypto');
const lanes = require('./kadeLaneTrustAdapter');
const tomb = require('./kadeKnownTombstones');

const SOFT_CAP_CHARS = 2000;
const PENDING = 'kadeknownpending';
const PENDING_MINUTES = 10;
const READ_MAX = 10;
const GROUPS = ['told', 'errand', 'mail', 'others', 'all'];

function on(env = process.env) {
  return String((env && env.KADE_KNOWN_CARD) ?? '') !== '0';
}

/* Words that, starting a card's key or subject, mean the card is about someone else. */
const OTHER_PEOPLE =
  /^(?:mom|mother|mum|dad|father|step|sister|brother|sibling|son|daughter|kid|kids|child|children|grand\w*|niece|nephew|aunt|uncle|cousin|wife|husband|spouse|partner|boyfriend|girlfriend|fiance\w*|ex|friend|friends|neighbor|neighbour|coworker|boss|roommate|in_law|inlaw|baby|family)(?:_|$)/;

function sourceOf(card) {
  const s = card && card.knownSource;
  return s === 'errand' || s === 'mail' ? s : 'told';
}
function aboutOther(card) {
  if (card && typeof card.aboutOther === 'boolean') return card.aboutOther;
  const k = String((card && card.key) || '').toLowerCase();
  const sub = String((card && card.subject) || '').toLowerCase();
  return OTHER_PEOPLE.test(k) || OTHER_PEOPLE.test(sub);
}
function bucketOf(agentId) {
  return agentId == null || agentId === '' ? null : String(agentId);
}
/** A short, stable handle for one card: never the key itself, never the database id. */
function refOf(card) {
  return 'f' + crypto.createHash('sha1').update(`${bucketOf(card.agentId) || ''}::${card.key}`).digest('hex').slice(0, 6);
}
function flat(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── storage, the real ones ───────────────────────────────────────────── */

/* For unit tests only: stand-ins for storage. Never set in the running server. */
const seam = { deps: null };
let pendingIndexed = false;

function realDeps() {
  const asSystem = (fn) => {
    const ds = require('@librechat/data-schemas');
    return typeof ds.runAsSystem === 'function' ? ds.runAsSystem(fn) : fn();
  };
  const db = () => require('~/models');
  const mongoose = () => require('mongoose');
  return {
    cards: async (userId, agentId) => {
      const [shared, own] = await Promise.all([
        asSystem(() => db().getAllUserMemories(userId, { agentId: null })),
        agentId ? asSystem(() => db().getAllUserMemories(userId, { agentId: String(agentId) })) : Promise.resolve([]),
      ]);
      return [...(shared || []), ...(own || [])];
    },
    deleteCard: ({ userId, agentId, key }) => asSystem(() => db().deleteMemory({ userId, agentId: bucketOf(agentId), key, forget: true })),
    correctCard: async ({ userId, agentId, key, value }) => {
      let tokenCount = Math.ceil(value.length / 4);
      try {
        tokenCount = await require('@librechat/api').countTokens(value);
      } catch (_) {
        /* the rough count stands */
      }
      return asSystem(() => db().setMemory({ userId, agentId: bucketOf(agentId), key, value, tokenCount, userCorrection: true }));
    },
    clearAll: async ({ userId, agentId }) => {
      const a = await asSystem(() => db().deleteAllUserMemories(userId, { agentId: null }));
      const b = agentId ? await asSystem(() => db().deleteAllUserMemories(userId, { agentId: String(agentId) })) : 0;
      try {
        await require('./kadeSoul').clearSoul(userId, agentId);
      } catch (_) {
        /* moments are cleared by the night's pass otherwise */
      }
      return (Number(a) || 0) + (Number(b) || 0);
    },
    /* Our own side rows about one card: its card-check mark. */
    clearMarks: ({ userId, agentId, key }) =>
      mongoose().connection.collection('kadecardchecks').deleteMany({ userId: String(userId), agentId: bucketOf(agentId), key: String(key) }),
    /* Moments and logbook lines that carry the forgotten fact, for this person, in the buckets this
     * character sees. Read newest first, a bounded number, matched in code, deleted by id. */
    removeCarriers: async ({ userId, agentId, text }) => {
      const c = mongoose().connection;
      const tombs = [{ hashes: tomb.hashes(userId, text) }];
      let removed = 0;
      const moments = await c
        .collection('kademoments')
        .find({ userId: String(userId), ...(agentId ? { agentId: String(agentId) } : {}) })
        .project({ quote: 1, why: 1 })
        .sort({ createdAt: -1 })
        .limit(300)
        .toArray();
      const mIds = moments
        .filter((m) => tomb.carriesPart(userId, String(m.quote || ''), tombs) || tomb.blockedWith(userId, `${m.quote || ''}\n${m.why || ''}`, tombs))
        .map((m) => m._id);
      if (mIds.length) removed += (await c.collection('kademoments').deleteMany({ _id: { $in: mIds }, userId: String(userId) })).deletedCount || 0;
      /* A logbook line usually holds more than one thing: the sentence carrying the fact is taken
       * out, and so is every older wording that carried it. A line left with almost nothing goes.
       * Its search vector is cleared, because it was made from the old words; the nightly repair
       * makes a new one. */
      const lines = await c
        .collection('kadediaryentries')
        .find({ userId: String(userId), agentId: { $in: [null, ...(agentId ? [String(agentId)] : [])] } })
        .project({ text: 1, priorTexts: 1, preRepairText: 1 })
        .sort({ createdAt: -1 })
        .limit(500)
        .toArray();
      for (const d of lines) {
        const prior = Array.isArray(d.priorTexts) ? d.priorTexts : [];
        const carries = (s) => typeof s === 'string' && tomb.blockedWith(userId, s, tombs);
        if (!carries(d.text) && !prior.some(carries) && !carries(d.preRepairText)) continue;
        const kept = tomb.scrubWith(userId, String(d.text || ''), tombs).text;
        if (kept.length < 20) {
          removed += (await c.collection('kadediaryentries').deleteOne({ _id: d._id, userId: String(userId) })).deletedCount || 0;
          continue;
        }
        await c.collection('kadediaryentries').updateOne(
          { _id: d._id, userId: String(userId) },
          {
            $set: {
              text: kept,
              priorTexts: prior.filter((p) => !carries(p)),
              preRepairText: carries(d.preRepairText) ? null : d.preRepairText ?? null,
              embedding: null,
              embeddingNext: null,
              embedNextHash: null,
            },
          },
        );
        removed += 1;
      }
      return removed;
    },
    addTombstone: (row) => tomb.add(row),
    liftTombstones: (row) => tomb.lift(row),
    pending: () => {
      const c = mongoose().connection.collection(PENDING);
      if (!pendingIndexed) {
        pendingIndexed = true;
        /* an unanswered "forget everything" ask removes itself after an hour */
        c.createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 }).catch(() => {
          pendingIndexed = false;
        });
      }
      return c;
    },
    now: () => new Date(),
  };
}

function deps() {
  return seam.deps || realDeps();
}

/* ── who is asking ────────────────────────────────────────────────────── */

const REFUSED = {
  off: 'This is switched off right now.',
  unavailable: 'This is not available here.',
  hidden: 'A background job cannot read or change what you know about someone.',
  'unknown-caller': 'The person on the line could not be matched to an account, so nothing about them can be read or changed here.',
  phone:
    'What you know about someone can only be heard or changed in the signed-in app or website, never on a phone call. ' +
    'Say that kindly in one sentence and ask them to ask you there.',
};

function who(req, env) {
  if (!on(env)) return { ok: false, why: 'off' };
  const a = lanes.actorOf(req, env);
  if (!a.ok) return a;
  if (a.lane !== 'signed-in') return { ok: false, why: 'phone' };
  return a;
}

/* ── the card ─────────────────────────────────────────────────────────── */

async function factsFor(userId, agentId) {
  const rows = (await deps().cards(userId, agentId)) || [];
  const seen = new Set();
  const out = [];
  for (const c of rows) {
    if (!c || !c.key || typeof c.value !== 'string' || !c.value.trim()) continue;
    if (c.status === 'superseded' || c.type === 'reminder') continue;
    if (String(c.userId || userId) !== String(userId)) continue; /* never another person's row */
    const ref = refOf(c);
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({ ref, key: c.key, agentId: bucketOf(c.agentId), text: flat(c.value), source: sourceOf(c), other: aboutOther(c), corrected: !!c.correctionLocked, at: c.updated_at || null });
  }
  out.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  return out;
}

function counts(facts) {
  const n = { told: 0, errand: 0, mail: 0, others: 0 };
  let chars = 0;
  for (const f of facts) {
    n[f.source] += 1;
    if (f.other) n.others += 1;
    chars += f.text.length;
  }
  return { ...n, total: facts.length, chars, softCapChars: SOFT_CAP_CHARS, over: chars > SOFT_CAP_CHARS };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The counts line, built in code, said before any read-back. */
function countLine(c) {
  if (!c.total) return 'I have nothing saved about you yet.';
  const parts = [plural(c.told, 'thing you told me', 'things you told me')];
  if (c.errand) parts.push(`${c.errand} from an errand`);
  if (c.mail) parts.push(`${c.mail} from your mail`);
  let line = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  line = line.charAt(0).toUpperCase() + line.slice(1) + '.';
  if (c.others) line += ` ${c.others === 1 ? 'One of them is' : `${c.others} of them are`} about someone else.`;
  return line + ' Which would you like to hear?';
}

const FROM = { told: 'you told me', errand: 'from an errand', mail: 'from your mail' };

async function count({ req, agentId, env = process.env }) {
  const w = who(req, env);
  if (!w.ok) return { ok: false, why: w.why, tellThem: REFUSED[w.why] };
  const c = counts(await factsFor(w.userId, agentId));
  return { ok: true, counts: c, tellThem: countLine(c) };
}

async function read({ req, agentId, group = 'all', offset = 0, env = process.env }) {
  const w = who(req, env);
  if (!w.ok) return { ok: false, why: w.why, tellThem: REFUSED[w.why] };
  const g = GROUPS.includes(group) ? group : 'all';
  const facts = await factsFor(w.userId, agentId);
  const pick = facts.filter((f) => (g === 'all' ? true : g === 'others' ? f.other : f.source === g));
  const start = Math.max(0, Number(offset) || 0);
  const items = pick.slice(start, start + READ_MAX).map((f) => ({
    ref: f.ref,
    fact: f.text,
    from: FROM[f.source],
    ...(f.other ? { aboutSomeoneElse: true } : {}),
    ...(f.corrected ? { youCorrectedIt: true } : {}),
  }));
  const more = Math.max(0, pick.length - start - items.length);
  return {
    ok: true,
    group: g,
    items,
    more,
    tellThem: items.length
      ? 'Read these to them plainly, one at a time, each with where it came from. Never say the ref.' + (more ? ` There are ${more} more; offer to go on.` : '')
      : 'Nothing is saved in that group. Say so plainly.',
  };
}

function findRef(facts, ref) {
  const r = String(ref || '').trim();
  return facts.find((f) => f.ref === r) || null;
}

const OLD_CHAT =
  'It may still be in your old chats from that day; you can delete those chats in the app.';

async function forget({ req, agentId, ref, env = process.env }) {
  const w = who(req, env);
  if (!w.ok) return { ok: false, why: w.why, tellThem: REFUSED[w.why] };
  const d = deps();
  const f = findRef(await factsFor(w.userId, agentId), ref);
  if (!f) return { ok: false, why: 'no-such-fact', tellThem: 'That fact was not found. Read the group again and use the ref from that read.' };
  const res = await d.deleteCard({ userId: w.userId, agentId: f.agentId, key: f.key });
  if (!res || res.ok !== true) return { ok: false, why: 'not-deleted', tellThem: 'It could not be forgotten just now. Tell them plainly and do not say it is gone.' };
  /* The rest never undoes the delete; each part fails on its own. */
  let carriers = 0;
  try {
    await d.addTombstone({ userId: w.userId, agentId: f.agentId, text: f.text, origin: 'forget' });
  } catch (_) {}
  try {
    await d.clearMarks({ userId: w.userId, agentId: f.agentId, key: f.key });
  } catch (_) {}
  try {
    carriers = Number(await d.removeCarriers({ userId: w.userId, agentId, text: f.text })) || 0;
  } catch (_) {}
  return {
    ok: true,
    forgotten: f.text,
    alsoRemoved: carriers,
    tellThem: `Forgotten: "${f.text}". Say what you forgot in a few plain words and that you will not bring it up again. ${OLD_CHAT}`,
  };
}

async function correct({ req, agentId, ref, value, env = process.env }) {
  const w = who(req, env);
  if (!w.ok) return { ok: false, why: w.why, tellThem: REFUSED[w.why] };
  const v = flat(value).slice(0, 600);
  if (v.length < 3) return { ok: false, why: 'empty', tellThem: 'Say the corrected fact in their own words in "value".' };
  const d = deps();
  const f = findRef(await factsFor(w.userId, agentId), ref);
  if (!f) return { ok: false, why: 'no-such-fact', tellThem: 'That fact was not found. Read the group again and use the ref from that read.' };
  /* A told-again fact is no longer forgotten. */
  try {
    await d.liftTombstones({ userId: w.userId, text: v });
  } catch (_) {}
  const res = await d.correctCard({ userId: w.userId, agentId: f.agentId, key: f.key, value: v });
  if (!res || res.ok !== true) return { ok: false, why: 'not-saved', tellThem: 'The correction could not be saved just now. Tell them plainly.' };
  /* The old wording is not to come back, unless the new one carries the same words. */
  try {
    if (!tomb.covers(tomb.hashes(w.userId, f.text), tomb.hashes(w.userId, v))) {
      await d.addTombstone({ userId: w.userId, agentId: f.agentId, text: f.text, origin: 'correct' });
    }
  } catch (_) {}
  return { ok: true, before: f.text, after: v, tellThem: `Corrected. It now reads: "${v}". Say it back to them in a few words.` };
}

async function forgetSource({ req, agentId, source, env = process.env }) {
  const w = who(req, env);
  if (!w.ok) return { ok: false, why: w.why, tellThem: REFUSED[w.why] };
  if (source !== 'mail' && source !== 'errand') {
    return { ok: false, why: 'bad-source', tellThem: 'forget_source is for "mail" or "errand". For everything, use forget_all.' };
  }
  const d = deps();
  const facts = (await factsFor(w.userId, agentId)).filter((f) => f.source === source);
  let n = 0;
  for (const f of facts) {
    const res = await d.deleteCard({ userId: w.userId, agentId: f.agentId, key: f.key });
    if (!res || res.ok !== true) continue;
    n += 1;
    try {
      await d.addTombstone({ userId: w.userId, agentId: f.agentId, text: f.text, origin: `forget-${source}` });
    } catch (_) {}
    try {
      await d.clearMarks({ userId: w.userId, agentId: f.agentId, key: f.key });
    } catch (_) {}
  }
  const what = source === 'mail' ? 'from your mail' : 'from errands';
  return {
    ok: true,
    forgottenCount: n,
    tellThem: n
      ? `Forgot ${plural(n, 'thing', 'things')} ${what}. If I talked about any of it in a chat, those words are still in that chat; you can delete it in the app.`
      : `There was nothing saved ${what}. Say so plainly.`,
  };
}

/**
 * Forget everything this character knows about them. Two steps, in two different messages:
 * the first call says how many things that is and asks; the call after their NEXT message does it
 * only when that message is a plain yes. Anything else closes the ask.
 */
async function forgetAll({ req, agentId, env = process.env }) {
  const w = who(req, env);
  if (!w.ok) return { ok: false, why: w.why, tellThem: REFUSED[w.why] };
  const spend = require('./kadeSpendGate');
  const d = deps();
  const coll = d.pending();
  const now = d.now();
  const convo = spend.conversationOf(req);
  const turn = spend.turnId(req);
  const scope = { userId: w.userId, agentId: bucketOf(agentId) };
  if (!convo) {
    return { ok: false, why: 'new-conversation', tellThem: 'This conversation is too new to hold the question. Ask them to say it again in a moment.' };
  }
  const open = await coll.findOne({ ...scope, conversationId: convo, createdAt: { $gte: new Date(now.getTime() - PENDING_MINUTES * 60000) } });
  if (open && open.turnId !== turn) {
    /* The ask is answered: one chance, then it closes either way. */
    await coll.deleteMany({ ...scope, conversationId: convo });
    const words = spend.latestWords(req.body && req.body.text);
    const yes =
      words.ok &&
      !spend.isReplay(req) &&
      spend.approvesPrice(words.words, { topic: ['forget', 'forgot', 'everything', 'all', 'of', 'it', 'them', 'delete', 'erase', 'wipe', 'that', 'do'] });
    if (!yes) {
      return { ok: false, why: 'no-yes', tellThem: 'Their message was not a plain yes, so nothing was forgotten. Say so, and that they can ask again.' };
    }
    const n = await d.clearAll({ userId: w.userId, agentId: bucketOf(agentId) });
    return {
      ok: true,
      forgottenCount: Number(n) || 0,
      tellThem:
        'Everything is forgotten: what you knew about them, and what every character shares about them. Say it is done, plainly. ' +
        'Other characters keep only what is their own. Old chats are not deleted; they can delete those in the app.',
    };
  }
  if (open && open.turnId === turn) {
    return { ok: false, why: 'same-turn', tellThem: 'You already asked in this reply. Wait for their next message.' };
  }
  const c = counts(await factsFor(w.userId, agentId));
  /* A memory clear also takes the reminder cards kept beside the facts: they are counted and said. */
  const reminders = ((await d.cards(w.userId, agentId)) || []).filter(
    (r) => r && r.type === 'reminder' && r.status !== 'superseded' && String(r.userId || w.userId) === w.userId,
  ).length;
  if (!c.total && !reminders) return { ok: true, forgottenCount: 0, tellThem: 'There is nothing saved about them. Say so plainly.' };
  await coll.deleteMany({ ...scope, conversationId: convo });
  await coll.insertOne({ ...scope, conversationId: convo, turnId: turn, count: c.total + reminders, createdAt: now });
  const also = reminders ? `, and ${plural(reminders, 'saved reminder', 'saved reminders')} kept with them` : '';
  return {
    ok: true,
    needsYes: true,
    count: c.total + reminders,
    tellThem: `That is ${plural(c.total, 'thing', 'things')}${also}. Tell them the number, that it cannot be undone, and ask them to say yes in their next message to forget it all. Do not call forget_all again until they answer.`,
  };
}

/** Account delete: the forget markers and any open "forget everything" ask go with the account. */
async function clearFor(userId) {
  if (!userId) return;
  await tomb.clearFor(userId);
  await require('mongoose').connection.collection(PENDING).deleteMany({ userId: String(userId) });
}

module.exports = {
  on,
  clearFor,
  count,
  read,
  forget,
  correct,
  forgetSource,
  forgetAll,
  /* pure pieces, exported for tests */
  sourceOf,
  aboutOther,
  refOf,
  counts,
  countLine,
  SOFT_CAP_CHARS,
  REFUSED,
  __seam: seam,
};
