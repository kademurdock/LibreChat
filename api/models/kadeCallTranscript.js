const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');

/**
 * KadeCallTranscript — persistent transcript of a voice interaction so it can
 * be reviewed later on the /calls page. Phone calls used to be fully ephemeral
 * (the bridge held history in memory and asked with conversationId:"new" every
 * turn, so nothing survived the hang-up); conversation mode saved a normal chat
 * but was never surfaced as a "call." This collection is the single source for
 * the Calls history page. Transcript text only — no audio is stored.
 *
 *   surface: 'phone' | 'web' | 'conversation'
 *   turns:   [{ role: 'user'|'assistant', text, at }]
 *
 * Bespoke to Kade's instance; lives outside data-schemas so it needs no TS build.
 */
const turnSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['user', 'assistant', 'system'], default: 'assistant' },
    text: { type: String, default: '' },
    at: { type: Date },
  },
  { _id: false },
);

const kadeCallTranscriptSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    surface: { type: String, index: true }, // 'phone' | 'web' | 'conversation'
    agentId: { type: String },
    agentName: { type: String },
    callerName: { type: String }, // phone: who was on the line (registration name)
    from: { type: String }, // phone: caller number (loose string, not indexed)
    startedAt: { type: Date },
    endedAt: { type: Date },
    durationSec: { type: Number, default: 0 },
    turnCount: { type: Number, default: 0 },
    turns: { type: [turnSchema], default: [] },
    conversationId: { type: String }, // conversation mode: link back to the chat convo
    mergedConversationId: { type: String }, // phone->history merge: the minted conversation (idempotency marker)
    memoryExtractedAt: { type: Date }, // calls-teach-memory: run-once stamp so the writer fires exactly once per transcript
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true },
);

// Most common query: a user's calls, newest first.
kadeCallTranscriptSchema.index({ user: 1, createdAt: -1 });

const KadeCallTranscript =
  mongoose.models.KadeCallTranscript ||
  mongoose.model('KadeCallTranscript', kadeCallTranscriptSchema, 'kadecalltranscripts');

/**
 * Resolve a LibreChat User _id from an explicit id or an email. Returns null on
 * anything unresolvable. Never throws.
 */
async function resolveUserId({ userId, userEmail }) {
  try {
    if (userId && mongoose.isValidObjectId(userId)) {
      return new mongoose.Types.ObjectId(userId);
    }
    if (userEmail) {
      const User = mongoose.models.User || mongoose.model('User');
      const u = await User.findOne({ email: String(userEmail).toLowerCase().trim() })
        .select('_id')
        .lean();
      if (u && u._id) {
        return u._id;
      }
    }
  } catch (err) {
    /* fall through to null */
  }
  return null;
}

/**
 * Normalize a loose turns array from any caller into clean turn docs.
 */
function normalizeTurns(turns) {
  if (!Array.isArray(turns)) {
    return [];
  }
  const out = [];
  for (const t of turns) {
    if (!t) {
      continue;
    }
    const role = t.role === 'user' ? 'user' : t.role === 'system' ? 'system' : 'assistant';
    const text = typeof t.text === 'string' ? t.text : typeof t.content === 'string' ? t.content : '';
    if (!text.trim()) {
      continue;
    }
    const at = t.at ? new Date(t.at) : undefined;
    out.push({ role, text: text.slice(0, 8000), at });
  }
  return out.slice(0, 400); // hard cap so one call can never balloon a document
}

/**
 * Fire-and-forget writer. NEVER throws — a logging failure must never break a
 * live call or a UI action. Returns the created doc id, or null.
 */
async function logKadeCall({
  userId,
  userEmail,
  surface,
  agentId,
  agentName,
  callerName,
  from,
  startedAt,
  endedAt,
  turns,
  conversationId,
  metadata,
}) {
  try {
    const user = await resolveUserId({ userId, userEmail });
    if (!user) {
      // No account to attach to (e.g. an unregistered guest phone call).
      return null;
    }
    const cleanTurns = normalizeTurns(turns);
    if (!cleanTurns.length) {
      return null;
    }
    const started = startedAt ? new Date(startedAt) : cleanTurns[0].at || new Date();
    const ended = endedAt ? new Date(endedAt) : new Date();
    let durationSec = Math.round((ended.getTime() - started.getTime()) / 1000);
    if (!Number.isFinite(durationSec) || durationSec < 0) {
      durationSec = 0;
    }
    const doc = await KadeCallTranscript.create({
      user,
      surface: surface === 'phone' ? 'phone' : 'conversation',
      agentId,
      agentName,
      callerName,
      from,
      startedAt: started,
      endedAt: ended,
      durationSec,
      turnCount: cleanTurns.length,
      turns: cleanTurns,
      conversationId,
      metadata,
    });
    return doc._id;
  } catch (err) {
    try {
      logger.warn(`[KadeCall] failed to log ${surface} call: ${err && err.message}`);
    } catch (_) {
      /* noop */
    }
    return null;
  }
}

module.exports = { KadeCallTranscript, logKadeCall, resolveUserId, normalizeTurns };
