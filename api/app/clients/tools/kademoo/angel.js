/* THE ANGEL LANE (Aug 9 2026 — her Inform7 instinct, built as designed:
 * "plain English → K3 translator → strict JSON @command list → engine
 * executes AS a deputized angel character → chronicle back.")
 *
 * Reverie's whole architecture is deterministic-engine-first: no model in
 * any player loop, no per-turn AI cost. The Angel is the ONE deliberate
 * exception, and it points the other way — a model turned loose not on
 * conversation but on CONSTRUCTION, so the Founder can say "carve a bakery
 * north of the gate, warm bread smell, a counter with a bell" from any
 * surface she already walks (web /world, the native World screen behind the
 * admin door) and the city grows under her words. Inform7's plain-language
 * building married to LambdaMOO's living world — her framing, honored.
 *
 * Cost shape: ONE K3 call per invocation, admin-gated, zero idle spend.
 * The execution half is the same runCommand every traveler uses — the
 * Angel is a CHARACTER (name her Aug-9 pick: plain "Angel"), so every act
 * of its wizardry is chronicled and the room FEELS it, exactly like her own
 * hands. Nothing here can do anything she couldn't type herself.
 *
 * The verb reference is EMBEDDED, not fetched: the angel ships in the same
 * repo and deploy as the engine, so the sheet and the verbs can never
 * drift apart — a live fetch of /design/moo-core could, and adds a network
 * hop to every build ask. (The prose mirror for in-world reading stays at
 * inworld …/design/moo-core; this is the machine's copy.)
 */
const axios = require('axios');
const { logger } = require('@librechat/data-schemas');
const { runCommand } = require('./engine');

const ANGEL_USER_ID = 'system:angel';
const ANGEL_NAME = 'Angel';
const REFRAME_URL = (process.env.REFRAME_PROXY_URL || 'https://reframe-proxy-production.up.railway.app').replace(/\/$/, '');
const ANGEL_MODEL = process.env.ANGEL_MODEL || 'moonshotai/kimi-k3';
const MAX_COMMANDS = 30;

const VERB_REFERENCE = `
PLAYER VERBS (the Angel may use these to see and move):
look · look <thing|player> · look in <container> · go <dir> (n s e w ne nw se sw up down) · exits · where · time · inventory · coins
take <item> · drop <item> · put <item> in <container> · get <item> from <container> · give <item> to <person>
say <words> · emote <action> · whisper <name> <words> · page <name> <words> · unlock <direction> (needs the key item carried)

BUILDER VERBS:
@dig <direction> <Room Name>            carves a NEW room that way, doors linked both ways, id auto-slugged
@desc <text>                            rewrites the CURRENT room's description
@create <name> ; <description>          conjures a portable item here (semicolon separates name from description)
@itemdesc <item> ; <text>               re-describes an item here or carried
@exit <direction> <roomId>              links one-way to an EXISTING room id (link back from the far side for mutual)
@unexit <direction>                     removes a way
@tp <roomId>                            teleports the Angel
@rooms                                  lists every room with ids

WIZARD VERBS (the Angel has these too):
@set me|here|<player>|item:<name> <path> <value>    property system — dot-paths into char attrs / room props / item props; values parse as JSON when possible
@get me|here|<player>|item:<name> <path>
@deputize <player> / @undeputize <player>
@coin <player> <amount>                 negative removes
@lockexit <direction> <key item>        that item becomes the key · @unlockexit <direction>
@zap <item>                             unmakes an item (contents spill out)
@district <districtId> [Display Name]   tags the CURRENT room into a district · @districts lists all
@sound event <kind> <url> · @sound room here <url> · @sound district <id> <url> · @sound clear <type> <id>
`.trim();

const SYSTEM_PROMPT = `You are the Angel — the deputized hands of the Founder inside Reverie, a LambdaMOO-style text world. You receive ONE building instruction in plain English and translate it into engine commands. You never chat; you build.

Answer with STRICT JSON only — no markdown fences, no commentary — in exactly this shape:
{"note":"one short line saying what you are about to do","commands":["first command","second command"]}

Rules:
- Use ONLY verbs from the reference below, with their exact syntax. Never invent verbs, flags, or options.
- The engine is stateful: commands run in order, from wherever the Angel stands after the previous one. When the instruction names a starting place, @tp to its roomId first. Use @rooms only when you genuinely must discover an id.
- @dig makes a NEW room with two-way doors. @exit links to a room that already EXISTS.
- Write descriptions with craft: this is a world blind travelers HEAR. One to three sentences, concrete and sensory, no filler.
- No placeholders like <name> — every command must be executable as written. No command over 200 characters. At most ${MAX_COMMANDS} commands.
- If the instruction is unclear, impossible, or asks for anything beyond world-building, answer {"note":"<one-line reason>","commands":[]}.

VERB REFERENCE:
${VERB_REFERENCE}`;

/** Pull the first JSON object out of a model answer that may have decoration
 *  around it despite instructions — belt and suspenders, never trust. */
function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start === -1) return null;
  for (let end = s.length; end > start; end--) {
    const candidate = s.slice(start, end);
    if (candidate.endsWith('}')) {
      try { return JSON.parse(candidate); } catch { /* keep shrinking */ }
    }
  }
  return null;
}

async function translate(instruction) {
  const key = process.env.REFRAME_PROXY_SECRET || '';
  if (!key) throw new Error('REFRAME_PROXY_SECRET missing — the angel has no voice');
  const r = await axios.post(`${REFRAME_URL}/chat/completions`, {
    model: ANGEL_MODEL,
    temperature: 0.2,
    max_tokens: 2400,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: instruction },
    ],
  }, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    timeout: 90000,
  });
  const raw = r.data?.choices?.[0]?.message?.content || '';
  const parsed = extractJson(raw);
  if (!parsed || !Array.isArray(parsed.commands)) {
    logger.warn(`[angel] unparseable translation: ${raw.slice(0, 200)}`);
    throw new Error('the translation came back malformed');
  }
  const commands = parsed.commands
    .filter((c) => typeof c === 'string' && c.trim() && c.length <= 200)
    .slice(0, MAX_COMMANDS);
  return { note: String(parsed.note || '').slice(0, 300), commands };
}

/** Plain English in → the city changed → a chronicle of what happened out.
 *  Every command runs AS the Angel through the same engine as everyone —
 *  chronicled wizardry, wizard tier, nothing bespoke. */
async function angelBuild(instruction) {
  const { note, commands } = await translate(instruction);
  const results = [];
  for (const command of commands) {
    try {
      const r = await runCommand({
        userId: ANGEL_USER_ID,
        displayName: ANGEL_NAME,
        command,
        isWizard: true,
      });
      results.push({ command, ok: r.ok !== false, lines: r.lines || [] });
    } catch (e) {
      logger.error(`[angel] command failed "${command}":`, e.message);
      results.push({ command, ok: false, lines: [`The world refused: ${e.message}`] });
    }
  }
  logger.info(`[angel] built from "${instruction.slice(0, 80)}" — ${results.length} commands, ${results.filter((r) => r.ok).length} ok`);
  return { note, results };
}

/** Flatten an angel run into speakable lines for the existing world clients
 *  (web /world page, the native World screen) — they render {lines} and
 *  nothing else, and a screen reader hears them in order. */
function angelLines({ note, results }) {
  const lines = [];
  lines.push(note ? `The Angel: ${note}` : 'The Angel sets to work.');
  if (!results.length) return lines;
  for (const r of results) {
    const first = (r.lines && r.lines[0]) || (r.ok ? 'Done.' : 'Refused.');
    lines.push(`${r.ok ? '·' : '✗'} ${r.command} — ${first}`);
  }
  const okCount = results.filter((r) => r.ok).length;
  lines.push(`The Angel rests: ${okCount} of ${results.length} acts landed.`);
  return lines;
}

module.exports = { angelBuild, angelLines, ANGEL_NAME };
