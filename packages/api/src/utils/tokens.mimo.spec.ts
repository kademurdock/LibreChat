import { EModelEndpoint } from 'librechat-data-provider';
import { getModelMaxTokens } from './tokens';

/* Nov 15 2026: MiMo was missing from the map, so MiMo agents with no
 * maxContextTokens got the 32000 default and long personas emptied the
 * conversation (Della). */
describe('MiMo context windows', () => {
  it('finds MiMo windows through the custom (OpenRouter) and agents endpoints', () => {
    for (const ep of [EModelEndpoint.custom, EModelEndpoint.agents]) {
      expect(getModelMaxTokens('xiaomi/mimo-v2.6-pro', ep)).toBe(1048576);
      expect(getModelMaxTokens('xiaomi/mimo-v2.6-pro-ultraspeed', ep)).toBe(1048576);
      expect(getModelMaxTokens('xiaomi/mimo-v2.6-flash', ep)).toBe(1048576);
      expect(getModelMaxTokens('xiaomi/mimo-v2.5-pro', ep)).toBe(1024000);
      expect(getModelMaxTokens('xiaomi/mimo-v2.5', ep)).toBe(1000000);
    }
  });
});
