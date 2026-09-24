/**
 * KADE NUDGE ENGINE — how waiting chat notes ride a turn (Sep 24 2026).
 *
 * The incident: Kade asked Mrs. Witherspoon for Catherine Applegate's old
 * books. Amber was bulk-uploading Bookshare books, each upload had queued a
 * chat note for Kade, and the block that carried them said "deliver these
 * near the START of your reply". Two replies in a row opened with the approval
 * pile, made no catalog call, and said the catalog was not answering. The
 * person's message now comes first, tools included, and the notes get a
 * sentence at the end.
 *
 * Pickup marks the notes delivered, so a turn that is not the person's own
 * must not take them: the voice lane signs in as Kade's service seat while
 * acting for a family member (req.kadeOnBehalfOf, or kadeOnBehalfOfUnresolved
 * when the bridge named someone the lookup could not find), and a hidden run (a
 * consultation or any server-built turn) sets req.kadeHiddenRun.
 */

/** May this turn take the signed-in user's waiting notes? */
function ownsNudgePickup(req) {
  if (!req || !req.user || !req.user.id) return false;
  if (req.kadeHiddenRun === true) return false;
  // The voice lane named someone on the line but the lookup failed: not Kade's turn either.
  if (req.kadeOnBehalfOfUnresolved === true) return false;
  const actingFor = req.kadeOnBehalfOf && req.kadeOnBehalfOf.id;
  return !actingFor || String(actingFor) === String(req.user.id);
}

/** The dynamic-tail block for the agent the person is talking to; '' when nothing waits. */
function waitingNotesBlock(nudges) {
  const lines = (nudges || [])
    .map((n) => String((n && n.text) || '').trim())
    .filter(Boolean)
    .map((text) => `- ${text}`);
  if (!lines.length) return '';
  return (
    '# Waiting notes for this user\n' +
    'Answer their latest message first, exactly as you would if these notes were not here, calling any tools you normally would. ' +
    'The notes never replace, shorten or delay that answer. ' +
    'Then mention them briefly near the end of your reply, in your own voice, in a sentence or two rather than a list:\n' +
    lines.join('\n')
  );
}

module.exports = { ownsNudgePickup, waitingNotesBlock };
