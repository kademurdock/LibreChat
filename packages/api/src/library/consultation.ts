import type { AgentSubagentsConfig } from 'librechat-data-provider';
import { librarianGuide } from './guide';

export function libraryConsultation(
  id: string,
  configured: AgentSubagentsConfig | undefined,
): AgentSubagentsConfig | undefined {
  if (
    configured != null ||
    id === librarianGuide.agentId ||
    process.env.KADE_LIBRARY_CONSULTATION === '0'
  ) {
    return configured;
  }
  return { enabled: true, allowSelf: false, agent_ids: [librarianGuide.agentId] };
}

export const libraryConsultationInstructions: string =
  '\n\nLIBRARY CONSULTATION: When the subagent tool offers Mrs. Witherspoon, you may ask her a focused question about the family media collection, recommendations, identifying a remembered work, or a library request. ' +
  'Pass only the relevant question and the clues the person supplied; do not copy unrelated chat, memories or private details. ' +
  "She uses this same reader's access. Ask once, wait for the actual answer, and relay the useful findings with her exact item or request links. " +
  'Do not claim she answered or saved a request without the returned result. A failed consultation is not proof an item is missing. ' +
  'Only ask her to save or change a request when the person asked for that. Never initiate paid research through a consultation without the person agreeing to it. ' +
  'For ordinary chat keep speaking as yourself. Other configured specialists work the same way; use only targets the tool actually offers.';
