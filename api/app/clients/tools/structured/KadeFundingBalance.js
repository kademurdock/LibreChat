const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');
const { fundingToolDescription, fundingToolSchema } = require('@librechat/api');
const funding = require('~/server/services/kadeFunding');

/**
 * KADE Sep 25 2026 (Part 291) — kade_funding_balance: "how much do I owe Kade?"
 *
 * Her words: "if a user asks an agent, they should look the difference up."
 *
 * Read-only. Identity comes from req, NEVER fields.userId: loadToolWithAuth (handleTools.js)
 * overwrites a passed userId with the signed-in seat, and on voice and phone turns that seat is
 * Kade's own login. The asker is the voice-lane caller (req.kadeOnBehalfOf) or the signed-in person.
 *   - Everyone gets only their own figures.
 *   - An administrator (role read from the DATABASE for the acting person, not req.user.role) may
 *     name someone else, or everyone.
 *   - A voice caller who could not be identified gets nothing looked up.
 *   - The App Review seat hears a neutral "not available".
 *   - A child's account hears its figures gently, with no suggestion of owing anything.
 * Kill switch: KADE_FUNDING=0.
 */
const SELF = /^(me|myself|i|mine|my own|self|my account)$/i;
const EVERYONE = /^(every(one|body)|all|all of them|the family|everyone else)$/i;
const say = (o) => JSON.stringify(o);

class KadeFundingBalance extends Tool {
  /**
   * Part 291 review F22: the App Review seat never gets this tool at all, so its description (which
   * talks about paying Kade back) never reaches that model. Checked for the signed-in seat and for
   * a voice caller acting through another seat. initialize.js asks before it builds the tool list.
   * @param {object} [req]
   * @returns {boolean}
   */
  static hiddenFor(req) {
    if (!req) return false;
    return [req.user, req.kadeOnBehalfOf].some((u) => !!u && funding.isReviewSeat(u));
  }

  constructor(options = {}) {
    super();
    this.name = 'kade_funding_balance';
    this.description = fundingToolDescription;
    this.schema = fundingToolSchema;
    const req = options.req || {};
    const named = req.kadeOnBehalfOf && req.kadeOnBehalfOf.id ? String(req.kadeOnBehalfOf.id) : '';
    this.actingId = named || String((req.user && (req.user.id || req.user._id)) || '');
    this.unresolved = req.kadeOnBehalfOfUnresolved === true;
    /* An unnamed headless voice or phone turn rides Kade's seat with nothing to say so except
     * isTemporary (the help proxy's lcAsk and lcAskStream always set it; her own chats are not
     * temporary). Answering it as Kade would read her figures to a stranger. */
    this.unknownCaller =
      !named && !!req.user && req.user.role === 'ADMIN' && !!req.body && req.body.isTemporary === true;
  }

  async _call(input = {}) {
    if (String(process.env.KADE_FUNDING ?? '1') === '0') {
      return say({ error: "This lookup is switched off right now. Say you can't look it up at the moment; do not guess a figure." });
    }
    if (this.unresolved || this.unknownCaller) {
      logger.warn('[kade_funding_balance] caller not identified; nothing looked up');
      return say({
        error:
          "I couldn't tell whose account this conversation belongs to, so nothing was looked up. Say that plainly and kindly, and suggest asking again from the app. Do not guess a figure.",
      });
    }
    if (!this.actingId) return say({ error: 'Sign in to look this up.' });
    if (funding.reviewSeatIds().includes(this.actingId.toLowerCase())) {
      return say({ available: false, spoken: "That isn't available on this account." });
    }
    try {
      const asker = await funding.account(this.actingId);
      if (!asker) return say({ error: 'Sign in to look this up.' });
      if (asker.reviewSeat) return say({ available: false, spoken: "That isn't available on this account." });
      const period = input && input.period === 'this_month' ? 'this_month' : 'all_time';
      const window = funding.windowFor(period);
      const person = String((input && input.person) || '').trim();
      const aboutSelf =
        !person || SELF.test(person) || (!!asker.name && person.toLowerCase() === asker.name.toLowerCase());
      if (!aboutSelf && !asker.admin) {
        logger.info(`[kade_funding_balance] refused a lookup of someone else (asker ${this.actingId})`);
        return say({
          refused: true,
          spoken: "Only Kade can look up someone else's figures. I can tell you your own if you'd like.",
        });
      }
      if (!aboutSelf && EVERYONE.test(person)) {
        const people = (await funding.fundingPeople(window)).filter((p) => !p.admin).slice(0, 10);
        logger.info(`[kade_funding_balance] asker=${this.actingId} target=everyone people=${people.length}`);
        return say({
          period: period === 'this_month' ? 'this month' : 'all time',
          people: people.map((p) => ({
            name: p.name,
            realCostUSD: p.realCostUSD,
            paidBackUSD: p.paidBackUSD,
            differenceUSD: p.differenceUSD,
            status: p.status,
            spoken: funding.spokenLine(p, { self: false }),
          })),
          note: 'Positive difference: Kade has covered more than they paid back. Negative: they are ahead. Direct provider cost only.',
        });
      }
      let target = asker;
      if (!aboutSelf) {
        const found = await funding.findPerson(person);
        if (found.many) return say({ ask: `More than one person matches "${person}": ${found.many.join(', ')}. Ask which one.` });
        if (!found.one) return say({ error: `Nobody named "${person}" has an account here. Check the name.` });
        target = found.one;
      }
      const s = await funding.fundingSummary(target.id, window);
      if (!s) return say({ error: 'No figures for that account.' });
      const self = target.id === asker.id;
      logger.info(`[kade_funding_balance] asker=${this.actingId} target=${self ? 'self' : target.id} status=${s.status}`);
      return say(funding.forModel(s, { self }));
    } catch (e) {
      logger.warn(`[kade_funding_balance] failed: ${e && e.message}`);
      return say({
        error:
          "The figures aren't answering right now. Say you couldn't look it up and offer to try again. Do not guess a figure.",
      });
    }
  }
}

module.exports = KadeFundingBalance;
