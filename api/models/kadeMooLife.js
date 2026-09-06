/* KADE MOO — LIFE collections (Sep 6 2026, the Life layer).
 * Three small collections the Sims side of Reverie needs and the MOO bones
 * did not have: who feels what about whom, what the city is whispering, and
 * who holds the high score at the lanes. Same house pattern as kadeMoo.js:
 * plain Mongoose, Mixed bags for the future, no model in any loop. */
const mongoose = require('mongoose');

/** One document per PAIR of souls, players or citizens. `pair` is the two ids
 *  sorted and joined with '|' so a lookup is one indexed read from either
 *  side. friendship runs -100..100 (feud to family), romance 0..100. flags is
 *  the labelled state: partner, married, family, feud, exes. */
const MooRelSchema = new mongoose.Schema(
  {
    pair: { type: String, required: true, unique: true },
    a: { type: String, required: true, index: true },
    b: { type: String, required: true, index: true },
    friendship: { type: Number, default: 0 },
    romance: { type: Number, default: 0 },
    flags: { type: mongoose.Schema.Types.Mixed, default: {} },
    /** display names by id, so a list can be read without a second lookup */
    names: { type: mongoose.Schema.Types.Mixed, default: {} },
    /** last few interaction kinds, newest last — for "you already said that" */
    recent: { type: [String], default: [] },
    lastAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

/** The city's whisper network. A rumor is born from a notable act and dies
 *  of old age. `about` are user ids so a person can hear the city talking
 *  about THEM; `ward` is where it started, and it spreads outward by age. */
const MooRumorSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    about: { type: [String], default: [], index: true },
    ward: { type: String, default: 'bellward' },
    kind: { type: String, default: 'talk' },
    heat: { type: Number, default: 3 },
    at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false },
);

/** High scores and standings — bowling, darts, the biggest fish. */
const MooBoardSchema = new mongoose.Schema(
  {
    board: { type: String, required: true, index: true },
    userId: { type: String, required: true },
    name: { type: String, required: true },
    score: { type: Number, required: true },
    note: { type: String, default: '' },
    at: { type: Date, default: Date.now },
  },
  { timestamps: false },
);
MooBoardSchema.index({ board: 1, score: -1 });

const MooRel = mongoose.models.MooRel || mongoose.model('MooRel', MooRelSchema, 'kademoorels');
const MooRumor = mongoose.models.MooRumor || mongoose.model('MooRumor', MooRumorSchema, 'kademoorumors');
const MooBoard = mongoose.models.MooBoard || mongoose.model('MooBoard', MooBoardSchema, 'kademooboards');

module.exports = { MooRel, MooRumor, MooBoard };
