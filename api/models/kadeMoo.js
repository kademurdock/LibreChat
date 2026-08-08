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
    /** { type: 'room'|'char', id: roomId|userId } */
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
    at: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

const MooCounterSchema = new mongoose.Schema({
  _id: { type: String },
  n: { type: Number, default: 0 },
});

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

async function nextSeq() {
  const doc = await MooCounter.findOneAndUpdate(
    { _id: 'events' },
    { $inc: { n: 1 } },
    { upsert: true, new: true },
  );
  return doc.n;
}

module.exports = { MooRoom, MooChar, MooItem, MooEvent, nextSeq };
