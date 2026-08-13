const { logger } = require('@librechat/data-schemas');

/**
 * KADE Session 49 (Aug 13 2026) — THE LONG-TASK PING.
 *
 * Her ask, verbatim: "You know how claude has a feature where if you're
 * thinking for a long time claude can send you a notification when it's done?
 * Let's make that an option on this platform too."
 *
 * WHY THIS EXISTS WHEN SOMETHING LIKE IT ALREADY DID. Kiana and Forge have
 * carried a prompt instruction since July 15: "if a request is going to take a
 * real while ... offer to ping her phone when it's done (kade_notify), then
 * actually send that ping." That version depends on the model deciding a task
 * counts as long, remembering the offer, and following through — and PART 47
 * is the receipt on how that goes (Kiana told Amber "done and done" about two
 * reminders she never set). It also only exists on two of ~220 characters, and
 * it fires as part of the final reply, by which point the user is already
 * back. This one is MECHANICAL: a clock and a subscriber count, no model
 * judgement anywhere in the loop, every character for free.
 *
 * THE THREE CONDITIONS, all required:
 *   1. The turn ran at least KADE_LONGTASK_MIN_SEC (default 30 — her pick).
 *   2. NOBODY was attached to the stream when it finished. This is the whole
 *      point of the feature and the reason it lives server-side: when the app
 *      is backgrounded iOS suspends it within ~30s, the SSE connection drops,
 *      and a local notification has nothing left running to fire it. The
 *      generation survives that (the resumable-stream design); the client
 *      doesn't. Zero subscribers at completion IS "they walked away."
 *   3. That person opted in (KadeNudgePref.longTaskPing, default false).
 *
 * Plus a per-user cooldown, so a run of slow turns in a row is one ping and
 * not a pager. Cooldown lives on the user's own prefs doc rather than in
 * memory, so it survives a redeploy — the crash alert's day-stamp was in
 * memory and reset on every deploy.
 *
 * DELIVERY: bridge /notify with adminAlert:true, exactly the lane
 * kadeOwnerAlerts uses. adminAlert skips the AGENTS' shared outreach budget,
 * which is correct here twice over — this isn't an agent reaching out, and one
 * person's slow turns must never eat the family's global daily cap. Quiet
 * hours still hold (non-urgent), which is what she chose for the crash alert
 * an hour earlier and is even more obviously right here: a reply that finished
 * at 3 a.m. is not worth waking up for.
 *
 * FAIL-SOFT THROUGHOUT. This runs immediately after the final event is
 * emitted, on the success path of a real user's turn. A notification hiccup
 * must never mark a completed generation as failed — every path swallows.
 */

const MIN_SECONDS = Number(process.env.KADE_LONGTASK_MIN_SEC || 30);
const COOLDOWN_SECONDS = Number(process.env.KADE_LONGTASK_COOLDOWN_SEC || 120);

/**
 * Spoken-shaped duration. She hears these; "94 seconds" is worse than "a
 * minute and a half" out loud, and "1 minutes" is the kind of thing a screen
 * reader reads exactly as written.
 */
function spokenDuration(totalSeconds) {
  if (totalSeconds < 60) {
    return `${totalSeconds} seconds`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const rest = totalSeconds % 60;
  const unit = minutes === 1 ? 'minute' : 'minutes';
  if (rest < 15) {
    return `${minutes} ${unit}`;
  }
  if (rest < 45) {
    // Always plural here: "one and a half minutes" is correct, "one and a
    // half minute" is what a screen reader would read out and it's wrong.
    return `${minutes} and a half minutes`;
  }
  return `almost ${minutes + 1} minutes`;
}

/**
 * @param {object} args
 * @param {string} args.userId       LibreChat user id — push tokens are linked to these.
 * @param {string} [args.agentName]  Who was working, for the notification title.
 * @param {number} args.startedAtMs  Job creation time (epoch ms).
 * @param {boolean} args.stillWatching  True if any subscriber was attached at completion.
 */
async function pingIfLongAndUnwatched({ userId, agentName, startedAtMs, stillWatching }) {
  try {
    if (!userId || stillWatching) {
      return;
    }
    if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) {
      return;
    }
    const elapsedSec = Math.round((Date.now() - startedAtMs) / 1000);
    if (elapsedSec < MIN_SECONDS) {
      return;
    }

    const { KadeNudgePref } = require('~/models/kadeNudge');
    const prefs = await KadeNudgePref.findOne(
      { userId },
      { longTaskPing: 1, longTaskPingAt: 1 },
    ).lean();
    if (!prefs || prefs.longTaskPing !== true) {
      return; // opt-in, default off — silence is the correct behaviour here
    }

    const lastMs = prefs.longTaskPingAt ? new Date(prefs.longTaskPingAt).getTime() : 0;
    if (Date.now() - lastMs < COOLDOWN_SECONDS * 1000) {
      logger.debug('[kadeLongTaskPing] within cooldown — skipped');
      return;
    }

    const who = String(agentName || 'Your character').slice(0, 30);
    const bridgeUrl = (
      process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app'
    ).replace(/\/$/, '');
    const secret = process.env.BRIDGE_SECRET || process.env.NOTIFY_AGENT_SECRET || '';
    if (!secret) {
      logger.warn('[kadeLongTaskPing] no bridge secret configured — ping skipped');
      return;
    }

    const r = await fetch(`${bridgeUrl}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret,
        agentId: 'kade-longtask-ping',
        agentName: who,
        title: `${who} finished`,
        body: `Your reply is ready — that one took ${spokenDuration(elapsedSec)}.`.slice(0, 300),
        userId: String(userId),
        adminAlert: true,
      }),
    });
    const out = await r.json().catch(() => ({}));
    logger.info(
      `[kadeLongTaskPing] ${elapsedSec}s unwatched turn for ${String(userId).slice(0, 8)}… → sent=${
        out.sent ?? '?'
      }${out.blocked ? ` blocked=${out.blocked}` : ''}`,
    );

    // Stamp the cooldown only on a real delivery. A push blocked by quiet
    // hours or a muted agent shouldn't burn the next two minutes of eligibility.
    if (out && out.sent > 0) {
      await KadeNudgePref.updateOne({ userId }, { $set: { longTaskPingAt: new Date() } });
    }
  } catch (err) {
    logger.warn(`[kadeLongTaskPing] failed (non-fatal): ${err.message}`);
  }
}

module.exports = { pingIfLongAndUnwatched, spokenDuration };
