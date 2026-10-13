import { createTxMethods } from './tx';
import { matchModelName, findMatchingPattern } from './test-helpers';

const { getValueKey, getMultiplier, getCacheMultiplier } = createTxMethods(
  {} as typeof import('mongoose'),
  { matchModelName, findMatchingPattern },
);

describe('MiMo Pro character billing', () => {
  const model = 'xiaomi/mimo-v2.6-pro';
  const prior = process.env.KADE_BILLING_MULTIPLIER;

  beforeEach(() => {
    process.env.KADE_BILLING_MULTIPLIER = '1';
  });

  afterEach(() => {
    if (prior === undefined) delete process.env.KADE_BILLING_MULTIPLIER;
    else process.env.KADE_BILLING_MULTIPLIER = prior;
  });

  it('prices the provider-prefixed character model instead of the unknown-model rate', () => {
    expect(getValueKey(model)).toBe('mimo-v2.6-pro');
    expect(getMultiplier({ model, tokenType: 'prompt' })).toBe(0.435);
    expect(getMultiplier({ model, tokenType: 'completion' })).toBe(0.87);
    expect(getCacheMultiplier({ model, cacheType: 'read' })).toBe(0.0036);
  });

  it('keeps the published price on long character histories', () => {
    expect(getMultiplier({ model, tokenType: 'prompt', inputTokenCount: 900000 })).toBe(0.435);
    expect(getMultiplier({ model, tokenType: 'completion', inputTokenCount: 900000 })).toBe(0.87);
  });

  it('applies the family contribution exactly once to input, output and cached input', () => {
    process.env.KADE_BILLING_MULTIPLIER = '2';
    expect(getMultiplier({ model, tokenType: 'prompt' })).toBe(0.87);
    expect(getMultiplier({ model, tokenType: 'completion' })).toBe(1.74);
    expect(getCacheMultiplier({ model, cacheType: 'read' })).toBe(0.0072);
  });
});
