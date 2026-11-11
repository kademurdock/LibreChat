const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

/* Kept identical to kadePhonePairingSchema in packages/api/src/tools/registry/definitions.ts. */
const kadePhonePairingSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['code', 'redeem', 'list', 'unpair'],
      description:
        'code = "pair my phone": make a one-time code (in the app). redeem = on a phone call, the caller says "my pairing code is ...". list = which phones are paired. unpair = "unpair my phone".',
    },
    code: { type: 'string', description: 'redeem. The six digits they said.' },
    ending: { type: 'string', description: 'unpair. Last four digits of the phone to unpair, or "all". Leave out if only one is paired.' },
  },
  required: ['action'],
};

/**
 * KADE PHONE PAIRING, the character's side (Nov 11 2026). The engine is
 * api/server/services/kadePhonePairing.js: a one-time code made in the signed-in app pairs the
 * phone a caller rings from with that account. The tool says what to tell them in `tellThem`.
 */
class KadePhonePairing extends Tool {
  constructor(fields = {}) {
    super();
    this.name = 'kade_phone_pairing';
    this.description =
      'Pair a phone number with their account. "Pair my phone" in the app: action code, then say the code once, digit by digit. ' +
      'On a phone call, "my pairing code is ...": action redeem with the digits. Also list paired phones and unpair. Say only what the tool tells you.';
    this.schema = kadePhonePairingSchema;
    this.req = fields.req;
  }

  async _call(data) {
    const pairing = require('~/server/services/kadePhonePairing');
    const action = String((data && data.action) || '');
    try {
      const run = { code: pairing.makeCode, redeem: pairing.redeem, list: pairing.list, unpair: pairing.unpair }[action];
      if (!run) return 'Unknown action. Use code, redeem, list or unpair.';
      const out = await run({ req: this.req, code: data && data.code, ending: data && data.ending });
      if (!out.ok) return `FAILED: ${out.error}. Tell them plainly.`;
      return `OK: ${out.tellThem}`;
    } catch (e) {
      logger.warn('[KadePhonePairing] ' + (e && e.message));
      return 'FAILED: phone pairing had a problem just now. Tell them plainly and do not say anything was paired.';
    }
  }
}

module.exports = KadePhonePairing;
