const axios = require('axios');
const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

/**
 * KadeDrivePc — the platform's hands on Kade's own Windows PC (August 14 2026).
 *
 * Front door to the bridge's NVDA agent lane (/nvda/*): the same rig that
 * published her App Privacy and shipped the App Store submission, now
 * reachable from her own characters instead of an outside session. The PC
 * side is her NVDA screen reader plus two add-ons (classic NVDA Remote for
 * the key/speech channel, kadeAgentBridge for the whole-page tree and
 * talk-back). The bridge holds the driver, the model router, and the five
 * safety rails; this tool is the remote control Kiana and Forge hold.
 *
 * ⛔ OWNER-GATED, HARD. Kiana talks to the whole family including kids;
 * this tool drives Kade's real computer. It answers ONLY when the
 * authenticated seat AND the acting identity are both Kade's own account
 * (KADE_OWNER_USER_ID) with the ADMIN role. Phone-lane turns that act on
 * behalf of someone else are refused even though they authenticate as the
 * service seat — that is the kadeOnBehalfOf case, checked separately and
 * deliberately. Everyone else gets a plain no. This gate was her explicit
 * security requirement, tested against a non-owner seat before rollout.
 *
 * Secrets: NVDA_TOOL_SECRET (scoped, unlocks only the /nvda lane on the
 * bridge — never the admin BRIDGE_SECRET). Rides BRIDGE_URL like the other
 * bridge tools. The driver's own rails (NVDA+Q hard block, password-field
 * guard, human-pace caps, confirm-before-commit, full transcript) all live
 * bridge-side where no prompt can strip them.
 */

const OWNER_ID_DEFAULT = '6a3cba4d0b0afa92194e42f7';

const driveSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['start', 'status', 'read_screen', 'say', 'press', 'type', 'confirm', 'transcript', 'stop'],
      description:
        "start = begin a run (listen first; drive only when she asks for hands). status = where things stand (works without a run id). read_screen = the whole current page as text, straight from her screen reader. say = speak a short line in her ear through NVDA. press = send key chords. type = type text at the focus. confirm = answer the driver's pending permission question. transcript = the run's receipt so far. stop = end the run now.",
    },
    mode: {
      type: 'string',
      enum: ['listen', 'drive'],
      description:
        "start only. listen (default) = co-listener: hear and read her screen, send NOTHING. drive = the agentic driver runs her errand with its own brain, gating every committing step behind a confirm. Start with listen unless she explicitly asks for hands.",
    },
    goal: {
      type: 'string',
      description:
        "start with mode=drive: the errand, stated fully and concretely ('open Firefox, go to appstoreconnect.apple.com, and read me the review status'). Skip for listen runs.",
    },
    text: {
      type: 'string',
      description: "For say: the short line to speak in her ear (kept under ~300 characters). For type: the exact text to type at the current focus.",
    },
    keys: {
      type: 'string',
      description:
        "press only. One or more key chords separated by spaces, e.g. 'control+home' or 'h h enter' or 'nvda+f7'. Sent in order at a human pace through the connected controller.",
    },
    approve: {
      type: 'boolean',
      description: "confirm only. true = let the driver take the step it asked about; false = refuse it.",
    },
    run_id: {
      type: 'string',
      description: "The run id from start. Needed for confirm, transcript, and stop; status finds the active run on its own if omitted.",
    },
  },
  required: ['action'],
};

class KadeDrivePc extends Tool {
  constructor(fields = {}) {
    super();
    this.name = 'kade_drive_pc';
    this.userId = fields.userId;
    this.agentName = fields.agentName;
    const ownerId = process.env.KADE_OWNER_USER_ID || OWNER_ID_DEFAULT;
    const authedId = String(fields.req?.user?.id || fields.req?.user?._id || '');
    const authedRole = fields.req?.user?.role;
    const actingId = String(fields.userId || '');
    const onBehalf = fields.req?.kadeOnBehalfOf?.id ? String(fields.req.kadeOnBehalfOf.id) : null;
    // Both the seat that logged in AND the person the turn acts for must be
    // the owner. A family phone call rides the service seat but acts as the
    // caller — that turn must never reach this tool's verbs.
    this.ownerOk =
      authedId === ownerId &&
      authedRole === 'ADMIN' &&
      (!actingId || actingId === ownerId) &&
      (!onBehalf || onBehalf === ownerId);
    this.description =
      "Drive or co-listen to Kade's own Windows PC through her NVDA screen reader — read her screen, speak in her ear, press keys, run whole errands with confirm-gated steps. Owner-only: answers to Kade's own account and nobody else's.";
    this.description_for_model =
      'OWNER-ONLY TOOL — it answers ONLY when the person on this very turn is Kade herself on her own seat. For anyone else it refuses; when it refuses, say plainly this one is Kade-only and DROP it — never retry, never roleplay success. ' +
      "WHAT IT IS: her real Windows PC, through her real screen reader (NVDA). read_screen returns the actual page her PC shows; press/type move her real focus and type into real apps; a drive run operates her real computer. Treat every action with that weight. " +
      "THE FLOW: (1) action='start' mode='listen' first — the run hands back CONNECT WORDS; read them to her EXACTLY as given (they are the steps for her NVDA Remote add-on: Client, allow this machine to be controlled, host, port, key). (2) Once her PC is in the channel, read_screen and say work — you see what she sees and can talk in her ear. (3) Hands (press/type) only at her word, one small step at a time, narrating what you did and what her screen reader said back. (4) mode='drive' with a goal only when she asks for a full errand — the bridge's own driver does the stepping and will pause with a permission question before anything that commits; relay that question to her verbatim and send her answer with action='confirm'. (5) status any time (no run id needed); stop the moment she says stop. " +
      "HARD RULES: never claim the PC did something without this tool's receipt for it; if the controller is not connected the tool says so — tell her instead of pretending. The bridge blocks NVDA+Q, refuses typing into password fields, and paces keys — if it blocks you, say so honestly. Nothing about this tool is secret from Kade: narrate what you do as you do it.";
    this.schema = driveSchema;
    this.bridgeUrl = (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');
    this.secret = process.env.NVDA_TOOL_SECRET || '';
  }

  _hdrs() {
    return { 'x-nvda-secret': this.secret, 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' };
  }

  async _call(data) {
    const action = (data && data.action) || 'status';
    if (!this.ownerOk) {
      logger.warn(`[KadeDrivePc] refused: non-owner turn (agent ${this.agentName || '?'})`);
      return "This tool is locked to Kade's own seat and this turn isn't hers. Tell the person plainly that driving the PC is Kade-only, and let it go — do not retry or pretend.";
    }
    if (!this.secret) return 'The PC lane is not configured on this server (missing NVDA_TOOL_SECRET).';
    try {
      if (action === 'start') return await this._start(data || {});
      if (action === 'status') return await this._status(data || {});
      if (action === 'read_screen') return await this._readScreen();
      if (action === 'say') return await this._say(data || {});
      if (action === 'press') return await this._press(data || {});
      if (action === 'type') return await this._type(data || {});
      if (action === 'confirm') return await this._confirm(data || {});
      if (action === 'transcript') return await this._transcript(data || {});
      if (action === 'stop') return await this._stop(data || {});
      return `Unknown action "${action}".`;
    } catch (err) {
      const status = err.response?.status;
      const msg = err.response?.data?.error || err.message;
      if (status === 404 && /controller/i.test(String(msg))) {
        return 'Her PC is not in the channel yet — the NVDA Remote add-on has not connected (or the run ended). No keys were sent. Ask her to connect with the words from start, or start a fresh run.';
      }
      logger.warn(`[KadeDrivePc] ${action} failed: ${msg}`);
      return `The PC lane hit an error (${msg}). Tell Kade honestly and offer to try again.`;
    }
  }

  async _start({ mode, goal }) {
    const m = mode === 'drive' ? 'drive' : 'listen';
    if (m === 'drive' && (!goal || String(goal).trim().length < 8)) {
      return "A drive run needs its errand stated fully in 'goal'. For just watching and reading the screen, use mode='listen'.";
    }
    const r = await axios.post(
      `${this.bridgeUrl}/nvda/start`,
      { mode: m, goal: goal ? String(goal).trim() : undefined, userId: 'kade' },
      { headers: this._hdrs(), timeout: 15000 },
    );
    const { runId, status, connect } = r.data || {};
    return (
      `${m === 'drive' ? 'Drive' : 'Co-listener'} run started (run id ${runId}, status ${status}). ` +
      `Read Kade these connect words EXACTLY: "${connect && connect.words}" ` +
      `Once her add-on connects, the run goes live${m === 'drive' ? ' and the driver begins, pausing for her confirm before any committing step' : " — then read_screen and say are your eyes and voice"}.`
    );
  }

  async _status({ run_id }) {
    if (run_id) {
      const r = await axios.get(`${this.bridgeUrl}/nvda/status`, {
        headers: this._hdrs(), params: { runId: run_id }, timeout: 15000,
      });
      return this._speakStatus(r.data);
    }
    const r = await axios.get(`${this.bridgeUrl}/nvda/active`, {
      headers: this._hdrs(), params: { userId: 'kade' }, timeout: 15000,
    });
    if (!r.data || r.data.active === false) {
      return 'No run is active on her PC right now. Start one with action=start (listen first).';
    }
    return this._speakStatus(r.data);
  }

  _speakStatus(d) {
    const bits = [
      `Run ${d.runId}: ${d.status}${d.mode ? ` (${d.mode})` : ''}${d.goal ? ` — goal: ${d.goal}` : ''}.`,
      d.treeTitle ? `Screen: "${d.treeTitle}" (${d.treeChars} characters of page in hand).` : 'No page tree received yet.',
      d.pendingConfirm ? `⏸ WAITING ON HER PERMISSION to: ${d.pendingConfirm} — relay that question and answer with action=confirm.` : null,
      Array.isArray(d.lastLines) && d.lastLines.length ? `Last heard from her screen reader: ${d.lastLines.join(' | ')}` : null,
      d.connect && d.connect.words ? `Not connected yet — the connect words again, read them exactly: "${d.connect.words}"` : null,
    ].filter(Boolean);
    return bits.join(' ');
  }

  async _readScreen() {
    const r = await axios.get(`${this.bridgeUrl}/nvda/tree`, {
      headers: this._hdrs(), params: { userId: 'kade' }, timeout: 15000,
    });
    const { title, chars, tree } = r.data || {};
    if (!tree) return 'No page tree yet — either no run is active, her PC is not connected, or the add-on has not posted the screen. status will say which.';
    const body = String(tree).slice(0, 7000);
    return `Her screen — "${title || 'untitled'}" (${chars} chars${chars > 7000 ? ', first 7000 shown' : ''}):\n${body}`;
  }

  async _say({ text }) {
    if (!text || !String(text).trim()) return 'say needs the line to speak in text.';
    await axios.post(
      `${this.bridgeUrl}/nvda/say`,
      { text: String(text).trim().slice(0, 300), userId: 'kade' },
      { headers: this._hdrs(), timeout: 15000 },
    );
    return 'Queued — her NVDA will speak it in her ear within a couple of seconds.';
  }

  async _press({ keys }) {
    if (!keys || !String(keys).trim()) return "press needs keys, e.g. 'control+home' or 'h h enter'.";
    const chords = String(keys).trim().split(/[\s,]+/).filter(Boolean);
    const r = await axios.post(
      `${this.bridgeUrl}/nvda/key`,
      { chords, userId: 'kade' },
      { headers: this._hdrs(), timeout: 20000 },
    );
    return `Sent ${chords.length} chord${chords.length === 1 ? '' : 's'} (${chords.join(', ')}) to her PC. ${JSON.stringify(r.data)} — now read_screen or listen for what changed before the next step.`;
  }

  async _type({ text }) {
    if (!text || !String(text).trim()) return 'type needs the text to type.';
    const r = await axios.post(
      `${this.bridgeUrl}/nvda/key`,
      { text: String(text), userId: 'kade' },
      { headers: this._hdrs(), timeout: 20000 },
    );
    return `Typed ${r.data && r.data.typed} characters at her current focus (clipboard-paste, so it lands whole). Verify with read_screen before moving on.`;
  }

  async _confirm({ run_id, approve }) {
    if (!run_id) return 'confirm needs the run_id from start.';
    const r = await axios.post(
      `${this.bridgeUrl}/nvda/confirm`,
      { runId: run_id, approve: approve === true },
      { headers: this._hdrs(), timeout: 15000 },
    );
    if (r.data && r.data.note === 'nothing pending') return 'Nothing was waiting on permission.';
    return approve === true ? 'Approved — the driver takes the step.' : 'Refused — the driver will not take that step.';
  }

  async _transcript({ run_id }) {
    if (!run_id) return 'transcript needs the run_id from start.';
    const r = await axios.get(`${this.bridgeUrl}/nvda/transcript`, {
      headers: this._hdrs(), params: { runId: run_id }, timeout: 15000,
    });
    const t = r.data && r.data.transcript;
    const lines = Array.isArray(t) ? t.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : String(t || '').split('\n');
    const tail = lines.slice(-30).join('\n');
    return `Run ${run_id} transcript (last ${Math.min(30, lines.length)} of ${lines.length} lines):\n${tail}`;
  }

  async _stop({ run_id }) {
    if (!run_id) return 'stop needs the run_id from start. status (no id) will name the active run.';
    await axios.post(
      `${this.bridgeUrl}/nvda/stop`,
      { runId: run_id },
      { headers: this._hdrs(), timeout: 15000 },
    );
    return 'Stopped. The channel is closed; nothing more will reach her PC from this run.';
  }
}

module.exports = KadeDrivePc;
