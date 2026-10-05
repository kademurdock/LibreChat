import { z } from 'zod';
import type { RelationshipImpressions, RelationshipRevision } from '@librechat/data-schemas';

const impression = z.object({
  stance: z.enum(['positive', 'mixed', 'negative', 'unknown']),
  confidence: z.enum(['tentative', 'supported']),
  basis: z.enum([
    'shared-interest',
    'compatibility',
    'care',
    'reliability',
    'dishonesty',
    'coercion',
    'boundary',
    'repair',
  ]),
  reason: z.string().trim().min(1).max(400),
  evidence: z.string().trim().min(8).max(300),
  provenance: z.enum(['interaction', 'reported', 'dream']),
});

export const relationshipImpressionsSchema: z.ZodType<RelationshipImpressions> = z
  .object({
    affinity: impression.optional(),
    trust: impression.optional(),
    ease: impression.optional(),
  })
  .strict();

const dimensions = ['affinity', 'trust', 'ease'] as const;

export function relationshipEvidence({
  userEvidence = '',
  evidenceTurns = [],
  resetAt,
}: {
  userEvidence?: string;
  evidenceTurns?: { text: string; at?: string | Date }[];
  resetAt?: string | Date;
}): string {
  if (!resetAt) return userEvidence;
  const cutoff = new Date(resetAt).getTime();
  return evidenceTurns
    .filter((turn) => turn.at && new Date(turn.at).getTime() > cutoff)
    .map((turn) => turn.text)
    .join('\n\n');
}

function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text.trim();
  const end = text.lastIndexOf('\n', limit);
  const sentence = text.lastIndexOf('. ', limit);
  return text.slice(0, Math.max(end, sentence, Math.floor(limit * 0.65))).trim() + ' […]';
}

/** Explicit authored values win; older personas get a balanced section selection. */
export function characterCompass(instructions: string): string {
  const explicit = instructions.match(
    /<character_compass>\s*([\s\S]*?)\s*<\/character_compass>/i,
  )?.[1];
  if (explicit?.trim()) return explicit.trim();
  const blocks = instructions.split(/(?=^(?:#{1,3}\s+|\d+[.)]?\s+)[A-Z][^\n]{2,100}$)/m);
  const selected: string[] = [];
  for (const block of blocks) {
    const heading = block.split('\n', 1)[0];
    if (
      /who you are|identity|where you come from|values|compass|spine|heavy stuff|off the table|edges|uu alignment/i.test(
        heading,
      )
    )
      selected.push(excerpt(block, 1400));
  }
  if (selected.length) return selected.slice(0, 6).join('\n\n');
  const paragraphs = instructions.split(/\n\s*\n/);
  const identity = excerpt(paragraphs.shift() || '', 1400);
  const values = paragraphs.filter((paragraph) =>
    /\bUU\b|Unitarian|dignity|values|compass|belief|disagree|boundar|ethic|loyalty|respect/i.test(
      paragraph,
    ),
  );
  return [identity, ...values.slice(0, 6).map((paragraph) => excerpt(paragraph, 1000))]
    .filter(Boolean)
    .join('\n\n');
}

/** New relationship evidence must come from this batch, never a generated dream. */
export function reviseRelationship({
  proposed,
  previous = {},
  history = [],
  userEvidence = '',
  evidenceTurns,
  resetAt,
}: {
  proposed?: RelationshipImpressions;
  previous?: RelationshipImpressions;
  history?: RelationshipRevision[];
  userEvidence?: string;
  evidenceTurns?: { text: string; at?: string | Date }[];
  resetAt?: string | Date;
}): { relationship: RelationshipImpressions; relationshipHistory: RelationshipRevision[] } {
  const relationship = { ...previous };
  const revisions = [...history];
  const permittedEvidence = relationshipEvidence({ userEvidence, evidenceTurns, resetAt });
  for (const dimension of dimensions) {
    const next = proposed?.[dimension];
    const prior = previous[dimension];
    if (!next || JSON.stringify(next) === JSON.stringify(prior)) continue;
    if (next.provenance !== 'interaction' || !permittedEvidence.includes(next.evidence)) continue;
    if (dimension === 'trust' && ['compatibility', 'shared-interest'].includes(next.basis))
      continue;
    if (prior) revisions.unshift({ dimension, previous: prior, current: next });
    relationship[dimension] = next;
  }
  return { relationship, relationshipHistory: revisions.slice(0, 12) };
}

export function relationshipBlock(
  relationship?: RelationshipImpressions,
  history: RelationshipRevision[] = [],
): string {
  const lines: string[] = [];
  for (const dimension of dimensions) {
    const view = relationship?.[dimension];
    if (view) lines.push(`${dimension}: ${view.stance} (${view.confidence}). ${view.reason}`);
  }
  if (!lines.length) return '';
  return (
    '# How this relationship feels to me (private to this relationship)\n' +
    'Liking, trust and ease are different. Basic dignity and respectful help remain unconditional. Different interests or values may affect compatibility, never trust by themselves. Corrections, declined advice, privacy choices, frustration and time away are never offences. These are revisable impressions, not objective verdicts or a script to punish anyone.\n' +
    lines.join('\n') +
    (history.length
      ? '\nRecent revisions: ' +
        history
          .slice(0, 3)
          .map(
            (revision) =>
              `${revision.dimension}: ${revision.previous.stance} → ${revision.current.stance}; ${revision.current.reason}`,
          )
          .join(' | ')
      : '')
  );
}

export const RELATIONSHIP_INSTRUCTIONS = `
RELATIONSHIP IMPRESSIONS: privately distinguish AFFINITY (whether I enjoy their company), TRUST (how reliable and candid their conduct has been with me), and EASE (whether I feel comfortable in our exchanges). No forced affection: I can dislike someone, feel wary, or enjoy them while distrusting a particular claim. Different interests or values may change compatibility, affinity or ease when grounded in actual exchanges; disagreement alone never lowers trust or respect. Explain the specific experience behind each impression, be tentative with limited evidence, and revise after repair or new facts. Respect, dignity and useful help remain unconditional. An ordinary correction, declined advice, skepticism about me, frustration, disability, vulnerability, an opt-out, or time away is NEVER an offence or a reason for retaliation. Do not equate agreement with trust or flattery with care. Avoid character diagnoses, blanket moral rankings and invented motives. Only actual interactions count: secondhand allegations or dreams cannot establish this relationship's trust or dislike.
Add a final section RELATIONSHIP: containing a JSON object with optional affinity, trust and ease keys. Each value has stance (positive|mixed|negative|unknown), confidence (tentative|supported), basis (shared-interest|compatibility|care|reliability|dishonesty|coercion|boundary|repair), reason (one specific first-person sentence), evidence (an exact 8–300 character quote from the USER in the LATEST CONVERSATION), and provenance (interaction). Compatibility and shared-interest cannot establish trust. Keep unchanged prior dimensions by omitting them. A changed stance needs new observed evidence; never invent a quote. {} means no new supported impressions. Evidence quotes and all relationship impressions remain private; never put them in the factual SUMMARY or global canon.
Dreaming here means reflecting on real conversation. Dreams, imagined scenes, game events, predictions and hypotheses are never evidence that a person acted or that you met someone. General positions and lessons can grow against my compass and existing canon; general revisions must state what changed and why. Private views of individual people never become global canon.`;
