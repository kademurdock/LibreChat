/* REVERIE LIFE — shared context and helpers (Sep 6 2026).
 *
 * The Life layer is the Sims side of the city: a character with needs and
 * skills and a home and a family, living inside the MOO bones that already
 * stand (engine.js, reverie.js). Every module in this folder receives a
 * `ctx` built here: the character, the room, the parsed command, and small
 * helpers that write to Mongo the same way the old engine does, so the two
 * layers share ONE world and one chronicle.
 *
 * Laws carried over, unchanged:
 *   - Code is the referee. No model in any loop. $0 a turn.
 *   - Law 3: the world never punishes leaving. Needs decay only while you play.
 *   - Comfort meters, never death timers.
 *   - Nothing a player reads names a real place.
 */
const { MooRoom, MooChar, MooItem, MooEvent, MooDistrict, nextSeq } = require('~/models/kadeMoo');
const { logger } = require('@librechat/data-schemas');

const DIR_ALIASES = {
  north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
  up: 'u', down: 'd', in: 'in', out: 'out',
  n: 'n', s: 's', e: 'e', w: 'w', ne: 'ne', nw: 'nw', se: 'se', sw: 'sw', u: 'u', d: 'd',
};
const DIR_WORDS = {
  n: 'north', s: 'south', e: 'east', w: 'west', ne: 'northeast', nw: 'northwest',
  se: 'southeast', sw: 'southwest', u: 'up', d: 'down', in: 'in', out: 'out',
};

const TZ = 'America/Chicago';
function worldClock(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: 'numeric', minute: 'numeric', hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const h = parseInt(get('hour'), 10) % 24;
  const m = parseInt(get('minute'), 10) || 0;
  const bucket =
    h < 5 ? 'the dead of night' : h < 8 ? 'early morning' : h < 12 ? 'morning' :
    h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
  const dayKey = `${get('year')}-${get('month')}-${get('day')}`;
  const wd = get('weekday');
  return { h, m, bucket, dayKey, weekday: wd, weekend: wd === 'Sat' || wd === 'Sun', dark: h < 6 || h >= 20 };
}

function clockLine() {
  const c = worldClock();
  const hh = c.h % 12 === 0 ? 12 : c.h % 12;
  const ampm = c.h < 12 ? 'in the morning' : c.h < 17 ? 'in the afternoon' : c.h < 21 ? 'in the evening' : 'at night';
  return `${hh}:${String(c.m).padStart(2, '0')} ${ampm}`;
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function slug(s) { return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40); }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function pick(arr, seed) { if (!arr || !arr.length) return null; return seed === undefined ? arr[Math.floor(Math.random() * arr.length)] : arr[hashStr(String(seed)) % arr.length]; }
function chance(p) { return Math.random() < p; }
function plural(n, one, many) { return `${n} ${n === 1 ? one : (many || one + 's')}`; }
function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
function joinAnd(list) { const a = list.filter(Boolean); if (a.length <= 1) return a.join(''); if (a.length === 2) return a.join(' and '); return a.slice(0, -1).join(', ') + ', and ' + a[a.length - 1]; }

/** Write one line into the chronicle for a room. Same shape as engine.emit. */
async function emit(roomId, actorUserId, actorName, kind, text, sound) {
  return require('../engine').emit(roomId, actorUserId, actorName, kind, text, sound);
}

/** Whisper lane: a private event only one user's meanwhile can see. */
async function tell(userId, text, kind = 'system', sound) {
  return emit(`whisper:${userId}`, null, 'the world', kind, text, sound);
}

/** Patch the active character's attrs, and mirror it onto the in-memory ch
 *  so the rest of the turn reads what it just wrote. Dotted keys allowed. */
async function setAttrs(ch, patch, inc) {
  const upd = {};
  if (patch && Object.keys(patch).length) upd.$set = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k.startsWith('attrs.') ? k : `attrs.${k}`, v]));
  if (inc && Object.keys(inc).length) upd.$inc = Object.fromEntries(Object.entries(inc).map(([k, v]) => [k.startsWith('attrs.') ? k : `attrs.${k}`, v]));
  if (!upd.$set && !upd.$inc) return;
  await MooChar.updateOne({ _id: ch._id }, upd);
  ch.attrs = ch.attrs || {};
  for (const [k, v] of Object.entries(patch || {})) setPath(ch.attrs, k.replace(/^attrs\./, ''), v);
  for (const [k, v] of Object.entries(inc || {})) { const key = k.replace(/^attrs\./, ''); setPath(ch.attrs, key, (getPath(ch.attrs, key) || 0) + v); }
}
function setPath(obj, dotted, v) { const ks = dotted.split('.'); let o = obj; for (let i = 0; i < ks.length - 1; i++) { if (typeof o[ks[i]] !== 'object' || o[ks[i]] === null) o[ks[i]] = {}; o = o[ks[i]]; } o[ks[ks.length - 1]] = v; }
function getPath(obj, dotted) { return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }

function coinOf(ch) { return Math.max(0, Math.floor((ch.attrs && ch.attrs.coin) || 0)); }
async function payCoin(ch, n) {
  if (coinOf(ch) < n) return false;
  await setAttrs(ch, {}, { coin: -n });
  return true;
}
async function earnCoin(ch, n) { await setAttrs(ch, {}, { coin: n }); }

async function setBusy(ch, seconds, doing) {
  /* REVERIE_FAST=1 turns roundtime off — for the harness, and for a demo night if she wants it. */
  if (process.env.REVERIE_FAST === '1') seconds = 0;
  const until = Date.now() + seconds * 1000;
  await setAttrs(ch, { busyUntil: until, busyDoing: doing });
}

/** Move a character to a room with the leave/enter lines the room reads.
 *  Poses clear on movement, prevRoom is kept for `back`. */
async function moveTo(ch, destId, leaveText, enterText, opts = {}) {
  const origin = ch.roomId;
  if (leaveText) await emit(origin, ch.userId, ch.name, 'leave', leaveText);
  await MooChar.updateOne({ _id: ch._id }, { $set: { roomId: destId, 'attrs.prevRoom': origin, 'attrs.pose': null, 'attrs.posture': 'standing' } });
  ch.roomId = destId;
  ch.attrs = { ...(ch.attrs || {}), prevRoom: origin, pose: null, posture: 'standing' };
  if (enterText) await emit(destId, ch.userId, ch.name, 'enter', enterText);
  /* Whatever rides with you comes along: a carried stray, a following kid, a car you are driving. */
  if (!opts.noFollow) {
    const followers = await MooChar.find({ 'attrs.followUser': ch.userId, roomId: origin }).select('_id name userId').lean();
    for (const f of followers) {
      await MooChar.updateOne({ _id: f._id }, { $set: { roomId: destId } });
      await emit(destId, f.userId, f.name, 'enter', `${f.name} comes along with ${ch.name}.`);
    }
  }
}

async function roomOf(ch) { return MooRoom.findOne({ roomId: ch.roomId }).lean(); }
async function districtOf(room) { return room ? MooDistrict.findOne({ districtId: room.district }).lean() : null; }

/** Find a soul in the room by loose name: exact, then aka, then prefix, then includes. */
function matchName(list, query, nameOf = (x) => x.name, akaOf = (x) => (x.attrs && x.attrs.aka) || '') {
  const q = String(query || '').toLowerCase().trim().replace(/^(the|a|an)\s+/, '');
  if (!q) return null;
  return list.find((x) => nameOf(x).toLowerCase() === q || akaOf(x).toLowerCase() === q)
    || list.find((x) => nameOf(x).toLowerCase().split(/\s+/)[0] === q)
    || list.find((x) => nameOf(x).toLowerCase().startsWith(q))
    || list.find((x) => nameOf(x).toLowerCase().includes(q) || akaOf(x).toLowerCase().includes(q))
    || null;
}

async function peopleIn(roomId, exceptUserId) {
  const q = { roomId };
  if (exceptUserId) q.userId = { $ne: exceptUserId };
  return MooChar.find(q).lean();
}
function kindOfSoul(p) {
  const u = String(p.userId || '');
  if (u.startsWith('npc:')) return 'citizen';
  if (u.startsWith('stray:')) return 'stray';
  if (u.startsWith('kid:')) return 'child';
  if (u.startsWith('pet:')) return 'pet';
  return 'player';
}

async function itemsHeld(userId) { return MooItem.find({ 'location.type': 'char', 'location.id': userId }).lean(); }
async function itemsIn(roomId) { return MooItem.find({ 'location.type': 'room', 'location.id': roomId }).lean(); }
async function findHeld(userId, query, extra = {}) {
  const items = await MooItem.find({ 'location.type': 'char', 'location.id': userId, ...extra }).lean();
  return matchName(items, query, (i) => i.name.replace(/^(a|an|the|some)\s+/i, ''), (i) => (i.props && i.props.key) || '');
}
async function makeItem({ name, desc, location, portable = true, props = {} }) {
  const itemId = slug(name).slice(0, 24) + '_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  return MooItem.create({ itemId, name, desc, location, portable, props });
}

/** The world's day key for "once a day" things. */
function todayKey() { return worldClock().dayKey; }
function daysBetween(fromMs, toMs = Date.now()) { return Math.floor((toMs - fromMs) / 86400000); }

module.exports = {
  DIR_ALIASES, DIR_WORDS, TZ, worldClock, clockLine, todayKey, daysBetween,
  escapeRe, slug, clamp, hashStr, pick, chance, plural, cap, joinAnd,
  emit, tell, setAttrs, getPath, coinOf, payCoin, earnCoin, setBusy, moveTo,
  roomOf, districtOf, matchName, peopleIn, kindOfSoul, itemsHeld, itemsIn, findHeld, makeItem,
  MooRoom, MooChar, MooItem, MooEvent, MooDistrict, logger,
};
