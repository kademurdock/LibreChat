const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');
const { KadeGameSave } = require('~/models/kadeGameSave');

const MAX_SLOTS = 20;
const MAX_STATE_CHARS = 32000;

const kadeAdventureJsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['save', 'load', 'list', 'delete'],
      description:
        "'save' writes the current game to a named slot, 'load' restores a slot, 'list' shows the user's save files, 'delete' removes one.",
    },
    slot: {
      type: 'string',
      description: "Save file name, e.g. 'dragon quest' or 'save 1'. Required for save/load/delete.",
    },
    game_title: {
      type: 'string',
      description: "For save: the adventure's title (e.g. 'The Sunken Tower').",
    },
    scene: {
      type: 'string',
      description: "For save: ONE short line describing where the player is right now (shown in the save list), e.g. 'Chapter 3 — outside the goblin mine, level 4, 12 gold'.",
    },
    state: {
      type: 'string',
      description:
        'For save: the COMPLETE game state needed to resume play cold — story premise and summary so far, current location/chapter, character sheet (name, stats, HP, level), full inventory, gold, active quests, key NPCs met, important choices made, and unresolved threads. Write it like a briefing to a future game master who has read nothing else.',
    },
    turns: {
      type: 'integer',
      description: 'For save: rough number of turns played so far (optional bookkeeping).',
    },
  },
  required: ['action'],
};

/**
 * KadeAdventure — persistent save files for text-adventure / RPG play.
 * Free, no key, no cost; state lives in Mongo per user, so saves follow the
 * USER across conversations and even across different game-master agents.
 */
class KadeAdventure extends Tool {
  constructor(fields = {}) {
    super();
    this.userId = fields.userId;
    this.agentName = fields.agentName || '';
    this.name = 'kade_adventure';
    this.description =
      'REAL persistent save files for text-adventure and RPG games — free, no cost. Saves live on the server per USER, ' +
      'so a game saved today can be loaded in any future conversation. ALWAYS offer to save at natural stopping points ' +
      'and before risky moments. On load, resume the game faithfully from the returned state — do not restart or ' +
      "contradict it. When a user says things like 'continue my game' or 'load my save', use action='list' first if " +
      "you don't know their slot names. Save states must be complete enough to resume cold (the state field description " +
      'tells you what to include).';
    this.schema = kadeAdventureJsonSchema;
  }

  async _call(data) {
    const { action, slot, game_title, scene, state, turns } = data || {};
    if (!this.userId) return 'Save files are unavailable (no user on this request).';
    const key = String(slot || '').trim().toLowerCase().slice(0, 60);

    try {
      if (action === 'list') {
        const saves = await KadeGameSave.find({ user: this.userId }).sort({ updatedAt: -1 }).lean();
        if (!saves.length) return 'No save files yet. Start an adventure and save it!';
        return [
          `${saves.length} save file${saves.length === 1 ? '' : 's'}:`,
          ...saves.map(
            (s) =>
              `- "${s.slot}" — ${s.gameTitle}${s.scene ? ` (${s.scene})` : ''} — last played ${new Date(s.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}${s.agentName ? `, GM: ${s.agentName}` : ''}`,
          ),
        ].join('\n');
      }

      if (!key) return "I need a slot name (e.g. 'save 1' or the adventure's name).";

      if (action === 'load') {
        const s = await KadeGameSave.findOne({ user: this.userId, slot: key }).lean();
        if (!s) {
          const names = (await KadeGameSave.find({ user: this.userId }).select('slot').lean()).map((x) => `"${x.slot}"`);
          return `No save file called "${key}".${names.length ? ` Available: ${names.join(', ')}.` : ' No saves exist yet.'}`;
        }
        return [
          `SAVE FILE "${s.slot}" — ${s.gameTitle} (last played ${new Date(s.updatedAt).toDateString()}, ~${s.turns || '?'} turns).`,
          'Resume the game EXACTLY from this state:',
          '',
          s.state,
        ].join('\n');
      }

      if (action === 'delete') {
        const r = await KadeGameSave.deleteOne({ user: this.userId, slot: key });
        return r.deletedCount ? `Deleted save file "${key}".` : `No save file called "${key}".`;
      }

      // default: save
      if (!state || String(state).trim().length < 40) {
        return 'To save I need a real state — include the story so far, location, character sheet, inventory, quests, and open threads.';
      }
      const existing = await KadeGameSave.findOne({ user: this.userId, slot: key }).select('_id').lean();
      if (!existing) {
        const count = await KadeGameSave.countDocuments({ user: this.userId });
        if (count >= MAX_SLOTS) {
          return `Save limit reached (${MAX_SLOTS} slots). Ask the user which old save to delete first (action='list' shows them).`;
        }
      }
      await KadeGameSave.updateOne(
        { user: this.userId, slot: key },
        {
          $set: {
            gameTitle: String(game_title || 'Untitled adventure').slice(0, 120),
            scene: String(scene || '').slice(0, 200),
            state: String(state).slice(0, MAX_STATE_CHARS),
            agentName: this.agentName,
            turns: parseInt(turns, 10) || 0,
          },
        },
        { upsert: true },
      );
      return `Saved to slot "${key}"${existing ? ' (overwrote previous save)' : ''}. The user can load it any time, in any conversation, by asking to continue this game.`;
    } catch (err) {
      logger.warn(`[KadeAdventure] ${action} failed: ${err.message}`);
      return `Save system error: ${err.message}`;
    }
  }
}

module.exports = KadeAdventure;
