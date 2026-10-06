import { getBufferString, HumanMessage } from '@librechat/agents/langchain/messages';
import type { BaseMessage } from '@librechat/agents/langchain/messages';

export interface MemoryEvidence {
  actualUserEvidence: string;
  actualAssistantEvidence: string;
}

/** Keep true speaker boundaries, admitting only text retained by the keeper's suffix limits. */
export function getMemoryEvidence(messages: BaseMessage[], retainedInput?: string): MemoryEvidence {
  const empty: MemoryEvidence = { actualUserEvidence: '', actualAssistantEvidence: '' };
  if (retainedInput === '') return empty;
  const spans: { role: string; message: number; start: number; text: string }[] = [];
  const serializedMessages: string[] = [];
  let position = 0;
  let latestUser = -1;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const role = message._getType();
    const serialized = getBufferString([message]);
    serializedMessages.push(serialized);
    if (role === 'human') latestUser = index;
    if (role === 'human' || role === 'ai') {
      let start =
        position + (role === 'human' ? 7 : 4) + (message.name ? message.name.length + 2 : 0);
      if (typeof message.content === 'string') {
        spans.push({ role, message: index, start, text: message.content });
      } else {
        for (const block of message.content) {
          const rendered = getBufferString([new HumanMessage({ content: [block] })]).slice(7);
          if (block.type === 'text' && typeof block.text === 'string') {
            spans.push({ role, message: index, start, text: rendered });
          }
          start += rendered.length;
        }
      }
    }
    position += serialized.length + 1;
  }
  const transcript = serializedMessages.join('\n');
  let retainedCharacters = transcript.length;
  if (retainedInput !== undefined) {
    retainedCharacters = 0;
    const limit = Math.min(transcript.length, retainedInput.length);
    while (
      retainedCharacters < limit &&
      transcript[transcript.length - retainedCharacters - 1] ===
        retainedInput[retainedInput.length - retainedCharacters - 1]
    ) {
      retainedCharacters++;
    }
  }
  const cutoff = transcript.length - retainedCharacters;
  const assistant: string[] = [];
  let previousAssistant = -1;
  for (const span of spans) {
    const text = span.text.slice(Math.max(0, cutoff - span.start));
    if (!text) continue;
    if (span.role === 'human' && span.message === latestUser) empty.actualUserEvidence += text;
    if (span.role !== 'ai') continue;
    if (previousAssistant !== span.message && assistant.length > 0) assistant.push('\n');
    assistant.push(text);
    previousAssistant = span.message;
  }
  empty.actualAssistantEvidence = assistant.join('');
  return empty;
}
