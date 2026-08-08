const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

/**
 * KADE WORLD — the doorway into the city (Aug 8 2026, her "set up the legs").
 * Canon docs (read with kade_read_page): /design/moo-workup + /design/moo-world-bible
 * on the inworld proxy. THE CONTRACT this tool enforces by shape: the ENGINE
 * (api/app/clients/tools/kademoo/engine.js) is the referee — every world fact
 * comes back from here, and the character narrates ONLY those facts. The
 * agent holding this tool IS the natural-language layer: terse MUD commands
 * pass through verbatim; spoken intent ("head through the door on my left")
 * gets translated by the agent into engine verbs BEFORE calling. Two layers,
 * one engine, exactly the workup's design.
 */

const worldJsonSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description:
        "ONE engine command: look | look <thing> | look in <box> | go <exit> | take/drop | put <item> in <box> | get <item> from <box> | give <item> to <person> | inventory | say/emote | whisper <name> <words> | page <name> <words> | describe me as <text> | unlock <dir> | where | time | coins | who | chars | newchar <name> | switch <name>. Builder/wizard @verbs exist for the Founder's tier (@dig, @desc, @create, @set, @sound and kin) — pass them through verbatim when the player uses them. Translate natural speech to the closest single command first; chain calls for multi-step intents.",
    },
  },
  required: ['command'],
};

class KadeWorld extends Tool {
  constructor(fields = {}) {
    super();
    this.userId = fields.userId;
    this.userName = fields.userName;
    this.isWizard = fields.isWizard === true;
    this.name = 'kade_world';
    this.description =
      'Perform ONE action in the persistent world (the city beyond the Threshold Gate) as the player’s character, and receive back the FACTS of what happened: what they see, who is present, what changed, and anything that happened around them since their last turn. The world is real and shared — state persists forever, other players and citizens act in it, and everything you narrate MUST come from what this tool returns. NEVER invent rooms, exits, items, people, or events the tool did not report.';
    this.description_for_model =
      this.description +
      ' You are the natural-language layer over a deterministic engine: translate the player’s intent into single engine commands (schema lists them), one call per action, chaining calls when they ask for several steps. Then NARRATE the returned facts in your own voice — atmospheric, performed, in character — without adding or contradicting a single fact. MEANWHILE lines are things that happened around the player while they were away: weave them in naturally. If the engine says a command is unknown or impossible, tell the player honestly what their real options are. The world remembers everything; treat it with the respect a real place deserves.';
    this.schema = worldJsonSchema;
  }

  async _call(data) {
    const { command } = data || {};
    if (!this.userId) {
      return 'The world cannot see who you are (no user context) — the gate stays shut this turn.';
    }
    if (!command || !String(command).trim()) {
      return 'Give the engine one command (look, go <exit>, take <item>, say <words>, ...).';
    }
    try {
      const { runCommand } = require('~/app/clients/tools/kademoo/engine');
      const result = await runCommand({
        userId: this.userId,
        displayName: this.userName,
        command: String(command).slice(0, 400),
        isWizard: this.isWizard,
      });
      const out = [];
      for (const line of result.lines || []) {
        out.push(line);
      }
      if (result.room) {
        const r = result.room;
        out.push(
          `ROOM: ${r.name} [district: ${r.district || 'unknown'}]. ${r.desc}` +
            ` Exits: ${r.exits.join(', ') || 'none'}.` +
            (r.items.length ? ` Here: ${r.items.join(', ')}.` : '') +
            (r.people.length ? ` Present: ${r.people.join(', ')}.` : ' No one else is here.'),
        );
      }
      return out.join('\n');
    } catch (e) {
      logger.error('[KadeWorld] engine error:', e.message);
      return 'The world flickered — that action did not land. Tell the player the ground shivered and invite them to try again.';
    }
  }
}

module.exports = KadeWorld;
