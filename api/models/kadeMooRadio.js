/* KADE MOO — the Band's air log (Part 180, Sep 11 2026).
 *
 * One row per broadcast block: the slot it was written for, the script the
 * writer handed back, the transcript every client can read, and the
 * recording's home in the private bucket. `slotKey` is `<day>_<slot>` so a
 * block is made at most once per slot per day, and the unique index is what
 * makes two ticks racing for the same block harmless. */
const mongoose = require('mongoose');

const MooRadioSchema = new mongoose.Schema(
  {
    slotKey: { type: String, required: true, unique: true },
    slot: { type: String, default: '' }, // morning | day | evening | night
    dayKey: { type: String, default: '' },
    program: { type: String, default: '' },
    host: { type: String, default: '' },
    title: { type: String, default: '' },
    state: { type: String, default: 'writing' }, // writing | performing | done | failed
    script: { type: mongoose.Schema.Types.Mixed, default: null },
    transcript: { type: [{ speaker: String, text: String }], default: [] },
    performed: { type: String, default: '' }, // the exact text the engine was handed
    engine: { type: String, default: '' }, // seed | inworld
    url: { type: String, default: '' },
    backupUrl: { type: String, default: '' },
    seconds: { type: Number, default: 0 },
    bytes: { type: Number, default: 0 },
    costUSD: { type: Number, default: 0 },
    linesUsed: { type: Number, default: 0 },
    lastError: { type: String, default: '' },
    at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

const MooRadio = mongoose.models.MooRadio || mongoose.model('MooRadio', MooRadioSchema, 'kademooradio');

module.exports = { MooRadio };
