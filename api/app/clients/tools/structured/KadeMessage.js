const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

const messageSchema = {
  type: 'object',
  properties: {
    to: {
      type: 'string',
      description:
        "Who the message is for — their first name as the user says it (e.g. \"Skylee\", \"Wiley\") " +
        'or their email if the user gives one. Must be a person with an account on this site.',
    },
    message: {
      type: 'string',
      description:
        "The message to pass along, in the sender's own words (first person, as the sender said it). " +
        'Keep it faithful — you are the messenger, not the author.',
    },
  },
  required: ['to', 'message'],
};

/**
 * KadeMessage (July 13 2026) — family message-taking. "Tell Skylee her
 * playlist is ready" → the message is held and delivered the next time
 * Skylee shows up: at the start of her next chat, by push/call if that's
 * her notifications preference, and phone calls pick up waiting messages
 * too (the call-memories fetch consumes the same queue).
 *
 * Rides the nudge engine end to end — no new delivery plumbing, no cost.
 * Auto-injected into every agent (see initialize.js, next to kade_feedback).
 */
class KadeMessage extends Tool {
  constructor(fields = {}) {
    super();
    this.userId = fields.userId;
    this.userName = fields.userName || '';
    this.agentName = fields.agentName || 'Agent';
    this.name = 'kade_message';
    this.description =
      'Take a message for another person on this site ("tell Skylee...", "let Kade know...", "pass this to Wiley"). ' +
      'The site holds the message and delivers it the next time they open a chat (or by their own notification choice — ' +
      'push or a call if they set that up; phone calls with a character deliver waiting messages too). ' +
      'Free, instant. Confirm what you are sending before you send it if the wording matters. ' +
      "Deliver messages FAITHFULLY in the sender's words — never rewrite someone's message.";
    this.schema = messageSchema;
  }

  async _call(data) {
    const { to, message } = data || {};
    const text = String(message || '').trim();
    const target = String(to || '').trim();
    if (!text) {
      return 'I need the message itself before I can pass it along.';
    }
    if (!target) {
      return 'Who is this message for? I need a name (or email) of someone on this site.';
    }
    try {
      const { findUser } = require('~/models');
      const mongoose = require('mongoose');
      const User = mongoose.models.User;

      let recipient = null;
      if (target.includes('@')) {
        recipient = await findUser({ email: target.toLowerCase() }, '_id name email');
      } else {
        // Case-insensitive exact-name match; fall back to first-name prefix.
        const safe = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const exact = await User.find({ name: new RegExp(`^${safe}$`, 'i') }, '_id name email').limit(3).lean();
        const candidates = exact.length
          ? exact
          : await User.find({ name: new RegExp(`^${safe}\\b`, 'i') }, '_id name email').limit(3).lean();
        if (candidates.length === 1) {
          recipient = candidates[0];
        } else if (candidates.length > 1) {
          return `I found more than one person named "${target}" here: ${candidates.map((c) => c.name).join(', ')}. Ask the user which one (their email is the sure way).`;
        }
      }
      if (!recipient) {
        return `I couldn't find anyone named "${target}" with an account on this site. Double-check the name, or use their email address.`;
      }
      if (String(recipient._id) === String(this.userId)) {
        return 'That message is addressed to the sender themselves — for self-notes, a reminder works better ("remind me...").';
      }

      // Spam guard: cap undelivered messages per recipient.
      const { KadePendingNudge } = require('~/models/kadeNudge');
      const pendingCount = await KadePendingNudge.countDocuments({
        userId: recipient._id,
        type: 'message',
        deliveredAt: null,
      });
      if (pendingCount >= 20) {
        return `${recipient.name} already has a full mailbox of waiting messages (20). Let them read those first.`;
      }

      let senderName = this.userName;
      if (!senderName) {
        const sender = await findUser({ _id: this.userId }, 'name');
        senderName = (sender && sender.name) || 'Someone';
      }

      const { deliverNudge } = require('~/server/services/kadeNudges');
      const channel = await deliverNudge(
        String(recipient._id),
        `Message from ${senderName}: "${text.slice(0, 1200)}"`,
        { type: 'message', userName: recipient.name },
      );
      logger.info(`[KadeMessage] ${this.userId} -> ${recipient._id} via ${channel} (${text.length} chars)`);
      const how =
        channel === 'chat'
          ? `They'll hear it the moment they next open a chat here (or on their next call with any character).`
          : channel === 'push'
            ? 'It went out as a push notification on their device.'
            : channel === 'call'
              ? 'It is being delivered by a phone call right now.'
              : 'It is queued for them.';
      return `Message for ${recipient.name} is on its way. ${how}`;
    } catch (err) {
      logger.error(`[KadeMessage] failed: ${err.message}`);
      return `I couldn't queue that message — something went wrong server-side (${err.message}).`;
    }
  }
}

module.exports = KadeMessage;
