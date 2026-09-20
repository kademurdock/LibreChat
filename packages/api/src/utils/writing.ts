type WritingUsage = {
  cost?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
};

export function writingCost(
  usage: WritingUsage,
  model: string,
  inputChars = 0,
  outputChars = 0,
): { costUSD: number; measured: boolean } {
  if (typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0) {
    return { costUSD: usage.cost, measured: true };
  }
  const prices: { [model: string]: [number, number] } = {
    'nousresearch/hermes-4-405b': [1, 3],
    'x-ai/grok-4.20': [1.25, 2.5],
    'moonshotai/kimi-k3': [1.95, 10.92],
    'deepseek/deepseek-v4.1-flash': [0.3, 1.2],
    'z-ai/glm-5.3-flash': [0.075, 0.25],
  };
  const rates = prices[model];
  if (!rates) throw new Error('Writing model pricing is unavailable; configure a supported writing model.');
  const input = Number.isFinite(usage.prompt_tokens) ? Math.max(0, usage.prompt_tokens ?? 0) : inputChars / 4;
  const output = Number.isFinite(usage.completion_tokens) ? Math.max(0, usage.completion_tokens ?? 0) : outputChars / 4;
  return { costUSD: (input * rates[0] + output * rates[1]) / 1e6, measured: false };
}
