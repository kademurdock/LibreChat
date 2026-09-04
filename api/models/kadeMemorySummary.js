/**
 * KADE DREAMING — rolling EPISODIC / contextual memory (July 2026).
 *
 * Durable memory CARDS answer "who is this person" (facts: dad_health,
 * cat_kasper). This collection answers "what's been GOING ON with us lately"
 * (the story: the trip they're nervous about, the fight that's blowing over,
 * the project they keep mentioning). One short rolling summary per
 * RELATIONSHIP = per (user, agentId). It sits BESIDE the cards, injected on a
 * tiny token budget, and is refreshed by a background pass (calls immediately,
 * text on the nightly sweep) — the "dreaming" model.
 *
 * Bespoke to Kade's instance; plain Mongoose so it needs no data-schemas TS
 * build, matching kadeVoicePref / kadeCallTranscript.
 */
const mongoose = require('mongoose');

const kadeMemorySummarySchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    agentId: { type: String, required: true }, // the character/relationship this summary is about
    agentName: { type: String }, // for nicer injection wording; refreshed opportunistically
    summary: { type: String, default: '', maxlength: 8000 }, // rolling paragraph(s); generous ceiling per Kade's high-cap rule
    /* Part 124 (Sep 4 2026) — HER TAKE. The character's own read of this
     * person's life, the people in it and the choices being made, in the
     * FIRST PERSON, formed from everything they have told it and held against
     * the character's own compass. Refreshed with the summary; changes only
     * when what it knows changes. Her ask: "part of a personality is opinions
     * ... moral things like I don't think I like this person, based on
     * everything she knows about that person and how it sits with her moral
     * compass." Never a verdict on the user themself (persona law 4). */
    take: { type: String, default: '', maxlength: 2000 },
    lastActivityAt: { type: Date }, // newest conversation/call turn folded in — drives decay
    refreshedAt: { type: Date }, // when the writer last rewrote this summary
    source: { type: String }, // 'call' | 'nightly' — last thing that touched it (debug)
  },
  { timestamps: true },
);
kadeMemorySummarySchema.index({ userId: 1, agentId: 1 }, { unique: true });

const KadeMemorySummary =
  mongoose.models.KadeMemorySummary ||
  mongoose.model('KadeMemorySummary', kadeMemorySummarySchema, 'kadememorysummaries');

/** One relationship summary, or null. */
async function getMemorySummary(userId, agentId) {
  if (!userId || !agentId) {
    return null;
  }
  return KadeMemorySummary.findOne({ userId: String(userId), agentId: String(agentId) }).lean();
}

/** Upsert the rolling summary for a relationship. Empty/blank summary deletes the row. */
async function setMemorySummary(userId, agentId, { summary, take, agentName, lastActivityAt, source } = {}) {
  if (!userId || !agentId) {
    return null;
  }
  const clean = typeof summary === 'string' ? summary.trim().slice(0, 8000) : '';
  if (!clean) {
    await KadeMemorySummary.deleteOne({ userId: String(userId), agentId: String(agentId) });
    return null;
  }
  const set = { summary: clean, refreshedAt: new Date() };
  if (typeof take === 'string') {
    set.take = take.trim().slice(0, 2000);
  }
  if (agentName) {
    set.agentName = String(agentName).slice(0, 120);
  }
  if (lastActivityAt) {
    set.lastActivityAt = new Date(lastActivityAt);
  }
  if (source) {
    set.source = String(source).slice(0, 24);
  }
  await KadeMemorySummary.updateOne(
    { userId: String(userId), agentId: String(agentId) },
    { $set: set },
    { upsert: true },
  );
  return clean;
}

/** Delete summaries not touched by any activity since `cutoff` (decay). Returns count. */
async function deleteStaleMemorySummaries(cutoff) {
  const res = await KadeMemorySummary.deleteMany({
    $or: [
      { lastActivityAt: { $lt: cutoff } },
      { lastActivityAt: { $exists: false }, updatedAt: { $lt: cutoff } },
    ],
  });
  return (res && (res.deletedCount || 0)) || 0;
}

module.exports = {
  KadeMemorySummary,
  getMemorySummary,
  setMemorySummary,
  deleteStaleMemorySummaries,
};
