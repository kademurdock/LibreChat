type WritingUsage = {
  cost?: number;
  is_byok?: boolean | null;
  cost_details?: { upstream_inference_cost?: number | null } | null;
  prompt_tokens?: number;
  completion_tokens?: number;
};

const reported = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export function writingCost(
  usage: WritingUsage,
  model: string,
  inputChars = 0,
  outputChars = 0,
): { costUSD: number; measured: boolean } {
  /* Part 295, measured on live replies: real cost = is_byok === true ? cost + upstream : cost.
   * A normal reply's cost_details.upstream_inference_cost EQUALS its cost (the same money said
   * twice), so it is never added. Only with a provider key inside OpenRouter (BYOK) is usage.cost
   * just OpenRouter's fee and the upstream figure what the provider charged the key; then the two
   * are summed. A reply naming only the upstream figure costs that figure (right either way).
   * A BYOK reply without the upstream figure is not a price (the fee alone is often 0): it is
   * priced from its tokens, as the describer's realCost and kadeRealCost.openRouterCost do. */
  const own = reported(usage.cost);
  const upstream = reported(usage.cost_details?.upstream_inference_cost);
  const byokUnpriced = usage.is_byok === true && upstream === undefined;
  if (own !== undefined && !byokUnpriced) {
    return { costUSD: usage.is_byok === true && upstream !== undefined ? own + upstream : own, measured: true };
  }
  if (upstream !== undefined) {
    return { costUSD: upstream, measured: true };
  }
  const prices: { [model: string]: [number, number] } = {
    'nousresearch/hermes-4-405b': [1, 3],
    'x-ai/grok-4.20': [1.25, 2.5],
    'moonshotai/kimi-k3': [1.95, 10.92],
    'deepseek/deepseek-v4.1-flash': [0.3, 1.2],
    'z-ai/glm-5.3-flash': [0.075, 0.25],
  };
  const rates = prices[model];
  /* A model with no price row keeps the writer working on a BYOK reply: the fee, marked unmeasured. */
  if (!rates && byokUnpriced && own !== undefined) return { costUSD: own, measured: false };
  if (!rates) throw new Error('Writing model pricing is unavailable; configure a supported writing model.');
  const input = Number.isFinite(usage.prompt_tokens) ? Math.max(0, usage.prompt_tokens ?? 0) : inputChars / 4;
  const output = Number.isFinite(usage.completion_tokens) ? Math.max(0, usage.completion_tokens ?? 0) : outputChars / 4;
  return { costUSD: (input * rates[0] + output * rates[1]) / 1e6, measured: false };
}
