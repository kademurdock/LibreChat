/* KADE — CHATGPT MEMORY IMPORT (Aug 28 2026, her ask: "make it so my friends
 * can import their memory folders from chatgpt").
 *
 * What this is: the door through which a friend's ChatGPT life walks into
 * Kade-AI. Two lanes, both self-serve from the /import page:
 *
 *  1. MEMORIES (near-free, instant-ish): the person pastes their saved
 *     ChatGPT memory list (Settings → Personalization → Manage memories, or
 *     "list everything you remember about me"). ONE keeper pass distills it
 *     into proper memory cards — shared bucket, so every companion knows.
 *     The export zip is also scanned for any memory-shaped file and that
 *     text rides the same distill when found.
 *
 *  2. CONVERSATIONS (their choice, checkbox, costs real pennies): the export
 *     zip's conversations.json is parsed and stored compactly, then walked
 *     by the SAME keeper brain the history miner uses — dated logbook
 *     entries stamped to the day each conversation actually happened
 *     (source 'gpt-import'), rare still-true cards, shared scope. Their
 *     summer with ChatGPT, remembered the way this platform would have.
 *
 * Safety rails, in the house order:
 *  - IMPORT CAN NEVER ERASE THE PRESENT: deleteMemory is a refusing stub in
 *    both lanes, same as the history miner.
 *  - Shared-bucket writes only — no character's private bucket is touched,
 *    because no Kade character was in those rooms.
 *  - Run-once per imported conversation (status field claim, atomic).
 *  - The zip parser is DEPENDENCY-FREE (EOCD walk + zlib.inflateRaw) with
 *    hard caps: zip ≤ 80 MB, any single inflated file ≤ 150 MB, and ONE
 *    parse at a time platform-wide — a 1 GB heap serving live family chat
 *    does not get to meet a 500 MB JSON.parse.
 *  - Paced (KADE_GPT_IMPORT_DELAY_MS, default 1200) + per-run cap
 *    (KADE_GPT_IMPORT_MAX, default 500 conversations).
 *  - Fail-soft per conversation; kill switch KADE_GPT_IMPORT=0.
 *
 * Dedup comes free twice: re-uploading the same zip skips existing
 * (userId, convoId) rows, and logDiaryEntry's own same-day dedup (Part
 * 92.34) refuses a re-mined entry it already holds.
 */
const zlib = require('zlib');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { processMemory, resolveMemoryAgentLLMConfig } = require('@librechat/api');
const { HumanMessage } = require('@librechat/agents/langchain/messages');
const { getFormattedMemories, setMemory, getUserKey, getUserKeyValues } = require('~/models');
const { logDiaryEntry, centralDateString } = require('~/models/kadeDiary');
const { getAppConfig } = require('~/server/services/Config');

const MAX_ZIP_BYTES = 80 * 1024 * 1024;
const MAX_INFLATED_BYTES = 150 * 1024 * 1024;
const MAX_BUFFER_CHARS = 60000;
const DELAY_MS = Math.max(400, parseInt(process.env.KADE_GPT_IMPORT_DELAY_MS, 10) || 1200);
const MAX_PER_RUN = Math.max(1, parseInt(process.env.KADE_GPT_IMPORT_MAX, 10) || 500);

function importEnabled() {
  return process.env.KADE_GPT_IMPORT !== '0';
}

/* ── The model ─────────────────────────────────────────────────────────── */
const importConvoSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    convoId: { type: String, required: true },
    title: { type: String, default: '' },
    sourceDate: { type: Date, default: null },
    turns: [{ u: Boolean, t: String, _id: false }],
    status: { type: String, default: 'stored' },
    entries: { type: Number, default: 0 },
    minedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
importConvoSchema.index({ userId: 1, convoId: 1 }, { unique: true });
importConvoSchema.index({ userId: 1, status: 1, sourceDate: 1 });
const KadeGptImportConvo =
  mongoose.models.KadeGptImportConvo ||
  mongoose.model('KadeGptImportConvo', importConvoSchema, 'kadegptimportconvos');

/* ── Dependency-free zip reader ────────────────────────────────────────────
 * Reads the central directory from the tail (EOCD signature 0x06054b50),
 * returns only the entries the caller asks for, inflated, size-capped.
 * Standard ChatGPT exports are stored (0) or deflate (8) — anything else is
 * skipped with a note rather than an explosion. */
function readZipEntries(buf, wantedRe) {
  const out = [];
  const tailStart = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= tailStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('That file does not look like a zip (no end-of-directory record).');
  }
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) {
      break;
    }
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (!wantedRe.test(name)) {
      continue;
    }
    if (uncompSize > MAX_INFLATED_BYTES) {
      out.push({ name, error: `too large (${Math.round(uncompSize / 1048576)} MB inflated)` });
      continue;
    }
    /* Local header: 30 fixed bytes + its own (possibly different) name/extra lengths. */
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) {
      out.push({ name, error: 'corrupt local header' });
      continue;
    }
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    try {
      let data;
      if (method === 0) {
        data = comp;
      } else if (method === 8) {
        data = zlib.inflateRawSync(comp, { maxOutputLength: MAX_INFLATED_BYTES });
      } else {
        out.push({ name, error: `unsupported compression method ${method}` });
        continue;
      }
      out.push({ name, data });
    } catch (e) {
      out.push({ name, error: `could not inflate: ${e.message}` });
    }
  }
  return out;
}

/* ── conversations.json → compact turn lists ───────────────────────────────
 * ChatGPT's shape: [{ title, create_time, current_node, mapping: { id:
 * { message: { author: { role }, content: { content_type, parts } },
 * parent, children } } }]. The canonical thread is the walk from
 * current_node back to the root — abandoned edit-branches never ride. */
function flattenChatGptConvo(c) {
  const mapping = c && c.mapping;
  if (!mapping || typeof mapping !== 'object') {
    return null;
  }
  const chain = [];
  let nodeId = c.current_node;
  let hops = 0;
  while (nodeId && mapping[nodeId] && hops < 5000) {
    chain.push(mapping[nodeId]);
    nodeId = mapping[nodeId].parent;
    hops += 1;
  }
  chain.reverse();
  const turns = [];
  for (const node of chain) {
    const m = node && node.message;
    if (!m || !m.author) {
      continue;
    }
    const role = m.author.role;
    if (role !== 'user' && role !== 'assistant') {
      continue;
    }
    if (m.metadata && m.metadata.is_visually_hidden_from_conversation) {
      continue;
    }
    const content = m.content || {};
    let text = '';
    if (Array.isArray(content.parts)) {
      text = content.parts.filter((p) => typeof p === 'string').join('\n');
    } else if (typeof content.text === 'string') {
      text = content.text;
    }
    text = String(text || '').trim();
    if (!text) {
      continue;
    }
    turns.push({ u: role === 'user', t: text.slice(0, 8000) });
  }
  if (turns.length < 2) {
    return null;
  }
  const when = c.create_time ? new Date(c.create_time * 1000) : null;
  return {
    convoId: String(c.conversation_id || c.id || (when ? when.getTime() : Math.random())),
    title: String(c.title || '').slice(0, 200),
    sourceDate: when && !isNaN(when) ? when : null,
    turns,
  };
}

/* One zip parse at a time, platform-wide — the heap is shared with live chat. */
let _parseBusy = false;

async function storeZip({ userId, zipBuffer }) {
  if (!importEnabled()) {
    return { ok: false, error: 'Imports are switched off right now.' };
  }
  if (!zipBuffer || !zipBuffer.length) {
    return { ok: false, error: 'No file arrived. Pick your ChatGPT export zip and try again.' };
  }
  if (zipBuffer.length > MAX_ZIP_BYTES) {
    return {
      ok: false,
      error: `That zip is ${Math.round(zipBuffer.length / 1048576)} MB — bigger than the ${Math.round(
        MAX_ZIP_BYTES / 1048576,
      )} MB this door accepts. Paste your memories instead, and tell Kade — a bigger door can be opened.`,
    };
  }
  if (_parseBusy) {
    return { ok: false, error: 'Another import is being read right this second. Give it a minute and try again.' };
  }
  _parseBusy = true;
  try {
    const entries = readZipEntries(zipBuffer, /(^|\/)(conversations\.json|memories?[^/]*\.(json|txt)|model_set_context[^/]*\.json)$/i);
    const convFile = entries.find((e) => /conversations\.json$/i.test(e.name) && e.data);
    const memFiles = entries.filter((e) => !/conversations\.json$/i.test(e.name) && e.data);
    let stored = 0;
    let skippedExisting = 0;
    let unreadable = 0;
    let memoryText = '';
    for (const mf of memFiles) {
      memoryText += `\n\n[from ${mf.name}]\n` + mf.data.toString('utf8').slice(0, 60000);
    }
    if (convFile) {
      let parsed;
      try {
        parsed = JSON.parse(convFile.data.toString('utf8'));
      } catch (e) {
        return { ok: false, error: 'conversations.json inside that zip would not parse. Re-download the export and try once more.' };
      }
      const list = Array.isArray(parsed) ? parsed : [];
      for (const c of list) {
        const flat = flattenChatGptConvo(c);
        if (!flat) {
          unreadable += 1;
          continue;
        }
        try {
          await KadeGptImportConvo.create({ userId: String(userId), ...flat });
          stored += 1;
        } catch (dupe) {
          skippedExisting += 1;
        }
      }
    }
    return {
      ok: true,
      conversationsStored: stored,
      alreadyHad: skippedExisting,
      unreadable,
      foundMemoryFile: memoryText.trim().length > 0,
      memoryText: memoryText.trim().slice(0, 120000),
      hadConversationsFile: Boolean(convFile),
    };
  } finally {
    _parseBusy = false;
  }
}

/* ── Lane 1: distill a memory list into cards ─────────────────────────── */
function memoriesInstructions() {
  return `You are reading the user's SAVED MEMORY LIST carried over from ChatGPT — the notes another assistant kept about them. Your job is to file the durable, still-true facts as memory cards via set_memory so their companions here know them from day one.

- Group related lines into one card per topic (snake_case key), value written as plain prose a screen reader speaks well.
- Keep: who they are, people and pets and their names, health facts, work/school, preferences, projects, tastes, accessibility needs.
- Skip: instructions about how ChatGPT should behave or format replies (those are about the OLD assistant, not the person), one-off task context, anything phrased as temporary.
- When a line is clearly dated or may have changed ("is looking for a job", "is 34"), file it with its timeframe in the value ("as of their ChatGPT notes, ...") rather than as timeless fact.
- NEVER call delete_memory (it refuses). NEVER touch existing cards — if the existing memory shown to you already covers a line, skip that line.`;
}

async function importMemoriesText({ userId, text }) {
  if (!importEnabled()) {
    return { ok: false, error: 'Imports are switched off right now.' };
  }
  const clean = String(text || '').trim();
  if (clean.length < 10) {
    return { ok: false, error: 'That memory list looks empty. Paste the whole thing, then try again.' };
  }
  const appConfig = await getAppConfig();
  const memoryConfig = appConfig && appConfig.memory;
  if (!memoryConfig || memoryConfig.disabled === true || !memoryConfig.agent?.model) {
    return { ok: false, error: 'The memory writer is not configured on this server.' };
  }
  const llmConfig = await resolveMemoryAgentLLMConfig({
    appConfig,
    memoryConfig,
    userId: String(userId),
    db: { getUserKey, getUserKeyValues },
  });
  const { withKeys, totalTokens } = await getFormattedMemories({ userId: String(userId) });
  let cardsBefore = (withKeys || '').length;
  const stubRes = { headersSent: false };
  await processMemory({
    res: stubRes,
    userId: String(userId),
    messages: [new HumanMessage(`# The user's saved ChatGPT memories:\n\n${clean.slice(0, 100000)}`)],
    validKeys: undefined,
    llmConfig,
    messageId: `gpt-import-mem-${Date.now()}`,
    tokenLimit: memoryConfig.tokenLimit,
    conversationId: `gpt-import-${userId}`,
    memory: withKeys || '',
    totalTokens: totalTokens || 0,
    instructions: memoriesInstructions(),
    forceAgentScope: false,
    setMemory,
    deleteMemory: async () => ({ ok: false, message: 'Imports never delete memory.' }),
    logDiary: async () => ({ ok: false, message: 'Imported memories become cards, not logbook entries.' }),
    user: { id: String(userId) },
  });
  const after = await getFormattedMemories({ userId: String(userId) });
  return { ok: true, grew: (after.withKeys || '').length > cardsBefore };
}

/* ── Lane 2: mine stored conversations into the logbook ────────────────── */
function importMiningInstructions(convoDate, title) {
  /* ⭐ The imperative goes FIRST — the Aug-26 hoist lesson (285b104), measured:
   * the same keeper model called log_diary 1/3 with the do-rules buried and
   * 3/3 with them hoisted. This lane's first live test reproduced exactly
   * that failure (2 conversations, garlic patch and all, ZERO tool calls,
   * polite prose instead), so the do-rule leads here too. */
  return `⭐ YOUR JOB IS TO CALL TOOLS, NOT TO ANSWER IN PROSE. You are a memory writer. For a conversation holding any real life-moment, plan, mood, or genuine rabbit hole, CALL log_diary with the entry. A text reply with no tool call is the failure mode. ONLY pure task chatter — quick lookups, unit conversions, formatting help — earns silence, and silence still means no prose.

You are reading ONE OLD conversation from ${convoDate} that the user had with ChatGPT — a different assistant, before they joined this platform. Their logbook here should remember their life from back then. This is archaeology, not live listening.

WHAT TO WRITE — logbook entries via log_diary (dated to that old day automatically):
- Real life-moments the user shared: things that happened, plans, moods that defined the day.
- Rabbit holes they genuinely dug into with curiosity — ONE light line naming what caught them.
- Story beats of ongoing sagas or projects as they stood THAT day.
Write each entry as one or two plain past-tense sentences, like a friend's journal. No dates inside the text. Most conversations deserve 1 or 2 entries; pure task chatter deserves NONE.

CARDS (set_memory) — RARE: only a durable, clearly STILL-TRUE fact about the user not already in their existing memory, that could not have changed since. Unsure? Logbook entry, not card. Never rewrite or touch an existing card.

NEVER: never call delete_memory (it refuses); never file ChatGPT's own statements or advice as facts about the user; never log the mechanics of the conversation; never invent anything not present. The conversation title was "${title}".`;
}

const control = {
  running: false,
  stopRequested: false,
  userId: null,
  startedAt: null,
  processed: 0,
  entriesLogged: 0,
  errors: 0,
  total: 0,
};

function importStatus() {
  return { ...control, enabled: importEnabled() };
}

async function mineOneImport({ doc, memoryConfig, appConfig }) {
  const userId = String(doc.userId);
  const convoDate = centralDateString(doc.sourceDate || doc.createdAt || new Date());
  let buffer = doc.turns
    .map((t) => `${t.u ? 'User' : 'ChatGPT'}: ${t.t}`)
    .join('\n');
  if (buffer.length > MAX_BUFFER_CHARS) {
    buffer = buffer.slice(0, 20000) + '\n\n[Middle of a long conversation omitted]\n\n' + buffer.slice(-30000);
  }
  const llmConfig = await resolveMemoryAgentLLMConfig({
    appConfig,
    memoryConfig,
    userId,
    db: { getUserKey, getUserKeyValues },
  });
  const { withKeys, totalTokens } = await getFormattedMemories({ userId });
  let logged = 0;
  const stubRes = { headersSent: false };
  await processMemory({
    res: stubRes,
    userId,
    messages: [new HumanMessage(`# The old ChatGPT conversation (from ${convoDate}):\n\n${buffer}`)],
    validKeys: undefined,
    llmConfig,
    messageId: `gpt-import-${doc.convoId}`,
    tokenLimit: memoryConfig.tokenLimit,
    conversationId: `gpt-import-${doc.convoId}`,
    memory: withKeys || '',
    totalTokens: totalTokens || 0,
    instructions: importMiningInstructions(convoDate, doc.title || 'untitled'),
    forceAgentScope: false,
    setMemory,
    deleteMemory: async () => ({ ok: false, message: 'Imports never delete memory.' }),
    logDiary: async ({ text, scope }) => {
      const result = await logDiaryEntry({
        userId,
        agentId: null,
        text,
        scope: 'shared',
        source: 'gpt-import',
        entryDate: convoDate,
      });
      if (result.ok) {
        logged += 1;
      }
      return result;
    },
    user: { id: userId },
  });
  return { logged };
}

async function startImportMining({ userId }) {
  if (!importEnabled()) {
    return { ok: false, error: 'KADE_GPT_IMPORT=0' };
  }
  if (control.running) {
    return { ok: false, error: 'already running', status: importStatus() };
  }
  const appConfig = await getAppConfig();
  const memoryConfig = appConfig && appConfig.memory;
  if (!memoryConfig || memoryConfig.disabled === true || !memoryConfig.agent?.model) {
    return { ok: false, error: 'memory writer not configured' };
  }
  const uid = String(userId);
  const total = await KadeGptImportConvo.countDocuments({ userId: uid, status: 'stored' });
  if (!total) {
    return { ok: false, error: 'nothing stored to read — upload the zip first' };
  }
  control.running = true;
  control.stopRequested = false;
  control.userId = uid;
  control.startedAt = new Date();
  control.processed = 0;
  control.entriesLogged = 0;
  control.errors = 0;
  control.total = Math.min(total, MAX_PER_RUN);

  (async () => {
    try {
      const cursor = KadeGptImportConvo.find({ userId: uid, status: 'stored' })
        .sort({ sourceDate: 1 })
        .cursor();
      for await (const doc of cursor) {
        if (control.stopRequested || control.processed >= MAX_PER_RUN) {
          break;
        }
        /* Atomic claim — only one runner ever holds a doc. */
        const claimed = await KadeGptImportConvo.findOneAndUpdate(
          { _id: doc._id, status: 'stored' },
          { $set: { status: 'claimed' } },
          { new: true },
        );
        if (!claimed) {
          continue;
        }
        try {
          const result = await mineOneImport({ doc: claimed, memoryConfig, appConfig });
          control.processed += 1;
          control.entriesLogged += result.logged || 0;
          await KadeGptImportConvo.updateOne(
            { _id: doc._id },
            { $set: { status: 'done', entries: result.logged || 0, minedAt: new Date() } },
          );
        } catch (e) {
          control.errors += 1;
          control.processed += 1;
          logger.warn(`[gptImport] convo ${doc.convoId} failed (moving on): ${e.message}`);
          await KadeGptImportConvo.updateOne({ _id: doc._id }, { $set: { status: 'error:' + e.message.slice(0, 80) } });
        }
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }
    } catch (e) {
      logger.error('[gptImport] run crashed:', e);
    } finally {
      control.running = false;
    }
  })();

  return { ok: true, started: true, willProcess: control.total };
}

async function importCounts(userId) {
  const uid = String(userId);
  const [stored, done, errors] = await Promise.all([
    KadeGptImportConvo.countDocuments({ userId: uid, status: 'stored' }),
    KadeGptImportConvo.countDocuments({ userId: uid, status: 'done' }),
    KadeGptImportConvo.countDocuments({ userId: uid, status: /^error/ }),
  ]);
  return { stored, done, errors };
}

module.exports = {
  storeZip,
  importMemoriesText,
  startImportMining,
  importStatus,
  importCounts,
  KadeGptImportConvo,
};
