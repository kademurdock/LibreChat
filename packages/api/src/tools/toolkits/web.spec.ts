import { buildWebSearchContext, buildWebSearchDynamicContext } from './web';

jest.mock('librechat-data-provider', () => ({
  Tools: { web_search: 'web_search' },
  replaceSpecialVars: jest.fn(({ now }: { now?: string | Date }) =>
    now instanceof Date ? now.toISOString() : (now ?? 'NOW'),
  ),
}));

describe('web search context', () => {
  it('keeps static context free of volatile date replacements', () => {
    const context = buildWebSearchContext();

    expect(context).toContain('web_search');
    expect(context).not.toContain('NOW');
    expect(context).not.toContain('{{iso_datetime}}');
  });

  it('builds dynamic context from the supplied conversation anchor, quantized (the cache stabilizer)', () => {
    const context = buildWebSearchDynamicContext('2024-01-02T03:04:05.000Z');
    const secondContext = buildWebSearchDynamicContext('2024-01-02T03:04:05.000Z');

    // Default LC_TIME_ANCHOR_QUANTUM_MIN=60 floors the anchor to the hour so
    // the rendered line is byte-identical within a window (Moonshot cache).
    expect(context).toBe(
      '# `web_search` Runtime Context\nConversation Date & Time: 2024-01-02T03:00:00.000Z',
    );
    expect(secondContext).toBe(context);
  });

  it('renders byte-identical across anchors inside the same window', () => {
    const early = buildWebSearchDynamicContext('2024-01-02T03:04:05.000Z');
    const late = buildWebSearchDynamicContext('2024-01-02T03:59:59.999Z');
    const nextWindow = buildWebSearchDynamicContext('2024-01-02T04:00:00.000Z');

    expect(late).toBe(early);
    expect(nextWindow).not.toBe(early);
  });
});
