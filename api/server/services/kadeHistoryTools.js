/**
 * PAST TOOL CALLS THAT ARE NOT ON HAND THIS TURN, and the echo they taught (Nov 13 2026).
 *
 * WHAT WAS HEARD. A reply was read aloud with a tool call at the end of it: the reply's own words,
 * then a new line starting "Tool: kade_research, " and an invented result. No tool ran on that
 * turn. The model wrote that line itself.
 *
 * THE TRACE. Tools are attached per turn (services/kadeToolRetrieval.js), so a tool an earlier
 * reply used is often not attached later, most of all after a deploy, because what keeps a tool
 * riding in a conversation lives in memory. formatAgentMessages (@librechat/agents,
 * src/messages/format.ts) is handed the names attached this turn. In an earlier assistant
 * message it keeps the tool calls whose tool is in that set and turns every other one into the
 * text `Tool: <name>, <whole output>`, on a new line at the end of that message's last text part,
 * "for context preservation". So the character's own earlier replies reached the model ending in
 * "Tool: web_search, === Web Results ..." and thousands of characters of raw search output, and
 * the model copied the shape: it ended a new reply with "Tool: <a tool it had>, " and made up the
 * rest. Two more costs of the same step: outside text (web pages, news) sat inside the
 * character's own words, where the keeper's strip (kadeUntrustedTools.js, ToolMessages only)
 * cannot see it; and the stale output was sent again on every later turn.
 *
 * THE FIX, on the way IN to the model (nothing saved is changed by it):
 *   1. dropUnattachedToolCalls(payload, toolSet): before the formatter sees the history, an
 *      earlier assistant message loses the tool calls the formatter would have turned into text.
 *      The reply's own words stay as they are. A tool that is attached keeps its calls and comes
 *      out as a real tool call with its result, as before.
 *   2. stripToolEcho(text, names): a reply already saved with the echo in it has the echo left
 *      out of what the model reads, so it stops teaching the shape.
 * prepareHistory(payload, toolSet) runs both and is what the call sites use.
 * One more use, on the way OUT: cutReplyEcho(message) takes the echo out of a reply that is about
 * to be saved or sent in the final frame (BaseClient.saveMessageToDatabase,
 * scrubMessageForTransmit, and the save of a stopped reply in abortMiddleware.js). The gateway
 * cuts the echo out of the live stream; this is the net under it for the saved copy. That cut is
 * for good, so it is narrower than the one on the way in (THE ECHO RULE, below), and it leaves a
 * note in the message's metadata, `kadeToolEcho`: the tool's name, how many characters went and
 * from how many text parts, never the words. A wrong cut can be found by that note.
 *
 * WHICH CALLS GO. Exactly the ones the formatter would have turned into text, by its own rule,
 * read from format.ts and held to it by kadeHistoryTools.reallib.nodetest.js:
 *   - no tool set handed in: the formatter filters nothing, and neither does this;
 *   - a name in the set stays, and `skill` is a name like any other;
 *   - a name an earlier tool_search result listed stays too (the formatter learns names by
 *     reading those results as it walks, in order), as long as that tool_search call stays
 *     itself: a result that has gone is not there for the formatter to read, so what only it
 *     listed goes with it. Without this the formatter would turn those calls into text after all;
 *   - a tool call with no tool_call object or no name is left where it is: the formatter drops
 *     those itself and writes no text for them;
 *   - anything before the newest summary is left alone: the formatter throws that away unread;
 *   - a handoff call (lc_transfer_to_...) is left alone. Its "output" is the other agent's whole
 *     reply, which the person saw, and the formatter's text is the only way it stays in the
 *     history. Handoffs are switched off on this platform (no "chain" capability).
 * The ids of the calls that go are taken out of the text parts' tool_call_ids, and an emptied
 * list is removed, as the formatter does (it does it in place; this does it on a copy).
 *
 * A MESSAGE LEFT WITH NOTHING. A reply that was only a tool call (no words) has nothing left to
 * say once the call goes. It is handed on with what remains (its thinking, or nothing) and the
 * formatter then emits no message for it, which is what it already does with a reply saved
 * empty. Measured on the real library (the reallib test): no empty assistant message, no "Tool:"
 * text, not one invented word, and the token map stays in step because the payload keeps its
 * length. The person's messages on either side then sit next to each other, as they already do
 * around any empty reply.
 * One shape needs care: a text part that points at calls (tool_call_ids, a lead-in) and has no
 * words. The formatter opens a message at every lead-in. With nothing waiting in front of it,
 * that message has no words, so it is empty unless a call is hung on it; with a picture (or
 * anything else that is not text) waiting, the lead-in goes into that message as an empty text
 * block. Model providers turn both away. Before this pass the formatter's own "Tool:" text filled
 * such parts, and the words an echo strip now leaves out stood in front of them, so these holes
 * open only in a message this pass has changed. So in every message it changes, the parts are
 * walked the way formatAssistantMessage walks them (what it holds back, where it opens a
 * message, which calls it hangs on it, the pointers it takes away itself), and each lead-in with
 * no words loses its pointer when something that is not text is waiting, or when no words are
 * waiting and no call that stays will be hung on the message it would open. The calls after it
 * then go on the message before, as the formatter does with any call after a part that points
 * at nothing. With words waiting, or a call to carry and only words waiting, the pointer stays:
 * the formatter makes a message that says or does something, exactly as before. A message this
 * pass does not change is handed on as it came.
 *
 * THE ECHO RULE (one rule, the same here and in the voice proxy, inworld-tts-proxy/tool-echo.js).
 * At the start of a line (after a line feed, a carriage return, U+2028 or U+2029) or of the text,
 * after any voice directions stamped in front (%%%...%%%, each on its own line, with the blanks
 * after each; LEAD_MAX characters at most): "Tool: ", a tool-like name, a comma, then a space.
 * Here any blank or line break after the comma, or the end of the text, is taken as well, so a
 * copy that was trimmed or that breaks the line after the comma still matches. A name is
 * tool-like when it is a name known for this request, one of the platform's tool names, a name
 * starting "kade_", or letters, digits and underscores with at least one underscore. Everything
 * from that line start to the end of the text (of that text part) is the echo. "Tool: hammer,
 * nails" and "Tools: a list" are not touched.
 * The cut on the way OUT (cutReplyEcho) takes only the platform's tool names and kade_ names
 * written in letters, digits and underscores. A reply that lists tools in that shape loses the
 * line and everything after it for good, so a name that only looks like a tool's is left to the
 * history pass, which changes nothing but what the model reads.
 * No pattern is run over the whole text: the scan walks the line starts once and looks at most
 * LEAD_MAX + NAME_MAX characters into a line, never past its end, so it is linear (timed on
 * 200,000 characters in the tests).
 *
 * Off: KADE_HISTORY_TOOL_DROP=0 (the formatter gets the history as before, and replies are saved
 *      as before). KADE_REPLY_TOOL_ECHO=0 switches off only the cut on the saved reply.
 * Pure: no database, no model, no wait, no log. Any error hands back what came in.
 */
'use strict';

const TOOL_CALL = 'tool_call';
const TEXT = 'text';
const SUMMARY = 'summary';
const TOOL_SEARCH = 'tool_search';
const HANDOFF_PREFIX = 'lc_transfer_to_';

const ECHO_MARK = 'Tool: ';
/* A tool name is short (model providers cap it near 64 characters); the look for its comma stops here. */
const NAME_MAX = 128;
/* A voice direction the apps and the phone bridge stamp in front of a piece of a reply. */
const DIRECTION_MARK = '%%%';
/* Directions and blanks in front of "Tool: ". A direction is a few words (the longest of 7,148
 * real ones is 52 characters); the voice proxy reads the same 240. */
const LEAD_MAX = 240;

/** The platform's own tool names. Names starting "kade_" are covered by rule, not by list. */
const PLATFORM_TOOL_NAMES = new Set([
  'web_search',
  'file_search',
  'execute_code',
  'tool_search',
  'subagent',
  'flux',
]);
const KADE_NAME = /^kade_[A-Za-z0-9_-]+$/;
/* The kade_ names the saved reply's cut takes: letters, digits and underscores, as the voice proxy reads a name. */
const KADE_TOOL_NAME = /^kade_[A-Za-z0-9_]+$/;
const IDENTIFIER = /^[A-Za-z0-9_]+$/;
/* What may be printed in a log line as a tool name. Anything else is counted as "other". */
const LOGGABLE_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const LOG_NAMES_MAX = 8;

function on(env = process.env) {
  return String((env && env.KADE_HISTORY_TOOL_DROP) ?? '') !== '0';
}

function replyCutOn(env = process.env) {
  return on(env) && String((env && env.KADE_REPLY_TOOL_ECHO) ?? '') !== '0';
}

function isPlain(o) {
  if (o === null || typeof o !== 'object') return false;
  const proto = Object.getPrototypeOf(o);
  return proto === Object.prototype || proto === null;
}

/** The names to treat as known, as a Set (or null). Never throws. */
function nameSet(names) {
  if (names == null) return null;
  if (names instanceof Set) return names;
  try {
    return typeof names === 'string' ? new Set([names]) : new Set(names);
  } catch (_) {
    return null;
  }
}

function toolLike(name, known) {
  if (!name) return false;
  if (known && known.has(name)) return true;
  if (PLATFORM_TOOL_NAMES.has(name)) return true;
  if (KADE_NAME.test(name)) return true;
  return name.indexOf('_') !== -1 && IDENTIFIER.test(name);
}

/** The narrower rule of the cut on the way out: the platform's own tool names and kade_ names. */
function platformToolName(name) {
  return PLATFORM_TOOL_NAMES.has(name) || KADE_TOOL_NAME.test(name);
}

/** What starts a line, as a /^.../m pattern reads it: a line feed, a carriage return, U+2028 or U+2029. */
function isLineBreak(c) {
  return c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
}

function isBlank(c) {
  return c === 32 || c === 9;
}

/**
 * Where "Tool: " stands on the line that starts at `i`, once the voice directions in front of it
 * (and the blanks after each) are passed over; -1 when the line does not start that way. Reads
 * LEAD_MAX characters at most and never past the end of the line.
 */
function markAt(text, i) {
  const n = text.length;
  const leadEnd = i + LEAD_MAX;
  let p = i;
  while (p < n && text.charCodeAt(p) === 37) {
    if (!text.startsWith(DIRECTION_MARK, p)) return -1;
    let q = p + DIRECTION_MARK.length;
    for (;;) {
      /* too long to be a direction, or not closed before the text or its line ends */
      if (q > leadEnd || q >= n) return -1;
      const c = text.charCodeAt(q);
      if (isLineBreak(c)) return -1;
      if (c === 37 && text.startsWith(DIRECTION_MARK, q)) break;
      q++;
    }
    p = q + DIRECTION_MARK.length;
    while (p < n && p <= leadEnd && isBlank(text.charCodeAt(p))) p++;
    if (p > leadEnd) return -1;
  }
  return text.startsWith(ECHO_MARK, p) ? p : -1;
}

/** The tool-like name written at `from` and followed by its comma, or ''. Looks at NAME_MAX characters at most. */
function echoNameAt(text, from, accept) {
  const limit = Math.min(text.length, from + NAME_MAX + 1);
  let comma = -1;
  for (let k = from; k < limit; k++) {
    const c = text.charCodeAt(k);
    if (c === 44) {
      comma = k;
      break;
    }
    if (isLineBreak(c)) return '';
  }
  if (comma <= from) return '';
  const after = comma + 1 < text.length ? text.charCodeAt(comma + 1) : -1;
  if (after !== -1 && !isBlank(after) && !isLineBreak(after)) return '';
  const name = text.slice(from, comma);
  return accept(name) ? name : '';
}

/** The first line of `text` that starts an echo whose name `accept` takes: { index, name }, or null. */
function findEcho(text, accept) {
  if (typeof text !== 'string' || text.length <= ECHO_MARK.length) return null;
  if (text.indexOf(ECHO_MARK) === -1) return null;
  const n = text.length;
  let i = 0; /* a line start */
  for (;;) {
    const at = markAt(text, i);
    if (at !== -1) {
      const name = echoNameAt(text, at + ECHO_MARK.length, accept);
      if (name) return { index: i, name };
    }
    while (i < n && !isLineBreak(text.charCodeAt(i))) i++;
    if (i >= n) return null;
    i++;
  }
}

/**
 * Where a model-written tool echo starts in `text` (the start of its line), and the tool it names;
 * null when there is none.
 * @param {string} text
 * @param {Iterable<string>|null} [names] tool names known for this request
 * @returns {{ index: number, name: string } | null}
 */
function findToolEcho(text, names) {
  let known;
  return findEcho(text, (name) => {
    if (known === undefined) known = nameSet(names);
    return toolLike(name, known);
  });
}

/**
 * The same for the cut on the way out, which takes only the platform's tool names and kade_ names.
 * @param {string} text
 * @returns {{ index: number, name: string } | null}
 */
function findReplyEcho(text) {
  return findEcho(text, platformToolName);
}

/**
 * `text` without a model-written tool echo: everything from the echo's line start to the end is
 * left out and the white space before it is trimmed. A text with no echo comes back as it was,
 * the very same string, so a caller can tell that nothing changed.
 * @param {string} text
 * @param {Iterable<string>|null} [names] tool names known for this request
 * @returns {string}
 */
function stripToolEcho(text, names, env = process.env) {
  try {
    if (typeof text !== 'string' || !on(env)) return text;
    const hit = findToolEcho(text, names);
    return hit ? text.slice(0, hit.index).trimEnd() : text;
  } catch (_) {
    return text;
  }
}

/* ---- the formatter's own rules, mirrored (format.ts, formatAgentMessages) ---- */

/** getLatestSummaryBoundary: the last summary part that has words; history before it is not read. */
function latestSummaryBoundary(payload) {
  let boundary = null;
  for (let i = 0; i < payload.length; i++) {
    const message = payload[i];
    if (!message || !Array.isArray(message.content)) continue;
    for (let j = 0; j < message.content.length; j++) {
      const part = message.content[j];
      if (part == null || part.type !== SUMMARY) continue;
      let words = '';
      if (Array.isArray(part.content)) {
        words = part.content
          .map((block) =>
            block !== null && typeof block === 'object' && 'text' in block ? block.text : '',
          )
          .join('')
          .trim();
      }
      if (words.length === 0 && typeof part.text === 'string') words = part.text.trim();
      if (words.length === 0) continue;
      boundary = { messageIndex: i, contentIndex: j };
    }
  }
  return boundary;
}

/** The `tools[].name` strings in one parsed tool_search result, or null. Throws on a bad entry, as the formatter's does. */
function namesInSearchResult(parsed) {
  if (typeof parsed === 'object' && parsed !== null && Array.isArray(parsed.tools)) {
    return parsed.tools.map((t) => t.name).filter((name) => typeof name === 'string');
  }
  return null;
}

/**
 * extractToolNamesFromSearchOutput: the tool names a tool_search result listed. For a result with
 * warnings in front of its JSON the formatter matches /\{[\s\S]*\}/, which is the first "{" to
 * the last "}"; taken here with two index lookups, so a long result with no closing brace cannot
 * be slow.
 */
function searchOutputNames(output) {
  try {
    return namesInSearchResult(JSON.parse(output)) || [];
  } catch (_) {
    const first = output.indexOf('{');
    const last = output.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        return namesInSearchResult(JSON.parse(output.slice(first, last + 1))) || [];
      } catch (_e) {
        /* not JSON either */
      }
    }
  }
  return [];
}

/* Part types the formatter takes no content from when it walks an assistant message
 * (formatAssistantMessage): calls and thinking are handled on their own, the rest are skipped. */
const NO_CONTENT_PARTS = new Set([
  TOOL_CALL,
  TEXT,
  'think',
  'thinking',
  'reasoning',
  'reasoning_content',
  'redacted_thinking',
  'error',
  'agent_update',
  SUMMARY,
]);
const SERVER_TOOL_ID = 'srvtoolu_';
const NOT_SERVER = 0;
const SERVER_RESULT = 1;
const SERVER_SKIPPED = 2;

/**
 * How the formatter reads a part that answers a provider-run tool (Anthropic's web search):
 * NOT_SERVER for any other part; SERVER_RESULT for a result it holds as content of the message
 * (isValidServerToolResult); SERVER_SKIPPED for one it leaves out.
 */
function serverToolPart(part) {
  const id = part.tool_use_id;
  if (typeof id !== 'string' || !id.startsWith(SERVER_TOOL_ID)) return NOT_SERVER;
  if (!('content' in part)) return SERVER_SKIPPED;
  const body = part.content;
  if (Array.isArray(body)) return SERVER_RESULT;
  return body !== null && typeof body === 'object' && body.type === 'web_search_tool_result_error'
    ? SERVER_RESULT
    : SERVER_SKIPPED;
}

/** True for a part the formatter keeps as content of its own (an image, say), not text and not a call. */
function holdsContent(part) {
  return part !== null && typeof part === 'object' && !NO_CONTENT_PARTS.has(part.type);
}

/** The formatter takes this pointer list away itself: every id in it is one it drops (and it drops some). */
function takenByFormatter(ids, ownIds) {
  if (!Array.isArray(ids) || ownIds === null || ownIds.size === 0) return false;
  for (const id of ids) if (!ownIds.has(id)) return false;
  return true;
}

/**
 * Does the formatter read this text part as a lead-in (a part that points at calls) once the
 * pass is done, before anything is decided about the part itself? `goneIds` leave the list of a
 * plain part (an emptied list goes), and the formatter takes away a list of ids it drops itself.
 */
function pointsAfterPass(part, goneIds, ownIds) {
  let ids = part.tool_call_ids;
  if (!ids) return false;
  if (!Array.isArray(ids)) return true;
  if (goneIds.size > 0 && isPlain(part)) {
    ids = ids.filter((id) => !goneIds.has(id));
    if (ids.length === 0) return false;
  }
  return !takenByFormatter(ids, ownIds);
}

function hasOutput(part) {
  const output = part.tool_call.output;
  return output != null && output !== '';
}

/**
 * The part the formatter hangs for each call id. For Anthropic it keeps one part per id: the
 * first, or a later one with a result when the first has none (preferredToolCallParts).
 */
function callOwners(content, start, gone, ownCalls) {
  const owners = new Map();
  for (let j = start; j < content.length; j++) {
    if ((gone && gone.has(j)) || (ownCalls && ownCalls.has(j))) continue;
    const part = content[j];
    if (part == null || part.type !== TOOL_CALL || part.tool_call == null) continue;
    const id = part.tool_call.id;
    if (typeof id !== 'string' || id === '') continue;
    const held = owners.get(id);
    if (held === undefined || (!hasOutput(held) && hasOutput(part))) owners.set(id, part);
  }
  return owners;
}

/**
 * Is a call that stays hung on the message the lead-in at `from` would open? The formatter hangs
 * every call it meets on the last message it opened, until the next lead-in opens another. Only
 * calls hung for every provider count: a provider-run call ("srvtoolu_...") Anthropic holds
 * apart, and of two parts with one id Anthropic hangs one. Reading too little here only takes a
 * pointer away that could have stayed, and the call then goes on the message before.
 */
function callFollows(content, from, gone, goneIds, ownIds, ownCalls, owners) {
  for (let q = from + 1; q < content.length; q++) {
    if ((gone && gone.has(q)) || (ownCalls && ownCalls.has(q))) continue;
    const part = content[q];
    if (part === null || typeof part !== 'object') continue;
    if (serverToolPart(part) !== NOT_SERVER) continue;
    if (part.type === TEXT) {
      if (pointsAfterPass(part, goneIds, ownIds)) return false;
      continue;
    }
    if (part.type !== TOOL_CALL) continue;
    const call = part.tool_call;
    if (call == null || typeof call.name !== 'string' || call.name === '') continue;
    const id = typeof call.id === 'string' && call.id !== '' ? call.id : null;
    if (id !== null && (id.startsWith(SERVER_TOOL_ID) || owners.get(id) !== part)) continue;
    return true;
  }
  return false;
}

/**
 * One pass over the history: drop the tool calls the formatter would turn into text and, when
 * `echo` is set, leave a saved echo out of earlier assistant text. `payload` in the result is the
 * very array handed in when nothing changed.
 */
function walk(payload, toolSet, echo) {
  const stats = { payload, dropped: 0, droppedNames: new Map(), stripped: 0 };
  if (!Array.isArray(payload) || payload.length === 0) return stats;
  /* The formatter: `tools ? new Set(tools) : undefined`. No set, no filtering at all. */
  const usable = toolSet ? new Set(toolSet) : null;
  if (!usable && !echo) return stats;
  const boundary = latestSummaryBoundary(payload);

  /* Every tool name in sight, for telling an echo from a sentence: the attached and the used. */
  let known = null;
  if (echo) {
    known = new Set(usable || []);
    for (const message of payload) {
      if (!message || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        const name = part && part.type === TOOL_CALL && part.tool_call ? part.tool_call.name : null;
        if (typeof name === 'string' && name) known.add(name);
      }
    }
  }

  let out = null;
  for (let i = 0; i < payload.length; i++) {
    const message = payload[i];
    if (!message || message.role !== 'assistant') continue;
    if (boundary && i < boundary.messageIndex) continue;

    if (!isPlain(message)) {
      /* Not a plain object, so not ours to copy: the formatter reads it as before. Learn the
       * names it will learn there (it reads every tool_search result, whatever becomes of the call). */
      if (usable && Array.isArray(message.content)) {
        const from = boundary && i === boundary.messageIndex ? boundary.contentIndex + 1 : 0;
        for (let j = from; j < message.content.length; j++) {
          const part = message.content[j];
          const call = part != null && part.type === TOOL_CALL ? part.tool_call : null;
          if (
            call == null ||
            call.name !== TOOL_SEARCH ||
            typeof call.output !== 'string' ||
            call.output === ''
          )
            continue;
          for (const found of searchOutputNames(call.output)) usable.add(found);
        }
      }
      continue;
    }

    if (typeof message.content === 'string') {
      const hit = echo ? findToolEcho(message.content, known) : null;
      if (!hit) continue;
      stats.stripped += 1;
      out = out || payload.slice();
      out[i] = { ...message, content: message.content.slice(0, hit.index).trimEnd() };
      continue;
    }
    if (!Array.isArray(message.content)) continue;

    const content = message.content;
    const start = boundary && i === boundary.messageIndex ? boundary.contentIndex + 1 : 0;

    /* 1. The calls that go, by the formatter's rule, in the formatter's order. On the way, what
     * the formatter will still do itself once they have gone: the calls it takes away (no name,
     * or a handoff to an agent that is not attached), the ids it then takes out of every pointer,
     * and whether it writes a "Tool: " line into the last text part (the handoff's). */
    let gone = null;
    const goneIds = new Set();
    let ownCalls = null;
    let ownIds = null;
    let ownLine = false;
    if (usable) {
      for (let j = start; j < content.length; j++) {
        const part = content[j];
        if (part == null || part.type !== TOOL_CALL) continue;
        const call = part.tool_call;
        if (call == null) continue;
        const callId = typeof call.id === 'string' && call.id !== '' ? call.id : null;
        /* Malformed: the formatter drops these itself and writes nothing for them. */
        if (call.name == null || call.name === '') {
          (ownCalls = ownCalls || new Set()).add(j);
          if (callId !== null) (ownIds = ownIds || new Set()).add(callId);
          continue;
        }
        const name = call.name;
        if (typeof name === 'string' && name.startsWith(HANDOFF_PREFIX)) {
          if (!usable.has(name)) {
            (ownCalls = ownCalls || new Set()).add(j);
            if (callId !== null) (ownIds = ownIds || new Set()).add(callId);
            ownLine = true;
          }
          continue;
        }
        if (name === TOOL_SEARCH && typeof call.output === 'string' && call.output !== '') {
          /* The formatter reads a tool_search result before it judges the call. A call that
           * stays teaches it the names listed; one that goes is not there to be read. */
          const found = searchOutputNames(call.output);
          if (usable.has(name) || found.indexOf(name) !== -1) {
            for (const listed of found) {
              usable.add(listed);
              if (known) known.add(listed);
            }
            continue;
          }
        } else if (usable.has(name)) {
          continue;
        }
        (gone = gone || new Set()).add(j);
        if (callId !== null) goneIds.add(callId);
        stats.dropped += 1;
        const label = String(name);
        stats.droppedNames.set(label, (stats.droppedNames.get(label) || 0) + 1);
      }
    }

    /* 2. Saved echoes in this message's own text. */
    let cuts = null;
    if (echo) {
      for (let j = start; j < content.length; j++) {
        const part = content[j];
        if (part == null || part.type !== TEXT || typeof part.text !== 'string' || !isPlain(part))
          continue;
        const hit = findToolEcho(part.text, known);
        if (!hit) continue;
        (cuts = cuts || new Map()).set(j, part.text.slice(0, hit.index).trimEnd());
        stats.stripped += 1;
      }
    }
    if (!gone && !cuts) continue;

    /* 3. The new content, walked the way formatAssistantMessage walks it. Parts that stay are the
     * same objects; a part that changes is a copy. */
    /* The text part the formatter still writes its handoff line into: the last one. */
    let lastText = -1;
    if (ownLine) {
      for (let j = content.length - 1; j >= start; j--) {
        if (content[j] != null && content[j].type === TEXT) {
          lastText = j;
          break;
        }
      }
    }
    const owners = callOwners(content, start, gone, ownCalls);
    const next = [];
    /* What the formatter holds since the last lead-in it opened a message for (its
     * currentContent): words, and anything that is not text (a picture, a server tool result). */
    let waitingWords = false;
    let waitingOther = false;
    for (let j = 0; j < content.length; j++) {
      if (gone && gone.has(j)) continue;
      let part = content[j];
      if (j < start || part === null || typeof part !== 'object') {
        next.push(part);
        continue;
      }
      const server = serverToolPart(part);
      if (server !== NOT_SERVER) {
        if (server === SERVER_RESULT) waitingOther = true;
        next.push(part);
        continue;
      }
      if (part.type === TEXT) {
        const cut = cuts !== null && cuts.has(j);
        if (cut) part = { ...part, text: cuts.get(j) };
        const said = (typeof part.text === 'string' && part.text.trim() !== '') || j === lastText;
        let points = false;
        if (part.tool_call_ids && isPlain(part)) {
          let ids = part.tool_call_ids;
          /* As the formatter does: the ids of the calls that went leave the list, an emptied list goes. */
          let emptied = false;
          if (Array.isArray(ids) && goneIds.size > 0) {
            const kept = ids.filter((id) => !goneIds.has(id));
            emptied = kept.length === 0;
            if (kept.length !== ids.length) ids = kept;
          }
          const taken = !emptied && takenByFormatter(ids, ownIds);
          /* A lead-in with no words: it would put an empty text block beside what is waiting,
           * or open a message with nothing in it. */
          const stranded =
            !emptied &&
            !taken &&
            !said &&
            (waitingOther ||
              (!waitingWords && !callFollows(content, j, gone, goneIds, ownIds, ownCalls, owners)));
          if (emptied || stranded || (taken && !said)) {
            const { tool_call_ids: _ids, ...rest } = part;
            part = rest;
          } else {
            if (ids !== part.tool_call_ids) part = { ...part, tool_call_ids: ids };
            points = !taken;
          }
        } else if (part.tool_call_ids) {
          /* Not a plain part, so not ours to copy: the formatter reads it as it is. */
          points = !takenByFormatter(part.tool_call_ids, ownIds);
        }
        if (points) {
          waitingWords = false;
          waitingOther = false;
        } else if (said) {
          waitingWords = true;
        }
      } else if (holdsContent(part)) {
        waitingOther = true;
      }
      next.push(part);
    }
    out = out || payload.slice();
    out[i] = { ...message, content: next };
  }
  if (out) stats.payload = out;
  return stats;
}

/**
 * The history without the earlier tool calls that are not usable this turn. A NEW payload (same
 * length, same order) when something went; the stored messages and their parts are never changed.
 * Hands back `payload` itself when nothing goes, when no tool set is given, when switched off, or
 * on any error.
 * @param {Array<object>} payload what formatAgentMessages is about to be given
 * @param {Set<string>|Iterable<string>|null|undefined} toolSet the tool names attached this turn
 * @returns {Array<object>}
 */
function dropUnattachedToolCalls(payload, toolSet, env = process.env) {
  try {
    if (!on(env)) return payload;
    return walk(payload, toolSet, false).payload;
  } catch (_) {
    return payload;
  }
}

/** A tool name fit to print in a log line, or 'other'. */
function loggableName(name) {
  return typeof name === 'string' && LOGGABLE_NAME.test(name) ? name : 'other';
}

function logNames(counts) {
  const names = [];
  let other = 0;
  for (const name of counts.keys()) {
    if (names.length < LOG_NAMES_MAX && LOGGABLE_NAME.test(name)) names.push(name);
    else other += 1;
  }
  if (other > 0) names.push(`${other} other`);
  return names.join(', ');
}

/**
 * What every place that formats chat history for a model runs first: the drop, then the echo
 * strip on earlier assistant text. The person's own messages are never touched. `line` is one
 * log line with counts and tool names only (never any text), or '' when nothing was dropped or
 * stripped.
 * @param {Array<object>} payload
 * @param {Set<string>|Iterable<string>|null|undefined} toolSet
 * @returns {{ payload: Array<object>, dropped: number, droppedNames: string[], stripped: number, line: string }}
 */
function prepareHistory(payload, toolSet, env = process.env) {
  const none = { payload, dropped: 0, droppedNames: [], stripped: 0, line: '' };
  try {
    if (!on(env)) return none;
    const done = walk(payload, toolSet, true);
    if (done.dropped === 0 && done.stripped === 0) return none;
    const said = [];
    if (done.dropped > 0) {
      said.push(
        `dropped ${done.dropped} past tool call(s) not on hand this turn (${logNames(done.droppedNames)})`,
      );
    }
    if (done.stripped > 0)
      said.push(`stripped ${done.stripped} echoed tool line${done.stripped === 1 ? '' : 's'}`);
    return {
      payload: done.payload,
      dropped: done.dropped,
      droppedNames: [...done.droppedNames.keys()],
      stripped: done.stripped,
      line: `[kadeHistoryTools] ${said.join('; ')}.`,
    };
  } catch (_) {
    return none;
  }
}

/**
 * A reply about to be saved, or sent in the final frame, without a tool echo. Each text part is
 * cut from its own echo line to the end of that part, so words after a real tool call stay; on a
 * message with no parts, `text` is cut the same way. Only the platform's tool names and kade_
 * names count here (the cut is for good). Never on a message the person wrote, and a reply is
 * never cut down to no words at all. `message` in the result is the very object handed in when
 * nothing is cut; otherwise a copy whose metadata carries `kadeToolEcho`: { tool, chars, parts }
 * (the first tool named, how many characters went, from how many parts; never the words).
 * `name` is the tool the first echo named and `chars` how many characters went.
 * @param {object} message
 * @returns {{ message: object, name: string, chars: number }}
 */
function cutReplyEcho(message, env = process.env) {
  const same = { message, name: '', chars: 0 };
  try {
    if (
      !message ||
      typeof message !== 'object' ||
      message.isCreatedByUser !== false ||
      !replyCutOn(env)
    )
      return same;
    let cut = null;
    let name = '';
    let chars = 0;
    let parts = 0;
    if (Array.isArray(message.content) && message.content.length > 0) {
      let content = null;
      let words = false; /* a text part that still says something once the cuts are made */
      for (let j = 0; j < message.content.length; j++) {
        const part = message.content[j];
        if (part == null || part.type !== TEXT || typeof part.text !== 'string') continue;
        let text = part.text;
        const hit = isPlain(part) ? findReplyEcho(text) : null;
        if (hit) {
          const kept = text.slice(0, hit.index).trimEnd();
          (content = content || message.content.slice())[j] = { ...part, text: kept };
          if (!name) name = hit.name;
          chars += text.length - kept.length;
          parts += 1;
          text = kept;
        }
        if (!words && text.trim() !== '') words = true;
      }
      if (!content || !words) return same;
      cut = { ...message, content };
    } else if (typeof message.text === 'string') {
      const hit = findReplyEcho(message.text);
      if (!hit) return same;
      const kept = message.text.slice(0, hit.index).trimEnd();
      if (kept.trim() === '') return same;
      name = hit.name;
      chars = message.text.length - kept.length;
      parts = 1;
      cut = { ...message, text: kept };
    } else {
      return same;
    }
    const meta = message.metadata;
    if (meta == null) {
      cut.metadata = { kadeToolEcho: { tool: name, chars, parts } };
    } else if (typeof meta === 'object' && !Array.isArray(meta)) {
      cut.metadata = { ...meta, kadeToolEcho: { tool: name, chars, parts } };
    }
    return { message: cut, name, chars };
  } catch (_) {
    return same;
  }
}

module.exports = {
  dropUnattachedToolCalls,
  stripToolEcho,
  findToolEcho,
  findReplyEcho,
  prepareHistory,
  cutReplyEcho,
  loggableName,
  on,
  replyCutOn,
  PLATFORM_TOOL_NAMES,
  NAME_MAX,
  LEAD_MAX,
};
