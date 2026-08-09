/**
 * KADE ACCESS REQUESTS (Aug 9 2026 — her registration overhaul, phase one).
 * The front door grows a doorbell: instead of needing a code handed to them,
 * someone can ASK — who they are, why they're here, who they know — and the
 * request lands as a push on Kade's phone. Her approval mints the blessing.
 * Plain Mongoose on purpose (kadeDiary/kadeNudge precedent — no TS build).
 */
const mongoose = require('mongoose');

const kadeAccessRequestSchema = new mongoose.Schema(
  {
    /** What they want to be called. */
    name: { type: String, required: true, maxlength: 80 },
    /** How Kade can reach them with the blessing (phone or email, free text). */
    contact: { type: String, required: true, maxlength: 160 },
    /** Who are you / how do you know Kade's world? */
    whoYouAre: { type: String, required: true, maxlength: 1200 },
    /** Why do you want in? */
    whyHere: { type: String, default: '', maxlength: 1200 },
    status: { type: String, enum: ['pending', 'approved', 'denied'], default: 'pending', index: true },
    /** Set at approval: 'adult' | 'child' — decides which registration code rides the blessing. */
    audience: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    decidedNote: { type: String, default: '', maxlength: 500 },
    /** Light abuse forensics. */
    ip: { type: String, default: '' },
  },
  { timestamps: true },
);

const KadeAccessRequest =
  mongoose.models.KadeAccessRequest ||
  mongoose.model('KadeAccessRequest', kadeAccessRequestSchema, 'kadeaccessrequests');

module.exports = { KadeAccessRequest };
