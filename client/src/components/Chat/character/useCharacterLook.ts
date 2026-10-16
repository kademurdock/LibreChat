import { useMemo } from 'react';
import { useAgentBodyQuery, useGetAgentByIdQuery } from '~/data-provider';
import { portraitPlan } from './portrait-rig.mjs';
import { characterAppearanceKey } from './appearance';

/**
 * What a character looks like on screen: its avatar, the face rig that draws it (a
 * hand-made face first, else its saved puppet body) and the words that describe it.
 * Both queries are cached per agent, so every message from one character shares them.
 */
export function useCharacterLook(agentId: string | null | undefined, enabled: boolean) {
  const { data: agent } = useGetAgentByIdQuery(agentId, { enabled });
  const { data: body } = useAgentBodyQuery(agentId, { enabled });
  const path = agent?.avatar?.filepath ?? '';
  const plan = useMemo(
    () => (agentId && agent ? portraitPlan(agentId, path, body) : null),
    [agentId, agent, path, body],
  );
  const appearanceKey = agentId && path ? characterAppearanceKey(agentId, path) : undefined;
  const bodyDescription = plan && 'description' in plan ? plan.description : '';
  return { agent, path, plan, appearanceKey, bodyDescription };
}
