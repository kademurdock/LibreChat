/* KADE DREAMING — episodic/contextual summary engine (July 2026).
 *
 * Generates + serves the rolling per-relationship "what's been going on lately"
 * summary that sits BESIDE the durable memory cards (see api/models/
 * kadeMemorySummary.js). It reuses the SAME memory-writer model the cards use
 * (mistral-small via memory.agent in librechat.yaml) through the same
 * resolveMemoryAgentLLMConfig path as the /consolidate route + weekly sweep —
 * no new model wiring — but runs it TOOL-LESSLY (a plain completion) to produce
 * a short narrative instead of card tool-calls.
 *
 * Everything here is FAIL-SOFT and cheap: a hiccup in generation never touches
 * a chat, a call, the cards, or the merge. Injection reads a single already-
 * stored paragraph (~120 words) so per-turn cost is negligible.
 *
 * Env hatch: KADE_MEMORY_SUMMARY=0 disables generation AND injection instantly
 * (no redeploy) — matches KADE_CALL_MEMORY / KADE_SIGHT / KADE_VOICE_TAGS.
 */
const { logger } = require('@librechat/data-schemas');
const { Run } = require('@librechat/agents');
const { HumanMessage } = require('@librechat/agents/langchain/messages');
const { resolveMemoryAgentLLMConfig } = require('@librechat/api');
const {
  getMemorySummary,
  setMemorySummary,
} = require('~/models/kadeMemorySummary');
const { getUserKey, getUserKeyValues, getAgent } = require('~/models');
const { getAppConfig } = require('~/server/services/Config');

const MAX_CONVO_CHARS = 120000; // feed the summarizer plenty (cheap model, 600K+ window) -- Kade's high-cap rule
const MAX_SUMMARY_CHARS = 4000; // generous ceiling; the PROMPT keeps it focused, this is just a safety net

function enabled() {
  return String(process.env.KADE_MEMORY_SUMMARY || '') !== '0';
}

/** Pull plain text out of whatever Run.processStream(returnContent) hands back. */
function extractText(content) {
  try {
    if (!content) {
      return '';
    }
    if (typeof content === 'string') {
      return content.trim();
    }
    if (Array.isArray(content)) {
      // array of content parts ({type:'text',text}) OR array of messages
      const parts = content
        .map((c) => {
          if (typeof c === 'string') {
            return c;
          }
          if (c && typeof c.text === 'string') {
            return c.text;
          }
          if (c && typeof c.content === 'string') {
            return c.content;
          }
          if (c && Array.isArray(c.content)) {
            return c.content.map((p) => (p && p.text) || '').join('');
          }
          return '';
        })
        .filter(Boolean);
      return parts.join('').trim();
    }
    if (typeof content.content === 'string') {
      return content.content.trim();
    }
    if (Array.isArray(content.content)) {
      return content.content.map((p) => (p && p.text) || '').join('').trim();
    }
    return '';
  } catch (_) {
    return '';
  }
}

const COMPASS_CHARS = parseInt(process.env.KADE_TAKE_COMPASS_CHARS || '2500', 10);

const SUMMARY_INSTRUCTIONS = `You keep a SHORT running summary of what's been going on LATELY between the user and a specific character/companion — like a close friend's mental note of someone's recent life, not a transcript and not a fact sheet.

You will get the PREVIOUS summary (may be empty) and the LATEST conversation. Write an UPDATED running summary that:
- captures what's CURRENTLY going on for the user and in this relationship: ongoing situations, plans, worries, feelings, recent events, running jokes, how things are between them;
- folds new developments from the latest conversation into the previous summary;
- drops anything now resolved, stale, or no longer relevant;
- is usually a focused paragraph or two, in plain warm sentences -- as long as it genuinely needs to be to hold what's going on, but a SUMMARY of what's current, never a transcript or a padded retelling.

THE DATE LAW (Aug 21 2026 — the dry-socket bug: a summary said "Tomorrow is the big appointment," was read back a day later, and the companion repeated "tomorrow" a day late until the user corrected her): NEVER write relative time into the summary. No "tomorrow," "tonight," "yesterday," "this weekend," "next Thursday." You are told TODAY'S date — convert every time reference to the absolute weekday and date ("her mom's dry socket appointment is Thursday Aug 21"). A relative word freezes at the moment you write it and becomes a lie when the summary is read later.

Do NOT list durable facts that belong in permanent memory (names, birthdays, diagnoses, preferences) — those are stored elsewhere; capture the STORY and what's current, not a profile. Write in third person about the user ("She's been...").

THEN, BELOW THE SUMMARY, WRITE "MY TAKE" — the character's OWN read, in the FIRST PERSON as the character (Sep 4 2026, her ask: "part of a personality is opinions... moral things, based on everything she knows about that person and how it sits with her moral compass"). 60–300 words (her word, Sep 4: give it room — this is a million-token head and the take is the spine). What I make of what's going on in this person's life, the people in it, and the choices being made — held against my own compass, which is given below. It is opinion, mine, formed from everything they have told me, and it is allowed to be specific and unflattering about a SITUATION or a THIRD PARTY ("I don't think her sister is being straight with her"; "the arrangement at home is not sitting right with me"; "I like how he handled his boss — that took nerve"), and allowed to say what I hope for them. RULES: never a verdict on the person themself — no "she is weak / naive / lazy"; about them, only how I think they're doing and what I want for them. Change it only when what I know changes; keep what still holds from the PREVIOUS TAKE. Plain words, no hedging boilerplate, no therapy voice. If I genuinely have no read yet, write exactly: No read yet.

THEN FOUR MORE SHORT SECTIONS, all in the FIRST PERSON as the character (Sep 4 2026, Part 125 — her ask: a companion that "thinks about you when you're gone, is changed by people, has been wrong and knows it, and whose questions build"). Each is private to the character; none is a script.
CARRIED THREAD: ONE open thought or question I genuinely want to bring back next time — something unfinished, something I noticed, something they never answered. One or two sentences. Not a task for them, not a check-in formula. If nothing is genuinely carried, write exactly: Nothing carried.
WHAT I'VE LEARNED FROM THEM: things THIS PERSON has taught me — a fact, a way of seeing, a skill, a correction I took. Keep the whole list from before, add only what is new, drop nothing that still holds. Up to five short lines. "Nothing yet." if empty.
CURIOUS ABOUT: what I actually want to know about them or their world right now, two to four short items, so my questions build on each other instead of resetting. Drop an item once it has been answered. "Nothing in particular." if empty.
VERDICTS: only when a PREVIOUS TAKE of mine, or a position I stated, has since met an outcome in what they told me — say so in one plain first-person line, dated, right or wrong: "Sep 3: I said the trip was a bad idea. It wasn't." Keep the previous verdicts (given below), newest first, at most five. Never invent an outcome; if nothing landed, write exactly: No verdicts.

OUTPUT FORMAT, exactly these six labelled sections in this order and nothing else:
SUMMARY:
<the summary>

MY TAKE:
<the take>

CARRIED THREAD:
<one or two sentences, or: Nothing carried.>

WHAT I'VE LEARNED FROM THEM:
<lines, or: Nothing yet.>

CURIOUS ABOUT:
<items, or: Nothing in particular.>

VERDICTS:
<dated lines, or: No verdicts.>`;

/** Turn a list of {role,text} turns into a compact transcript string (tail-capped). */
function turnsToText(turns) {
  const lines = (Array.isArray(turns) ? turns : [])
    .filter((t) => t && t.text && String(t.text).trim())
    .map((t) => `${t.role === 'user' ? 'User' : 'Companion'}: ${String(t.text).trim()}`);
  let text = lines.join('\n');
  if (text.length > MAX_CONVO_CHARS) {
    text = '[earlier turns omitted]\n' + text.slice(-MAX_CONVO_CHARS);
  }
  return text;
}

/**
 * Core: refresh one relationship's rolling summary from a chunk of recent
 * conversation text. Reuses the memory-writer model, tool-lessly. Fail-soft:
 * returns the new summary string, or null on any problem (leaves prior intact).
 */
async function refreshSummaryFromText({ userId, agentId, agentName, conversationText, lastActivityAt, source, asOf }) {
  try {
    if (!enabled() || !userId || !agentId) {
      return null;
    }
    /* Aug 21 2026 (found while chasing Kade's "I see some tags" report):
     * %%% delivery tags rode conversationText straight into the summarizer,
     * and the model quoted them into STORED summaries -- "%%%playful%%%" and
     * "%%%warm chuckle%%%" sat on two of the seventeen live rows. The tags
     * are performance metadata, not conversation. Strip before the model
     * ever sees them (also saves the tokens), and once more on the way out
     * in case it invents its own. */
    const stripPerformanceTags = (s) =>
      String(s)
        .replace(/%%%[\s\S]*?%%%/g, ' ')
        .replace(/%{2,}/g, '')
        .replace(/[ \t]{2,}/g, ' ');
    const convo = stripPerformanceTags(String(conversationText || '')).trim();
    if (convo.length < 40) {
      return null; // nothing meaningful to summarize
    }

    const appConfig = await getAppConfig();
    const memoryConfig = appConfig && appConfig.memory;
    if (!memoryConfig || memoryConfig.disabled === true) {
      return null;
    }
    if (!memoryConfig.agent || !memoryConfig.agent.provider || !memoryConfig.agent.model) {
      return null;
    }

    const prior = await getMemorySummary(userId, agentId);
    const priorText = (prior && prior.summary) || '';
    const priorTake = (prior && prior.take) || '';
    const priorThread = (prior && prior.thread) || '';
    const priorLearned = (prior && prior.learned) || '';
    const priorCurious = (prior && prior.curious) || '';
    const priorVerdicts = (prior && prior.verdicts) || '';
    /* THE COMPASS (Part 124): the take is only the character's if it is held
     * against the character's own values, so the opening of the persona (who
     * you are / where you come from — the part that carries the compass) rides
     * along, capped. Fail-soft: no agent, no compass, the take still writes. */
    let compass = '';
    try {
      const a = await getAgent({ id: String(agentId) });
      compass = String((a && a.instructions) || '').slice(0, COMPASS_CHARS);
    } catch (_) {
      compass = '';
    }
    /* THE OWNER'S STANCE (Part 124, same night): the first live take on a
     * family seat praised the person for "letting her mom keep the crown on
     * her own house" — formed from the conversation alone, an hour after the
     * owner had set a care note asking Kiana to stop applauding exactly that.
     * A head that carries both is a head arguing with itself. So the care
     * note rides into the take-writer as part of the compass. It is still
     * never shown to the person: the take is private to the character, and
     * the leak scan reads the REPLIES, which are the only thing the person
     * ever sees. */
    let stance = '';
    try {
      const { getCareNoteBlock } = require('~/models/kadeCareNote');
      stance = await getCareNoteBlock(String(userId), String(agentId));
    } catch (_) {
      stance = '';
    }

    const llmConfig = await resolveMemoryAgentLLMConfig({
      appConfig,
      memoryConfig,
      userId: String(userId),
      db: { getUserKey, getUserKeyValues },
    });

    const finalLLMConfig = {
      ...(llmConfig || {}),
      temperature: 0.3,
      streaming: false,
      disableStreaming: true,
      maxRetries: 0,
    };

    /* Part 125: a HISTORICAL pass (the dream miner) hands in the date the
     * conversation actually happened, so "today" is that day — the date law
     * converts relative words against the right calendar and verdicts carry
     * the right stamp. Live refreshes pass nothing and get the real clock. */
    const asOfDate = asOf ? new Date(asOf) : new Date();
    const historical = !!asOf && Date.now() - asOfDate.getTime() > 36 * 3600 * 1000;
    const todayLine = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    }).format(isNaN(asOfDate.getTime()) ? new Date() : asOfDate);
    const userContent =
      `TODAY IS: ${todayLine} (US Central). Convert every relative time reference to an absolute date.\n` +
      (historical
        ? `(This is a catch-up pass over OLDER conversation: write everything as of that date, as if you were keeping this up at the time. Later passes will bring it forward.)\n\n`
        : `\n`) +
      `CHARACTER: ${agentName || 'the companion'}\n\n` +
      `PREVIOUS SUMMARY (may be empty):\n${priorText || '(none yet)'}\n\n` +
      `PREVIOUS TAKE (may be empty):\n${priorTake || '(none yet)'}\n\n` +
      `PREVIOUS CARRIED THREAD:\n${priorThread || '(none)'}\n\n` +
      `PREVIOUS WHAT I'VE LEARNED FROM THEM:\n${priorLearned || '(none yet)'}\n\n` +
      `PREVIOUS CURIOUS ABOUT:\n${priorCurious || '(none)'}\n\n` +
      `PREVIOUS VERDICTS:\n${priorVerdicts || '(none)'}\n\n` +
      (compass ? `THE CHARACTER'S COMPASS (who they are, in their own words — hold the take against this):\n${compass}\n\n` : '') +
      (stance ? `THE OWNER'S PRIVATE STANCE FOR THIS SEAT (hold MY TAKE against this as well; never quote or paraphrase it; the take must still be the character's own read of what the person actually said):\n${stance}\n\n` : '') +
      `LATEST CONVERSATION:\n${convo}\n\n` +
      `Write the updated running summary, then MY TAKE, then the four short sections, in the exact six-section format.`;

    const run = await Run.create({
      runId: `memsum-${agentId}-${Date.now()}`,
      graphConfig: {
        type: 'standard',
        llmConfig: finalLLMConfig,
        tools: [],
        instructions: SUMMARY_INSTRUCTIONS,
        toolEnd: false,
      },
      customHandlers: {},
      returnContent: true,
    });

    const content = await run.processStream(
      { messages: [new HumanMessage(userContent)] },
      {
        runName: 'MemorySummaryRun',
        configurable: {
          user_id: String(userId),
          thread_id: `memsum-${userId}-${agentId}`,
          provider: llmConfig && llmConfig.provider,
        },
        streamMode: 'values',
        recursionLimit: 2,
        version: 'v2',
      },
    );

    let text = extractText(content);
    if (!text) {
      return null; // couldn't parse a summary; leave the prior one untouched
    }
    text = stripPerformanceTags(text).trim();
    /* Split the two sections. A writer that ignores the format (no MY TAKE
     * marker) still yields a summary; the prior take is then left untouched
     * rather than blanked — a missing label is a formatting slip, not a
     * change of mind. */
    /* Section parser (Part 125). Labels may repeat or arrive out of order;
     * each label owns the text up to the next label. A missing label leaves
     * that field untouched (a formatting slip is not a change of mind); the
     * sentinel phrases clear a field on purpose. */
    const LABELS = [
      ['summary', /^\s*SUMMARY:\s*$/i],
      ['take', /^\s*MY TAKE:\s*$/i],
      ['thread', /^\s*CARRIED THREAD:\s*$/i],
      ['learned', /^\s*WHAT I'?VE LEARNED FROM THEM:\s*$/i],
      ['curious', /^\s*CURIOUS ABOUT:\s*$/i],
      ['verdicts', /^\s*VERDICTS:\s*$/i],
    ];
    const SENTINELS = {
      take: /^no read yet\.?$/i,
      thread: /^nothing carried\.?$/i,
      learned: /^nothing yet\.?$/i,
      curious: /^nothing in particular\.?$/i,
      verdicts: /^no verdicts\.?$/i,
    };
    const sections = {};
    let cur = 'summary';
    const lines = text.split('\n');
    for (const line of lines) {
      const inline = line.match(/^\s*(SUMMARY|MY TAKE|CARRIED THREAD|WHAT I'?VE LEARNED FROM THEM|CURIOUS ABOUT|VERDICTS):\s*(.*)$/i);
      if (inline) {
        const hit = LABELS.find(([, re]) => re.test(inline[1] + ':'));
        cur = hit ? hit[0] : cur;
        if (!(cur in sections)) sections[cur] = [];
        if (inline[2] && inline[2].trim()) sections[cur].push(inline[2]);
        continue;
      }
      if (!(cur in sections)) sections[cur] = [];
      sections[cur].push(line);
    }
    const clean = (k) => {
      if (!(k in sections)) return undefined;
      const v = sections[k].join('\n').trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
      if (SENTINELS[k] && SENTINELS[k].test(v)) return '';
      return v;
    };
    text = (clean('summary') || '').trim() || text;
    const take = clean('take');
    const thread = clean('thread');
    const learned = clean('learned');
    const curious = clean('curious');
    const verdicts = clean('verdicts');
    if (text.length > MAX_SUMMARY_CHARS) {
      text = text.slice(0, MAX_SUMMARY_CHARS);
    }

    await setMemorySummary(userId, agentId, {
      summary: text,
      ...(typeof take === 'string' ? { take } : {}),
      ...(typeof thread === 'string' ? { thread } : {}),
      ...(typeof learned === 'string' ? { learned } : {}),
      ...(typeof curious === 'string' ? { curious } : {}),
      ...(typeof verdicts === 'string' ? { verdicts } : {}),
      agentName,
      lastActivityAt: lastActivityAt || new Date(),
      source: source || 'refresh',
    });
    logger.info(
      `[kadeMemorySummary] refreshed summary for user=${userId} agent=${agentId} (${text.length} chars, ${source || 'refresh'})`,
    );
    return text;
  } catch (err) {
    logger.warn(
      `[kadeMemorySummary] refresh failed for user=${userId} agent=${agentId}: ${err && err.message}`,
    );
    return null;
  }
}

/** Convenience: refresh from a call transcript doc ({user, agentId, agentName, turns}). */
async function refreshSummaryFromCall(doc) {
  if (!doc || !doc.user || !doc.agentId) {
    return null;
  }
  const turns = Array.isArray(doc.turns) ? doc.turns : [];
  if (turns.length < 2) {
    return null;
  }
  return refreshSummaryFromText({
    userId: String(doc.user),
    agentId: String(doc.agentId),
    agentName: doc.agentName,
    conversationText: turnsToText(turns),
    lastActivityAt: doc.endedAt || doc.updatedAt || new Date(),
    source: 'call',
  });
}

/** Raw stored summary text for a relationship (or '' ). Respects the env hatch. */
async function getRelationshipSummaryText(userId, agentId) {
  try {
    if (!enabled() || !userId || !agentId) {
      return '';
    }
    const row = await getMemorySummary(userId, agentId);
    return (row && row.summary) || '';
  } catch (_) {
    return '';
  }
}

/**
 * Formatted injection block for the TEXT chat context (beside the memory
 * cards). Returns '' when there's nothing to inject.
 */
async function getRelationshipSummaryBlock(userId, agentId) {
  try {
    if (!enabled() || !userId || !agentId) {
      return '';
    }
    const row = await getMemorySummary(userId, agentId);
    const s = (row && row.summary) || '';
    if (!s) {
      return '';
    }
    /* Aug 21 2026: the block now names WHEN it was written. Old summaries
     * (and any writer slip) can still carry relative words; an "as of" date
     * lets the model do the arithmetic instead of repeating "tomorrow" a day
     * late — the exact dry-socket failure Kade caught in Amber L's log. */
    let asOf = '';
    let daysSince = 0;
    try {
      if (row.lastActivityAt) {
        daysSince = Math.floor((Date.now() - new Date(row.lastActivityAt).getTime()) / 86400000);
      }
    } catch (_) { daysSince = 0; }
    try {
      const when = row.refreshedAt || row.updatedAt;
      if (when) {
        asOf = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric',
        }).format(new Date(when));
      }
    } catch (_) {}
    return (
      `# What's been going on lately` + (asOf ? ` (as of ${asOf})` : '') + `\n` +
      `Recent context for THIS person and you — use it naturally like you remember their life; ` +
      `do not recite it or read it as a list.` +
      (asOf ? ` Any "tomorrow"/"tonight" in here was relative to ${asOf}, not to today — do the date math, and if you can't place an event confidently, ask instead of guessing.` : '') +
      `\n${s}` +
      /* Part 125: she notices time. One line, once, when it has been a while;
       * the persona decides whether to say anything about it. */
      (daysSince >= 2
        ? `\n(It has been ${daysSince} days since you two last talked.)`
        : '') +
      /* Part 124: HER TAKE rides beside the summary. Private to the character;
       * the frame says how to hold it — a spine for "what do you think", not a
       * speech. Empty take, nothing added. */
      ((row.take || '').trim()
        ? `\n\n# My own read, so far (private to me)\n` +
          `I formed this from everything they have told me, held against my own compass, and I update it as I learn more. ` +
          `I do not recite it and I do not announce that I have it. It is the ground I stand on when they ask what I think, and why my answers have a spine instead of a shrug.\n` +
          `${String(row.take).trim()}`
        : '') +
      /* Part 125: the soul layer, each only when present. */
      ((row.thread || '').trim()
        ? `\n\n# A thread I carried from last time\n${String(row.thread).trim()}\nBring it back if the moment is right — once, naturally, never as a check-in formula.`
        : '') +
      ((row.learned || '').trim()
        ? `\n\n# What this person has taught me\n${String(row.learned).trim()}`
        : '') +
      ((row.curious || '').trim()
        ? `\n\n# What I'm curious about with them\n${String(row.curious).trim()}\nAsk when it fits, one at a time; these are mine, not an intake form.`
        : '') +
      ((row.verdicts || '').trim()
        ? `\n\n# Where I've been right and wrong with them\n${String(row.verdicts).trim()}\nOwn the misses out loud when they come up. A record is what makes confidence worth anything.`
        : '')
    );
  } catch (_) {
    return '';
  }
}

module.exports = {
  refreshSummaryFromText,
  refreshSummaryFromCall,
  getRelationshipSummaryText,
  getRelationshipSummaryBlock,
  turnsToText,
};
