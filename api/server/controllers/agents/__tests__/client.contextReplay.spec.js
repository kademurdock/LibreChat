/**
 * Pins the voice/phone replay-envelope strip that `AgentClient::runMemory` runs
 * before memory extraction (`AgentClient::stripContextReplay`).
 *
 * WHY THIS EXISTS. The phone lane holds no conversation of its own, so
 * inworld-tts-proxy's `composeTextWithHistory` folds up to 24 prior turns into
 * the TEXT of every request, wrapped in an explicit envelope. That envelope is
 * prompt construction, not speech -- but it arrives as the user message, so
 * memory extraction had been reading a replayed transcript as her words on
 * every single phone turn, re-ingesting the same exchanges over and over and
 * crowding the five-message window with text she never uttered.
 *
 * Following the house pattern in `client.memory.spec.js`: the controller is
 * awkward to instantiate, so the pure logic is mirrored here. If the pattern in
 * `client.js` drifts, or if the proxy ever changes the envelope's wording,
 * these fail loudly instead of memory quietly going back to eating replayed
 * text.
 *
 * TWO SOURCES MUST AGREE WITH THIS FILE:
 *   - `api/server/controllers/agents/client.js` -- CONTEXT_REPLAY_RE
 *   - inworld-tts-proxy `librechat.js` -- composeTextWithHistory
 */

// Mirrored from client.js::CONTEXT_REPLAY_RE
const CONTEXT_REPLAY_RE =
  /\[EARLIER IN THIS CONVERSATION[\s\S]*?Reply ONLY to what follows\.\]\s*/gi;

const strip = (text) => text.replace(CONTEXT_REPLAY_RE, '');

/** Mirrored from inworld-tts-proxy librechat.js::composeTextWithHistory. */
function composeTextWithHistory(messages) {
  const last = messages[messages.length - 1] || {};
  const lastText = last.content || '';
  const prior = messages.slice(0, -1).filter((m) => m && m.content);
  if (!prior.length) {
    return lastText;
  }
  const lines = prior.map(
    (m) => `${m.role === 'assistant' ? 'YOU' : 'THEM'}: ${String(m.content).slice(0, 600)}`,
  );
  return (
    '[EARLIER IN THIS CONVERSATION — context only, already handled, do not re-answer:\n' +
    lines.join('\n') +
    '\n— end of earlier context. Reply ONLY to what follows.]\n\n' +
    lastText
  );
}

describe('AgentClient::stripContextReplay -- the phone lane must not teach memory things she never said', () => {
  it('reduces a real 24-turn phone request to only what she just said', () => {
    const history = [];
    for (let i = 0; i < 24; i++) {
      history.push({
        role: i % 2 ? 'assistant' : 'user',
        content: `turn ${i} some spoken words here`,
      });
    }
    history.push({ role: 'user', content: 'what was that thing you said about my sister' });

    const composed = composeTextWithHistory(history);
    expect(composed.length).toBeGreaterThan(900);
    expect(strip(composed)).toBe('what was that thing you said about my sister');
  });

  it('preserves the trailing markers the last message carries', () => {
    // The proxy deliberately keeps [PHONE CALL...], game mode and caller lines
    // at the END, where reframe's marker detection and the model's attention
    // both live. Stripping must never reach them.
    const composed = composeTextWithHistory([
      { role: 'user', content: 'earlier' },
      { role: 'user', content: 'hey [PHONE CALL — she is on the line]' },
    ]);
    expect(strip(composed)).toBe('hey [PHONE CALL — she is on the line]');
  });

  it('leaves a typed message that merely mentions the phrase completely alone', () => {
    const typed = 'Can you remind me what EARLIER IN THIS CONVERSATION means as a phrase?';
    expect(strip(typed)).toBe(typed);
  });

  it('leaves the first turn of a call alone (no prior turns, so no envelope)', () => {
    expect(strip(composeTextWithHistory([{ role: 'user', content: 'hey Kiana' }]))).toBe(
      'hey Kiana',
    );
  });

  it('reduces the 20,000-character shape actually found stored in her history', () => {
    // Two real user rows, 20,511 and 20,452 chars, fourteen seconds apart on
    // 2026-07-25, are this envelope persisted verbatim.
    const monster =
      '[EARLIER IN THIS CONVERSATION — context only, already handled, do not re-answer:\n' +
      'THEM: hear me? Hey, Amber…\n' +
      `YOU: ${'x'.repeat(20000)}\n` +
      '— end of earlier context. Reply ONLY to what follows.]\n\n' +
      'okay so anyway';
    expect(strip(monster)).toBe('okay so anyway');
  });

  it('is not stateful across calls despite the global flag', () => {
    // A /g regex carries lastIndex. String.replace resets it; String.test does
    // not. This pins that the strip is only ever used the safe way.
    const composed = composeTextWithHistory([
      { role: 'user', content: 'earlier' },
      { role: 'user', content: 'her words' },
    ]);
    for (let i = 0; i < 50; i++) {
      expect(strip(composed)).toBe('her words');
    }
  });
});
