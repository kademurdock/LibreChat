/* KADE MOO — the world's bones (Aug 8 2026, her word: "set up the legs").
 * Canon: MOO_WORKUP_SEED (engine law) + MOO_WORLD_BIBLE_SEED (society), both
 * mirrored at /design/* on the proxy. THE LAW: code is the referee — rooms,
 * exits, objects, presence, and the chronicle live HERE, deterministic, in
 * Mongo (nightly B2 backup covers the world for free). The model narrates
 * facts; it never invents state. Schemas carry extensible Mixed bags (attrs,
 * props) so the bible's future — districts' law tables, scars, standing,
 * death — lands as DATA, not rearchitecture. Plain Mongoose, house pattern. */
const mongoose = require('mongoose');

const MooRoomSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    district: { type: String, default: 'gate', index: true },
    desc: { type: String, default: '' },
    /** direction/name -> roomId, e.g. { n: 'lantern_row', gate: 'city_gate' } */
    exits: { type: mongoose.Schema.Types.Mixed, default: {} },
    props: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdBy: { type: String, default: 'seed' },
  },
  { timestamps: true },
);

const MooCharSchema = new mongoose.Schema(
  {
    /* Aug 8 2026 (her RS Games note): MULTIPLE playable characters per user —
     * userId is no longer unique; (userId, name) is, and `active` marks which
     * one commands drive. The old unique index gets dropped fail-soft below. */
    userId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    active: { type: Boolean, default: true },
    roomId: { type: String, required: true, index: true },
    /** the bible's future lives here: alive, scars, standing, record… */
    attrs: { type: mongoose.Schema.Types.Mixed, default: { alive: true } },
    /** event-visibility cursor: everything after this reaches them next turn */
    lastSeenSeq: { type: Number, default: 0 },
    lastActiveAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

const MooItemSchema = new mongoose.Schema(
  {
    itemId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    desc: { type: String, default: '' },
    /** { type: 'room'|'char'|'item', id: roomId|userId|itemId } — 'item' = inside a container */
    location: { type: mongoose.Schema.Types.Mixed, required: true },
    portable: { type: Boolean, default: true },
    props: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);
MooItemSchema.index({ 'location.type': 1, 'location.id': 1 });

/** The chronicle: every happening, dated and sequenced — the world's own
 *  logbook, and the ripple-review lab her experiments need. */
const MooEventSchema = new mongoose.Schema(
  {
    seq: { type: Number, required: true, index: true },
    roomId: { type: String, required: true, index: true },
    actorUserId: { type: String, default: null },
    actorName: { type: String, default: 'the world' },
    kind: { type: String, required: true }, // say|emote|enter|leave|take|drop|system
    text: { type: String, required: true },
    /* KADE 2026-08-12 (the physics pass): an event may NAME its own sound.
     * Until now a client only ever saw `kind`, and the whole world emits
     * kind:'system' for the night freight, every weather turn and every
     * ambient census breath -- so a horn installed under 'system' would play
     * when the sky changed. This field carries the wishlist id (e.g.
     * 'transit.train.horn.night.far'), looked up in the same manifest the
     * three scopes already use. Optional, null everywhere it is not set, so
     * every existing event and every existing client behave exactly as before.
     * It is what lets ONE event reach nine wards at nine different distances. */
    sound: { type: String, default: null },
    at: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

const MooCounterSchema = new mongoose.Schema({
  _id: { type: String },
  n: { type: Number, default: 0 },
});

/** KadeCore (Aug 8 2026): DISTRICTS as data — the bible's per-district law
 *  tables land here (props carries law/tone/anything; the engine never
 *  hardcodes a district). */
const MooDistrictSchema = new mongoose.Schema(
  {
    districtId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    desc: { type: String, default: '' },
    props: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

/** KadeCore: the SOUND REGISTRY — her designed audio as data. scopeType:
 *  'event' (kind: move/take/...), 'room' (roomId), 'district' (districtId).
 *  Clients fetch the manifest and play; no deploy ever needed for a sound. */
const MooSoundSchema = new mongoose.Schema(
  {
    scopeType: { type: String, required: true }, // event | room | district
    scopeId: { type: String, required: true },
    url: { type: String, required: true },
    label: { type: String, default: '' },
    addedBy: { type: String, default: '' },
  },
  { timestamps: true },
);
MooSoundSchema.index({ scopeType: 1, scopeId: 1 }, { unique: true });

const MooRoom = mongoose.models.MooRoom || mongoose.model('MooRoom', MooRoomSchema, 'kademoorooms');
MooCharSchema.index({ userId: 1, name: 1 }, { unique: true });

const MooChar = mongoose.models.MooChar || mongoose.model('MooChar', MooCharSchema, 'kademoochars');
/* Drop the phase-one unique userId index so second characters can exist.
 * Fail-soft: absent index or race just logs. */
MooChar.collection.dropIndex('userId_1').catch(() => {});
const MooItem = mongoose.models.MooItem || mongoose.model('MooItem', MooItemSchema, 'kademooitems');
const MooEvent = mongoose.models.MooEvent || mongoose.model('MooEvent', MooEventSchema, 'kademooevents');
const MooCounter =
  mongoose.models.MooCounter || mongoose.model('MooCounter', MooCounterSchema, 'kademoocounters');
const MooDistrict =
  mongoose.models.MooDistrict || mongoose.model('MooDistrict', MooDistrictSchema, 'kademoodistricts');
const MooSound =
  mongoose.models.MooSound || mongoose.model('MooSound', MooSoundSchema, 'kademoosounds');

async function nextSeq() {
  const doc = await MooCounter.findOneAndUpdate(
    { _id: 'events' },
    { $inc: { n: 1 } },
    { upsert: true, new: true },
  );
  return doc.n;
}

module.exports = { MooRoom, MooChar, MooItem, MooEvent, MooDistrict, MooSound, nextSeq };
