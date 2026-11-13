'use strict';
/* KADE Nov 12 2026 (platform audit, phase 3 A1): the spoken name of every tool, owned here.
 *
 * The iPhone (MessageSendingService.spokenToolName) and Android (ChatToolNames.known) each carried
 * the same 27-entry map, and both had fallen 13 tools behind, so VoiceOver and TalkBack said
 * "kade known" and "kade phone pairing". The server now sends the label beside each tool step:
 *
 *   { "event": "on_run_step", "data": { ...untouched... }, "kade": { "toolLabels": ["web search"] } }
 *
 * toolLabels[i] names data.stepDetails.tool_calls[i]. The key is absent on steps that are not tool
 * calls. An empty string means "no name, stay quiet". `data` is never touched, so a label can never
 * be saved into message content. kadeToolLabels.nodetest.js fails when a new kade_ tool has no label.
 *
 * Kill switch: KADE_TOOL_LABELS=0 sends the plain frame (the apps fall back to their own maps). */

const LABELS = Object.freeze({
  web_search: 'web search',
  file_search: 'your files',
  kade_read_page: 'reading a page',
  kade_lookup: 'looking it up on the web',
  kade_research: 'deep research',
  kade_memory_search: 'memory',
  kade_living_memory: 'memory',
  kade_weather: 'weather',
  kade_news: 'news',
  kade_wikipedia: 'wikipedia',
  kade_notify: 'reminder',
  kade_feedback: 'feedback',
  kade_code: 'code',
  kade_errand: 'errand',
  kade_phone_call: 'phone',
  kade_call_me: 'call',
  kade_location: 'location',
  kade_help: 'help pages',
  kade_joke: 'jokes',
  kade_games: 'game parlor',
  kade_lyrics: 'lyrics',
  kade_media: 'media',
  kade_transcribe: 'transcript',
  kade_make_file: 'file',
  kade_message: 'message',
  kade_funding_balance: 'cost and paid back',
  flux: 'picture',
  fal_studio: 'studio',
  // The 13 the apps never had. Wording is a first guess; change it here and every client follows.
  kade_known: 'what I know',
  kade_phone_pairing: 'phone pairing',
  kade_studio: 'studio',
  kade_task: 'task',
  kade_recall: 'recall',
  kade_library: 'library',
  kade_library_requests: 'library requests',
  kade_family_history: 'family history',
  kade_adventure: 'adventure',
  kade_approvals: 'approvals',
  kade_council: 'council',
  kade_drive_pc: 'your computer',
  kade_world: 'world',
});

/** Same fallback the apps use: drop the action suffix, underscores to spaces, split camel case. */
function spokenToolLabel(raw) {
  let base = typeof raw === 'string' ? raw : '';
  const cut = base.indexOf('_action_');
  if (cut !== -1) {
    base = base.slice(0, cut);
  }
  if (Object.prototype.hasOwnProperty.call(LABELS, base)) {
    return LABELS[base];
  }
  let out = '';
  for (const ch of base) {
    if (ch === '_') {
      out += ' ';
    } else if (ch !== ch.toLowerCase() && out && !out.endsWith(' ')) {
      out += ' ' + ch.toLowerCase();
    } else {
      out += ch;
    }
  }
  return out.trim();
}

/**
 * The frame to send for an on_run_step event. Tool steps get a `kade` sibling beside `event`
 * and `data`; `data` is never touched, so nothing here can be saved into message content.
 * toolLabels[i] names data.stepDetails.tool_calls[i]. Fail-soft: any trouble sends the plain frame.
 */
function withToolLabels(frame) {
  try {
    if (process.env.KADE_TOOL_LABELS === '0') {
      return frame;
    }
    const details = frame && frame.data && frame.data.stepDetails;
    const calls =
      details && details.type === 'tool_calls' && Array.isArray(details.tool_calls)
        ? details.tool_calls
        : null;
    if (!calls || calls.length === 0) {
      return frame;
    }
    const toolLabels = calls.map((call) =>
      spokenToolLabel((call && (call.name || (call.function && call.function.name))) || ''),
    );
    return { ...frame, kade: { ...(frame.kade || {}), toolLabels } };
  } catch {
    return frame;
  }
}

module.exports = { LABELS, spokenToolLabel, withToolLabels };
