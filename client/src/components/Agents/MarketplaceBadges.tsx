/*
 * MarketplaceBadges.tsx  —  accessible marketplace-card badges for Kade-AI
 *
 * Renders up to two badges on a marketplace agent card:
 *   1. Answer style — "Instant" vs "Reasoning" (derived from the agent's reasoning_effort).
 *   2. Awareness    — how the persona treats being an AI ("Knows", "Plays it real", "Partly aware").
 *
 * ACCESSIBILITY (this platform is blind-primary — non-negotiable):
 *   - Never signal meaning by color alone. Each badge carries a real text label AND an
 *     aria-label that spells out what it means, so a screen reader announces the meaning,
 *     not just a color or an icon.
 *   - The little shape/icon is decorative and aria-hidden, so VoiceOver doesn't read it.
 *   - Badges are plain inline text spans, part of the card's reading order, with a title
 *     for sighted hover and an aria-label for the full spoken description.
 *
 * DROP-IN: self-contained. Import <MarketplaceBadges agent={agent} /> into the marketplace
 * card component (in the fork that's the card that renders each agent in the marketplace grid —
 * locate it by searching the fork for the component that maps over the agents list and renders
 * name + description + avatar). Tailwind core utility classes only, to match the app.
 */

import React from 'react';

/* ---------------------------------------------------------------- answer style */
// Models that default to zero reasoning / instant replies even with no reasoning_effort set.
// Extend this if you pin more instant-by-default models to agents.
const INSTANT_MODELS = new Set<string>(['minimax/minimax-m2-her']);

export type AnswerStyle = 'instant' | 'reasoning';

export function getAnswerStyle(agent: any): AnswerStyle {
  const eff = agent?.model_parameters?.reasoning_effort;
  if (eff === 'none') return 'instant';
  if (eff) return 'reasoning'; // low | medium | high | xhigh
  // No explicit effort: it depends on the model's own default.
  if (INSTANT_MODELS.has(agent?.model)) return 'instant';
  return 'reasoning';
}

/* ------------------------------------------------------------------- awareness */
// The awareness posture lives in each agent's own "WHO YOU ARE" instructions, not in a
// structured field. These are ONLY the tiers confirmed by reading the actual instructions
// (per the July 1 2026 uncensoring/awareness sweep). Everything NOT listed here is
// intentionally left undefined so no awareness badge shows until it's confirmed the same
// way — by reading the agent's opener, not guessing from its marketing blurb.
//
// tiers:  'aware'   -> knows / is fully aware it's an AI
//         'partial' -> partially self-aware, filtered through its own premise
//         'real'    -> plays fully real, does not present as AI
export type Awareness = 'aware' | 'partial' | 'real';

export const AWARENESS_CONFIRMED: Record<string, Awareness> = {
  // confirmed 'aware'
  Kiana: 'aware',
  Cipher: 'aware',
  Recoil: 'aware',
  Marlowe: 'aware',
  Vex: 'aware',
  Index: 'aware',
  Vista: 'aware',
  Sparky: 'aware',
  Gavel: 'aware',
  Spooky: 'aware',
  Bex: 'aware',
  Barnaby: 'aware', // knows he's dead and trapped in a fridge — meta-aware adjacent
  // confirmed 'partial'
  'Voyager 1': 'partial',
  Ariadne: 'partial',
  // confirmed 'real'
  Trailhead: 'real',
  Sarah: 'real',
  'Nana Pearl': 'real',
  'Professor Vance': 'real',
  'Barnacle Bill': 'real',
  Lint: 'real', // "you are dryer lint" is premise-awareness, NOT AI-awareness
};

// Prefer an authoritative per-agent field if/when one exists (agent.awareness or
// agent.metadata.awareness); otherwise fall back to the confirmed map above.
export function getAwareness(agent: any): Awareness | undefined {
  return agent?.awareness ?? agent?.metadata?.awareness ?? AWARENESS_CONFIRMED[agent?.name];
}

/* ------------------------------------------------------------------- rendering */
const ANSWER_META: Record<AnswerStyle, { label: string; aria: string; dot: string }> = {
  instant:   { label: 'Instant',   aria: 'Answer style: instant — replies right away without a visible thinking step.', dot: '●' },
  reasoning: { label: 'Reasoning', aria: 'Answer style: reasoning — thinks through the problem before answering.',       dot: '◐' },
};

const AWARENESS_META: Record<Awareness, { label: string; aria: string; dot: string }> = {
  aware:   { label: "Knows it's AI", aria: 'Awareness: this character knows it is an AI.',                       dot: '◆' },
  partial: { label: 'Partly aware',  aria: 'Awareness: this character is partially self-aware about being an AI.', dot: '◈' },
  real:    { label: 'Plays it real', aria: 'Awareness: this character stays fully in role and does not present as an AI.', dot: '○' },
};

function Badge({ label, aria, dot, tone }: { label: string; aria: string; dot: string; tone: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}
      aria-label={aria}
      title={aria}
    >
      <span aria-hidden="true">{dot}</span>
      <span>{label}</span>
    </span>
  );
}

export default function MarketplaceBadges({ agent }: { agent: any }) {
  const style = getAnswerStyle(agent);
  const awareness = getAwareness(agent);
  const s = ANSWER_META[style];
  const a = awareness ? AWARENESS_META[awareness] : undefined;

  // Tones use BOTH a background/border tint AND text — never color alone (a11y).
  const styleTone =
    style === 'instant'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-200'
      : 'border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-200';
  const awareTone = 'border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-700 dark:bg-violet-950 dark:text-violet-200';

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="marketplace-badges">
      <Badge label={s.label} aria={s.aria} dot={s.dot} tone={styleTone} />
      {a && <Badge label={a.label} aria={a.aria} dot={a.dot} tone={awareTone} />}
    </div>
  );
}
