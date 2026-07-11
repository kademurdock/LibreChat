/**
 * KADE NUDGE ENGINE (July 11 2026) — proactive, opt-in notifications.
 *
 * Three delivery channels, chosen PER PERSON per nudge type on /notifications:
 *   'chat' (default) — the nudge is queued and the next conversation opens with
 *           it, relayed naturally by whatever character they talk to. Zero
 *           permissions, zero cost, works for every user from day one.
 *   'push' — real Web Push to their installed PWA (iOS 16.4+ Home Screen app,
 *           any Android/desktop browser). Free per message.
 *   'call' — the bridge phones them and a character says it out loud
 *           (existing /outbound-call machinery: AI disclosure, caps,
 *           allowlist, cooldowns all apply). Pennies per call.
 *   'off'  — that nudge type never fires for them.
 */
const mongoose = require('mongoose');

const pushSubSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    endpoint: { type: String, required: true },
    subscription: { type: mongoose.Schema.Types.Mixed, required: true },
    userAgent: { type: String },
  },
  { timestamps: true },
);
pushSubSchema.index({ userId: 1, endpoint: 1 }, { unique: true });

const CHANNELS = ['off', 'chat', 'push', 'call'];

const nudgePrefSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    /** channel for "remind me ..." reminder cards */
    reminders: { type: String, enum: CHANNELS, default: 'chat' },
    /** channel for the yearly birthday nudge */
    birthday: { type: String, enum: CHANNELS, default: 'off' },
    /** "MM-DD" (their birthday, US Central reckoning) */
    birthdayDate: { type: String, default: '' },
    /** 10-digit US number used only for the 'call' channel */
    phone: { type: String, default: '' },
  },
  { timestamps: true },
);

const pendingNudgeSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    text: { type: String, required: true },
    type: { type: String, default: 'reminder' },
    deliveredAt: { type: Date, default: null, index: true },
    /** which channel actually delivered it (chat/push/call), for the page history */
    channel: { type: String, default: 'chat' },
  },
  { timestamps: true },
);

const nudgeStateSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'singleton' },
    lastBirthdayDay: { type: String, default: '' },
  },
  { timestamps: true },
);

const KadePushSub = mongoose.models.KadePushSub || mongoose.model('KadePushSub', pushSubSchema);
const KadeNudgePref = mongoose.models.KadeNudgePref || mongoose.model('KadeNudgePref', nudgePrefSchema);
const KadePendingNudge =
  mongoose.models.KadePendingNudge || mongoose.model('KadePendingNudge', pendingNudgeSchema);
const KadeNudgeState =
  mongoose.models.KadeNudgeState || mongoose.model('KadeNudgeState', nudgeStateSchema);

module.exports = { KadePushSub, KadeNudgePref, KadePendingNudge, KadeNudgeState, CHANNELS };
