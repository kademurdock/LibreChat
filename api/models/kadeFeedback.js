const mongoose = require('mongoose');

/**
 * KadeFeedback — user-submitted bug reports, feature requests, and general
 * feedback, filed by any agent through the kade_feedback tool (or directly
 * via POST /api/kade/feedback). Attributed to the user who submitted it so
 * Kade can follow up. Status lets Kade track what's been addressed.
 *
 * One document per report:
 *   - user:      the logged-in user who submitted it (ref User)
 *   - category:  'bug' | 'feature' | 'feedback'
 *   - subject:   short title (agent summarizes from the user's words)
 *   - detail:    the full description in the user's own words
 *   - agent:     which agent filed it (name, for context)
 *   - surface:   where it came from ('chat' | 'phone' | 'conversation' | 'web')
 *   - status:    'open' (default) | 'acknowledged' | 'resolved' | 'wontfix'
 */
const kadeFeedbackSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    category: { type: String, enum: ['bug', 'feature', 'feedback'], default: 'feedback', index: true },
    subject: { type: String, maxlength: 200 },
    detail: { type: String, required: true, maxlength: 8000 },
    agent: { type: String, maxlength: 100 },
    surface: { type: String, enum: ['chat', 'phone', 'conversation', 'web'], default: 'chat' },
    status: { type: String, enum: ['open', 'acknowledged', 'resolved', 'wontfix'], default: 'open', index: true },
  },
  { timestamps: true },
);

const KadeFeedback =
  mongoose.models.KadeFeedback || mongoose.model('KadeFeedback', kadeFeedbackSchema, 'kadefeedback');

module.exports = { KadeFeedback };
