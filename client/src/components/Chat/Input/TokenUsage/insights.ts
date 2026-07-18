import type { TokenUsageView } from '~/hooks/Chat/useTokenUsage';

/**
 * Plain-language "how full" band for the context window, returned as a
 * localization key so the phrase stays translatable. Thresholds are on the
 * 0–100 `percent` the view already clamps.
 */
export function fullnessKey(percent: number): string {
  if (percent >= 90) {
    return 'com_ui_context_full_nearly';
  }
  if (percent >= 70) {
    return 'com_ui_context_full_getting_full';
  }
  if (percent >= 25) {
    return 'com_ui_context_full_filling';
  }
  return 'com_ui_context_full_plenty';
}

/**
 * Rough count of additional messages that still fit, at this branch's own
 * average message size. Uses message-only tokens (`input + output`) over the
 * counted messages — NOT `usedTokens`, which includes the fixed system/tool
 * overhead that does not grow per message. Returns null when it can't be
 * computed (unknown max, no counted messages, or already full), so callers
 * simply omit the clause.
 */
export function estimateMessagesLeft(view: TokenUsageView): number | null {
  const { maxTokens, usedTokens, branchTotals } = view;
  if (maxTokens == null || maxTokens <= 0) {
    return null;
  }
  const counted = branchTotals.counted;
  const messageTokens = branchTotals.input + branchTotals.output;
  if (counted <= 0 || messageTokens <= 0) {
    return null;
  }
  const avgPerMessage = messageTokens / counted;
  const free = maxTokens - usedTokens;
  if (avgPerMessage <= 0 || free <= 0) {
    return null;
  }
  return Math.floor(free / avgPerMessage);
}

/**
 * USD saved on this branch by prompt caching: cached-read tokens are billed at
 * the cache-read rate instead of the full prompt rate, so the saving is
 * `cacheRead * (prompt - cacheRead) / 1M`. Rates are USD per 1M tokens. Returns
 * null when rates or cache reads are absent, so the clause is simply omitted.
 */
export function cacheSavingsUSD(view: TokenUsageView): number | null {
  const rates = view.rates;
  const cacheReadTokens = view.branchUsage.cacheRead;
  if (rates == null || cacheReadTokens <= 0) {
    return null;
  }
  const promptRate = rates.prompt;
  const cacheReadRate = rates.cacheRead ?? 0;
  if (promptRate == null || promptRate <= 0) {
    return null;
  }
  const savedPerToken = Math.max(0, promptRate - cacheReadRate) / 1_000_000;
  const saved = cacheReadTokens * savedPerToken;
  return saved > 0 ? saved : null;
}
