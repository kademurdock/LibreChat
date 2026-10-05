import { createTxMethods } from './tx';
import { matchModelName, findMatchingPattern } from './test-helpers';

const { getValueKey, getMultiplier, getCacheMultiplier } = createTxMethods(
  {} as typeof import('mongoose'),
  { matchModelName, findMatchingPattern },
);

describe('Sol billing through the OpenRouter model name', () => {
  const model = 'openai/gpt-6.1-sol';
  const savedMultiplier = process.env.KADE_BILLING_MULTIPLIER;

  beforeEach(() => {
    process.env.KADE_BILLING_MULTIPLIER = '1';
  });

  afterEach(() => {
    if (savedMultiplier === undefined) delete process.env.KADE_BILLING_MULTIPLIER;
    else process.env.KADE_BILLING_MULTIPLIER = savedMultiplier;
  });

  it('resolves provider-prefixed and direct names to the same explicit price row', () => {
    expect(getValueKey(model)).toBe('gpt-6.1-sol');
    expect(getValueKey('gpt-6.1-sol')).toBe('gpt-6.1-sol');
    expect(getMultiplier({ model, tokenType: 'prompt' })).toBe(2);
    expect(getMultiplier({ model, tokenType: 'completion' })).toBe(10);
    expect(getCacheMultiplier({ model, cacheType: 'read' })).toBe(0.1);
    expect(getCacheMultiplier({ model, cacheType: 'write' })).toBe(2.5);
  });

  it('charges the long-context tier only after the 272K input boundary', () => {
    expect(getMultiplier({ model, tokenType: 'prompt', inputTokenCount: 272000 })).toBe(2);
    expect(getMultiplier({ model, tokenType: 'prompt', inputTokenCount: 272001 })).toBe(4);
    expect(getMultiplier({ model, tokenType: 'completion', inputTokenCount: 272001 })).toBe(15);
  });

  it('applies the platform contribution once to the actual Sol rates', () => {
    process.env.KADE_BILLING_MULTIPLIER = '2';
    expect(getMultiplier({ model, tokenType: 'prompt' })).toBe(4);
    expect(getMultiplier({ model, tokenType: 'completion' })).toBe(20);
    expect(getCacheMultiplier({ model, cacheType: 'read' })).toBe(0.2);
  });
});
