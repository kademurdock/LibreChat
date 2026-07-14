const axios = require('axios');
const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

const kadeCodeJsonSchema = {
  type: 'object',
  properties: {
    language: {
      type: 'string',
      enum: ['python', 'bash', 'node'],
      description:
        "Runtime: 'python' (default) for math/data/logic, 'bash' for shell commands, 'node' for JavaScript.",
    },
    code: {
      type: 'string',
      description:
        'Complete, self-contained program that PRINTS its result (print / echo / console.log) — only what it prints comes back. No input() prompts.',
    },
  },
  required: ['code'],
};

const RUNNERS = { python: 'python3', bash: 'bash', node: 'node' };
const EXT = { python: 'py', bash: 'sh', node: 'js' };

/**
 * KadeCode — run a small program in Forge's ISOLATED devbox sandbox and return
 * what it prints. ALWAYS sandboxed (scrubbed env — NO secrets, no GITHUB_PAT,
 * reachable by the code); the devbox enforces a hard timeout + 100KB output cap.
 * CPU only, no GPU, no per-call cost. The free, self-hosted "code interpreter"
 * for the fleet. Forge's own secret-carrying git actions are separate + untouched.
 */
class KadeCode extends Tool {
  constructor(fields = {}) {
    super();
    this.name = 'kade_code';
    this.description =
      'Run a small program (Python, Bash, or Node) in a safe sandbox and get back what it prints. ' +
      'Use for real math, data crunching, text processing, quick calculations, or building small things — ' +
      'anything better done by RUNNING code than guessing. Free, no cost. Runs isolated with a ~20s limit and ' +
      'has NO access to the site, its data, or any secrets. Make the code PRINT its result. Present the output ' +
      'to the user in plain, screen-reader-friendly words — never a raw code dump.';
    this.schema = kadeCodeJsonSchema;
    this.userId = fields.userId;
    this.agentName = fields.agentName;
  }

  async _call(data) {
    const lang = RUNNERS[data && data.language] ? data.language : 'python';
    const code = String((data && data.code) || '').trim();
    if (!code) {
      return 'I need some code to run.';
    }
    const base = process.env.KADE_CODE_DEVBOX_URL;
    const secret = process.env.KADE_CODE_DEVBOX_SECRET;
    if (!base || !secret) {
      logger.warn('[kade_code] devbox not configured (KADE_CODE_DEVBOX_URL / KADE_CODE_DEVBOX_SECRET)');
      return 'The code runner is not available right now.';
    }
    const auth = { Authorization: `Bearer ${secret}` };
    const fname = `kadecode_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${EXT[lang]}`;
    try {
      await axios.post(`${base}/files`, { path: fname, content: code }, { headers: auth, timeout: 15000 });
      const run = await axios.post(
        `${base}/exec`,
        { command: `${RUNNERS[lang]} ${fname}`, sandboxed: true, timeout_ms: 20000 },
        { headers: auth, timeout: 30000 },
      );
      axios
        .delete(`${base}/files`, { params: { path: fname }, headers: auth, timeout: 8000 })
        .catch(() => {});

      const r = run.data || {};
      const out = String(r.stdout || '').trim();
      const err = String(r.stderr || '').trim();
      try {
        logger.info(
          `[kade_code] ${lang} user=${this.userId || '?'} agent=${this.agentName || '?'} exit=${r.exit_code} killed=${!!r.killed} outBytes=${out.length + err.length}`,
        );
      } catch (_) {
        /* noop */
      }

      let msg = '';
      if (r.killed) {
        msg += 'The code was stopped for hitting the time or output limit. ';
      }
      if (out) {
        msg += `Output:\n${out}`;
      }
      if (err) {
        msg += `${out ? '\n\n' : ''}Errors / warnings:\n${err}`;
      }
      if (!out && !err) {
        msg += `The code ran (exit code ${r.exit_code == null ? 0 : r.exit_code}) but printed nothing — remember to PRINT the result you want back.`;
      }
      return msg.trim();
    } catch (e) {
      const detail = (e.response && e.response.data && e.response.data.error) || e.message || 'unknown error';
      logger.warn(`[kade_code] failed: ${detail}`);
      return `The code couldn't run: ${detail}`;
    }
  }
}

module.exports = KadeCode;
