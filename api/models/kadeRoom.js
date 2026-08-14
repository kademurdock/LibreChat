const mongoose = require('mongoose');

/**
 * KadeRoom — the Debate & Roleplay Room (July 3 2026, Kade's ask).
 * A room drops 2-6 characters (marketplace agents) together with a topic and
 * optional ground rules; the room's owner can jump in as themselves whenever
 * they want. Agent turns are generated round-robin straight against
 * OpenRouter using each agent's own persona instructions + model — no chat
 * conversations are created. Bespoke to Kade's instance (like kadeUsage /
 * kadeAsset), so it lives here with no TS build step.
 */
const kadeRoomSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    topic: { type: String, default: '' },
    goals: { type: String, default: '' },
    /** Porch mode (Aug 14 2026, idea 29): 'debate' (default) or 'porch' —
     * the same round-robin machine with the competition removed. Existing
     * rooms carry no mode and read as 'debate' everywhere. */
    mode: { type: String, default: 'debate' },
    agents: {
      type: [
        {
          _id: false,
          agentId: String,
          name: String,
          avatar: String,
          /** agent's default TTS voice + rate at room-creation time (radio-play mode) */
          voiceId: String,
          rate: Number,
        },
      ],
      default: [],
    },
    transcript: {
      type: [
        {
          _id: false,
          speaker: String, // 'user' or an agentId
          name: String,
          text: String,
          ts: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    /** Conversation Hall (public greatest hits): shared rooms show for all signed-in ADULT accounts */
    shared: { type: Boolean, default: false },
    sharedTitle: { type: String, default: '' },
    sharedAt: { type: Date, default: null },
    /** Party mode (July 31 2026, her "I want both"): join-by-code guests,
     * Parlor-style — friends debate in the SAME room with the cast. */
    partyCode: { type: String, default: '', index: true },
    guests: {
      type: [
        {
          _id: false,
          userId: String,
          name: String,
          joinedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    /** round-robin pointer into agents[] for whoever speaks next */
    nextIdx: { type: Number, default: 0 },
    /** total agent turns generated in this room */
    turnCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

const KadeRoom =
  mongoose.models.KadeRoom || mongoose.model('KadeRoom', kadeRoomSchema, 'kaderooms');

module.exports = { KadeRoom };
