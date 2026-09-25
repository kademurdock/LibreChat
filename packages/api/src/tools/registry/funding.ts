import type { ExtendedJsonSchema } from './definitions';

/* KADE Sep 25 2026 (Part 291): "if a user asks an agent, they should look the difference up."
 * kade_funding_balance answers "how much do I owe Kade?" from the funding ledger: what the asker's
 * use really cost Kade in provider fees, what they have paid her back, and the difference. */
export const fundingToolDescription: string =
  "Look up money between the person on this turn and Kade, the platform owner. Kade pays the real provider bills for everyone's use, and people can pay her back; she records each repayment by hand. Returns what this person's use really cost Kade in provider fees (not the higher amount their prepaid balance is charged), what they have paid her back, the difference, a short breakdown by feature, and a sentence to say. " +
  'Call it whenever someone asks how much they owe Kade, what they have cost her, whether they are paid up or ahead, or how much they have paid back. Never estimate, remember or guess these figures: call the tool every time, and if it fails, say you could not look it up. ' +
  "It returns only the asking person's own figures. Only Kade herself may name someone else, or say everyone; for anyone else it refuses, and you then offer their own figures instead. " +
  "Say the figures plainly and kindly in your own words, in dollars and cents, without pressure or scolding. They are direct provider costs and leave out Kade's fixed monthly bills; say so if asked. The wallet balance is prepaid credit left, not the difference.";

export const fundingToolSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    period: {
      type: 'string',
      enum: ['all_time', 'this_month'],
      description: 'all_time (default) or this_month (since the 1st, US Central time).',
    },
    person: {
      type: 'string',
      maxLength: 120,
      description:
        "Leave empty for the person asking. Kade only: another person's name or email, or 'everyone' for a short list.",
    },
  },
};
