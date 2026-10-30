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
    status: {
      type: String,
      enum: ['pending', 'approved', 'denied'],
      default: 'pending',
      index: true,
    },
    /** Set at approval: 'adult' | 'child' — decides which registration code rides the blessing. */
    audience: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    decidedNote: { type: String, default: '', maxlength: 500 },
    /** Part 143: approval MAKES the account. What it made, for the record. */
    accountEmail: { type: String, default: '' },
    createdUserId: { type: String, default: '' },
    emailStatus: { type: String, default: '' },
    emailRecipient: { type: String, default: '' },
    emailAttemptedAt: { type: Date, default: null },
    /**
     * Oct 29 2026: what they said when asked "Will you be looking at the
     * screen, or listening?" -- 'sighted' | 'nonvisual' | null (rather not
     * say, or asked before the question existed). Applied to the account
     * (kadeSight) when it is made; Kade can change it before approving.
     */
    sight: { type: String, enum: ['sighted', 'nonvisual', null], default: null },
    /**
     * Oct 29 2026: phone-only accounts get a call that reads their sign-in
     * and temporary password aloud (kadeWelcomeCall.js). 'placed' | 'failed'
     * | 'off' | '' (never tried). The outcome is Twilio's final word on it,
     * looked up when Kade opens her page. The password itself is never kept.
     */
    welcomeCallStatus: { type: String, default: '' },
    welcomeCallSid: { type: String, default: '' },
    welcomeCallAt: { type: Date, default: null },
    welcomeCallCount: { type: Number, default: 0 },
    welcomeCallOutcome: { type: String, default: '' },
    welcomeCallNote: { type: String, default: '', maxlength: 300 },
    /** Light abuse forensics. */
    ip: { type: String, default: '' },
  },
  { timestamps: true },
);

const KadeAccessRequest =
  mongoose.models.KadeAccessRequest ||
  mongoose.model('KadeAccessRequest', kadeAccessRequestSchema, 'kadeaccessrequests');

module.exports = { KadeAccessRequest };
