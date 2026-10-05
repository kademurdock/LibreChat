import { readPreviousStarters, rememberStarters, selectConversationStarters } from './starters';

const pool = Array.from({ length: 24 }, (_, index) => `An interesting starting point ${index + 1}`);

describe('starter presentation', () => {
  it('holds the same selection for the same new-conversation seed', () => {
    expect(selectConversationStarters(pool, 'chat-one')).toEqual(
      selectConversationStarters([...pool], 'chat-one'),
    );
  });

  it('varies on a new conversation and avoids the last displayed set when possible', () => {
    const first = selectConversationStarters(pool, 'chat-one');
    const next = selectConversationStarters(pool, 'chat-two', 4, first);
    expect(first).toHaveLength(4);
    expect(next).toHaveLength(4);
    expect(next.every((text) => !first.includes(text))).toBe(true);
    expect(selectConversationStarters(pool, 'chat-two')).not.toEqual(first);
  });

  it('handles small authored pools, blank entries and duplicates without hiding good prompts', () => {
    expect(
      selectConversationStarters([' One ', '', 'One', 'Two'], 'small', 4, ['One', 'Two']).sort(),
    ).toEqual(['One', 'Two']);
    expect(selectConversationStarters(pool, 'none', 0)).toEqual([]);
  });

  it('keeps recent choices locally and tolerates corrupt session data', () => {
    rememberStarters('test-starters', ['One', 'Two']);
    expect(readPreviousStarters('test-starters')).toEqual(['One', 'Two']);
    sessionStorage.setItem('test-starters', '{broken');
    expect(readPreviousStarters('test-starters')).toEqual([]);
    sessionStorage.setItem('test-starters', JSON.stringify(['One', 4]));
    expect(readPreviousStarters('test-starters')).toEqual(['One']);
  });
});
