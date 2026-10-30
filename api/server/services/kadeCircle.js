/**
 * KADE CIRCLES (Oct 29 2026): who the person in front of a character is, and who is in
 * their bubble.
 *
 * Kade's report, Oct 29 2026: "Kiana keeps telling me, you want me to mention this to Kade?
 * during bug reports and stuff and I keep telling her I am Kade. The owner of this operation."
 * The cause: nothing in a character's background said who it was talking to. The platform
 * note says Kade built the place and the bug-report tool says to offer "Want me to send that
 * to Kade for you?", but no line ever said "this person is Kade". So every reply's background
 * now gets a short WHO line: the person's name, and for the platform owner, that this is Kade,
 * who made and runs Kade-AI.
 *
 * Her second ask, same night: "everybody under my family pack knows me and each other, so if
 * Amber mentions me to Kiana, she should know who I am even though it is her instance of
 * Kiana ... some surface level facts: Holly being my mom ... These people should all be under
 * the family flag because they're in my bubble. This would as much apply off platform in the
 * future to people I don't know as well."
 *
 * So a CIRCLE belongs to one owner (Kade's today; anyone's later): the people in it (account
 * ids where they have one, the names they go by), what each is to the owner, a few links
 * between them ("Crystal is Amber A's mom"), and the family flag. People in a circle with the
 * family flag hear its surface facts in every character's background; nobody else does, and
 * no circle's facts reach a person outside it. These are surface facts only, never chat
 * content, memory cards or anything private. Notes nobody has settled yet (which Amber is
 * Cam's girlfriend) are stored as `unresolved` and never injected.
 *
 * Storage: Mongo collection `kadecircles`, one document per owner. Admin-only routes read and
 * edit it (routes/kadeCircles.js). The rendered block is deterministic and byte-stable until
 * the circle or the person's name changes, so the head keeps its prompt cache.
 *
 * Kill switch: KADE_WHO_LINE=0 removes the whole block (the who line and the circle facts).
 */
'use strict';

const COLL = 'kadecircles';
const ID = /^[a-f0-9]{24}$/;
const KEY = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_PEOPLE = 60;
const MAX_LINKS = 80;
const MEMO_MS = 60 * 1000;
const PLATFORM_ROLE = 'who made and runs Kade-AI';

function on() {
  return process.env.KADE_WHO_LINE !== '0';
}

function coll() {
  return require('mongoose').connection.collection(COLL);
}

function platformOwnerId() {
  return require('./kadeHiddenRun').ownerId();
}

/** One line of plain text: no newlines or control characters, single spaces, capped. */
function clean(value, max = 40) {
  return String(value == null ? '' : value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[#*`<>{}[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/**
 * Check and normalize a circle sent by an admin. Returns { circle } or { error } in plain
 * words. Unknown fields are dropped.
 */
function validateCircle(input, ownerUserId) {
  const b = input && typeof input === 'object' ? input : {};
  const owner = String(ownerUserId || b.ownerUserId || '');
  if (!ID.test(owner)) return { error: 'The owner must be an account id.' };
  const ownerName = clean(b.ownerName);
  if (!ownerName) return { error: 'The owner needs a name (what people call them).' };
  const people = Array.isArray(b.people) ? b.people : [];
  if (people.length > MAX_PEOPLE) return { error: `A circle holds at most ${MAX_PEOPLE} people.` };
  const keys = new Set();
  const userIds = new Set([owner]);
  const outPeople = [];
  for (const [i, p] of people.entries()) {
    const key = String((p && p.key) || '').toLowerCase();
    if (!KEY.test(key)) return { error: `Person ${i + 1} needs a short key (lowercase letters, numbers, dashes).` };
    if (keys.has(key)) return { error: `The key "${key}" is used twice.` };
    keys.add(key);
    const name = clean(p.name);
    if (!name) return { error: `Person "${key}" needs a name.` };
    let userId = p.userId == null || p.userId === '' ? null : String(p.userId);
    if (userId !== null && !ID.test(userId)) return { error: `Person "${key}" has an account id that is not valid.` };
    if (userId !== null && userIds.has(userId)) {
      return { error: `Person "${key}" repeats an account already in this circle (the owner is not listed as a person).` };
    }
    if (userId) userIds.add(userId);
    const aliases = (Array.isArray(p.aliases) ? p.aliases : []).map((a) => clean(a)).filter(Boolean).slice(0, 6);
    outPeople.push({
      key,
      name,
      userId,
      aliases,
      family: p.family === true,
      isOwners: clean(p.isOwners),
      ownerIsTheir: clean(p.ownerIsTheir),
    });
  }
  const links = Array.isArray(b.links) ? b.links : [];
  if (links.length > MAX_LINKS) return { error: `A circle holds at most ${MAX_LINKS} links.` };
  const outLinks = [];
  for (const [i, l] of links.entries()) {
    const a = String((l && l.a) || '').toLowerCase();
    const bKey = String((l && l.b) || '').toLowerCase();
    const aIsBs = clean(l && l.aIsBs);
    if (!keys.has(a) || !keys.has(bKey)) return { error: `Link ${i + 1} names someone who is not in the circle.` };
    if (a === bKey) return { error: `Link ${i + 1} links a person to themself.` };
    if (!aIsBs) return { error: `Link ${i + 1} needs what ${a} is to ${bKey}.` };
    outLinks.push({ a, b: bKey, aIsBs });
  }
  const unresolved = (Array.isArray(b.unresolved) ? b.unresolved : []).map((u) => clean(u, 300)).filter(Boolean).slice(0, 20);
  return {
    circle: {
      ownerUserId: owner,
      ownerName,
      ownerRole: clean(b.ownerRole, 80),
      people: outPeople,
      links: outLinks,
      unresolved,
    },
  };
}

/* ---------------------------------------------------------------- rendering (pure) */

function joinNames(items) {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function ownerRoleOf(circle, platformOwner) {
  if (circle.ownerRole) return circle.ownerRole;
  return String(circle.ownerUserId) === String(platformOwner) ? PLATFORM_ROLE : '';
}

/** The circle as the owner hears it. */
function renderForOwner(circle) {
  const byKey = new Map(circle.people.map((p) => [p.key, p]));
  const items = [];
  for (const p of circle.people) {
    if (!p.family) continue;
    const rel = [];
    if (p.isOwners) rel.push(`your ${p.isOwners}`);
    for (const l of circle.links) {
      if (l.a === p.key && byKey.get(l.b) && byKey.get(l.b).family) rel.push(`${byKey.get(l.b).name}'s ${l.aIsBs}`);
    }
    items.push(rel.length ? `${p.name} (${rel.join('; ')})` : p.name);
  }
  return items.length ? `People in your circle here: ${items.join(', ')}.` : '';
}

/** The circle as one of its family-flag members hears it. */
function renderForMember(circle, me, platformOwner) {
  const byKey = new Map(circle.people.map((p) => [p.key, p]));
  const owner = circle.ownerName;
  const role = ownerRoleOf(circle, platformOwner);
  const ownerRef = role ? `${owner} (${role})` : owner;
  const lines = [];
  if (me.ownerIsTheir) lines.push(`${ownerRef} is your ${me.ownerIsTheir}.`);
  else if (me.isOwners) lines.push(`You're ${owner}'s ${me.isOwners}. That's ${ownerRef}.`);
  else lines.push(`You're in ${owner}'s circle here. That's ${ownerRef}.`);
  for (const l of circle.links) {
    const a = byKey.get(l.a);
    const b = byKey.get(l.b);
    if (!a || !b || !a.family || !b.family) continue;
    if (l.a === me.key) lines.push(`You're ${b.name}'s ${l.aIsBs}.`);
    else if (l.b === me.key) lines.push(`${a.name} is your ${l.aIsBs}.`);
  }
  const items = [];
  for (const p of circle.people) {
    if (!p.family || p.key === me.key) continue;
    const rel = [];
    if (p.isOwners) rel.push(`${owner}'s ${p.isOwners}`);
    for (const l of circle.links) {
      if (l.a !== p.key || !byKey.get(l.b) || !byKey.get(l.b).family) continue;
      rel.push(l.b === me.key ? `your ${l.aIsBs}` : `${byKey.get(l.b).name}'s ${l.aIsBs}`);
    }
    items.push(rel.length ? `${p.name} (${rel.join('; ')})` : p.name);
  }
  if (items.length) lines.push(`Also in ${owner}'s circle here: ${items.join(', ')}.`);
  return lines.join(' ');
}

/**
 * The whole block for one person. Pure: `circles` are the circles this person owns or is a
 * family-flag member of; `platformOwner` is the account id of Kade-AI's owner.
 */
function renderWhoBlock({ userId, name, circles = [], platformOwner }) {
  const id = String(userId || '');
  if (!id) return '';
  const sorted = [...circles].sort((x, y) => String(x.ownerUserId).localeCompare(String(y.ownerUserId)));
  const owned = sorted.find((c) => String(c.ownerUserId) === id);
  const memberships = sorted
    .filter((c) => String(c.ownerUserId) !== id)
    .map((c) => ({ c, me: c.people.find((p) => p.userId && String(p.userId) === id && p.family) }))
    .filter((x) => x.me);
  const shownName = clean((owned && owned.ownerName) || (memberships[0] && memberships[0].me.name) || name);
  const isPlatformOwner = platformOwner && id === String(platformOwner);
  const lines = ['WHO YOU ARE TALKING WITH (house facts; use them naturally, never recite them):'];
  if (isPlatformOwner) {
    const n = shownName || 'Kade';
    lines.push(
      `You're talking with ${n}, ${PLATFORM_ROLE}. Bug reports, ideas and requests ${n} gives you are already with the right person: never offer to pass something along to ${n} or ask whether to mention it to ${n}.`,
    );
  } else if (shownName) {
    lines.push(`You're talking with ${shownName}.`);
  } else if (!owned && !memberships.length) {
    return '';
  }
  if (owned) {
    const own = renderForOwner(owned);
    if (own) lines.push(own);
  }
  for (const { c, me } of memberships) {
    lines.push(renderForMember(c, me, platformOwner));
  }
  return lines.join('\n');
}

/* ---------------------------------------------------------------- storage */

let indexed = false;
async function ensureIndexes() {
  if (indexed) return;
  indexed = true;
  try {
    await coll().createIndex({ ownerUserId: 1 }, { unique: true });
    await coll().createIndex({ 'people.userId': 1 });
  } catch (e) {
    indexed = false;
  }
}

const memo = new Map();

function forget() {
  memo.clear();
}

/** The circles a person owns or is a family-flag member of (memoized for a minute). */
async function circlesFor(userId) {
  const id = String(userId || '');
  if (!ID.test(id)) return [];
  const hit = memo.get(id);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.circles;
  const circles = await coll()
    .find({ $or: [{ ownerUserId: id }, { people: { $elemMatch: { userId: id, family: true } } }] })
    .project({ _id: 0 })
    .limit(5)
    .toArray();
  if (memo.size > 2000) memo.clear();
  memo.set(id, { at: Date.now(), circles });
  return circles;
}

async function getCircle(ownerUserId) {
  if (!ID.test(String(ownerUserId || ''))) return null;
  return coll().findOne({ ownerUserId: String(ownerUserId) }, { projection: { _id: 0 } });
}

async function listCircles() {
  const rows = await coll().find({}).project({ _id: 0 }).sort({ ownerUserId: 1 }).limit(200).toArray();
  return rows.map((c) => ({
    ownerUserId: c.ownerUserId,
    ownerName: c.ownerName,
    people: (c.people || []).length,
    family: (c.people || []).filter((p) => p.family).length,
    unresolved: (c.unresolved || []).length,
    revision: c.revision || 0,
    updatedAt: c.updatedAt,
  }));
}

/** Replace one owner's circle with a validated one. Returns { circle } or { error }. */
async function saveCircle(ownerUserId, input, editorId) {
  const checked = validateCircle(input, ownerUserId);
  if (checked.error) return checked;
  await ensureIndexes();
  const before = await coll().findOne({ ownerUserId: checked.circle.ownerUserId }, { projection: { revision: 1 } });
  const doc = {
    ...checked.circle,
    revision: ((before && before.revision) || 0) + 1,
    updatedAt: new Date(),
    updatedBy: String(editorId || ''),
  };
  await coll().replaceOne({ ownerUserId: doc.ownerUserId }, doc, { upsert: true });
  forget();
  return { circle: await getCircle(doc.ownerUserId) };
}

/**
 * Who is really talking on this request: the voice lane's resolved caller, else the signed-in
 * account. Null when nobody can be named: an unresolved voice caller, or a headless service turn
 * (the voice proxy's admin seat sends a `messages` array) that names no caller.
 */
function personOf(req) {
  if (!req || !req.user) return null;
  if (req.kadeOnBehalfOfUnresolved === true) return null;
  if (req.kadeOnBehalfOf && req.kadeOnBehalfOf.id) {
    return { id: String(req.kadeOnBehalfOf.id), name: req.kadeOnBehalfOf.name || req.kadeOnBehalfOf.username || '' };
  }
  const body = req.body || {};
  if (String(req.user.role || '').toUpperCase() === 'ADMIN' && Array.isArray(body.messages)) return null;
  return { id: String(req.user.id || req.user._id || ''), name: req.user.name || req.user.username || '' };
}

/** The head block for this request ('' when off or nobody can be named). Fail-soft. */
async function getWhoBlock(req) {
  if (!on()) return '';
  const person = personOf(req);
  if (!person || !person.id) return '';
  let circles = [];
  try {
    circles = await circlesFor(person.id);
  } catch (_) {
    circles = [];
  }
  return renderWhoBlock({ userId: person.id, name: person.name, circles, platformOwner: platformOwnerId() });
}

module.exports = {
  COLL,
  PLATFORM_ROLE,
  validateCircle,
  renderWhoBlock,
  personOf,
  getWhoBlock,
  circlesFor,
  getCircle,
  listCircles,
  saveCircle,
  forget,
};
