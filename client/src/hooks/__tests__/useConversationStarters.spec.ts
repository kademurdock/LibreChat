import { renderHook } from '@testing-library/react';
import useConversationStarters from '../useConversationStarters';

const pool = Array.from({ length: 24 }, (_, index) => `Opening ${index + 1}`);

describe('new conversation starter state', () => {
  beforeEach(() => sessionStorage.clear());

  it('waits for the pool and holds its four choices through rerenders and pool refreshes', () => {
    const { result, rerender } = renderHook(
      ({ prompts }) => useConversationStarters(prompts, 'chat-one', 'character-one'),
      { initialProps: { prompts: [] as string[] } },
    );
    expect(result.current).toEqual([]);
    rerender({ prompts: pool });
    const first = result.current;
    expect(first).toHaveLength(4);
    rerender({ prompts: [...pool, 'Newly authored opening'] });
    expect(result.current).toEqual(first);
  });

  it('selects again for a new conversation and does not immediately repeat the last four', () => {
    const { result, rerender } = renderHook(
      ({ scope }) => useConversationStarters(pool, scope, 'character-one'),
      { initialProps: { scope: 'chat-one' } },
    );
    const first = result.current;
    rerender({ scope: 'chat-two' });
    expect(result.current.every((line) => !first.includes(line))).toBe(true);
  });

  it('does not fill an explicitly empty authored pool with generic text', () => {
    const { result } = renderHook(() => useConversationStarters([], 'empty-chat', 'character-one'));
    expect(result.current).toEqual([]);
  });
});
