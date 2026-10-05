import { useMemo, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { EModelEndpoint, isEphemeralAgentId } from 'librechat-data-provider';
import {
  useGetAssistantDocsQuery,
  useGetEndpointsQuery,
  useGetStartupConfig,
} from '~/data-provider';
import { useChatContext, useAgentsMapContext, useAssistantsMapContext } from '~/Providers';
import { getIconEndpoint, getEntity, getModelSpec } from '~/utils';
import { useSubmitMessage, useLocalize } from '~/hooks';
import useConversationStarters from '~/hooks/useConversationStarters';

const ConversationStarters = () => {
  const location = useLocation();
  const localize = useLocalize();
  const { conversation } = useChatContext();
  const agentsMap = useAgentsMapContext();
  const assistantMap = useAssistantsMapContext();
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const { data: startupConfig } = useGetStartupConfig();

  const endpointType = useMemo(() => {
    let ep = conversation?.endpoint ?? '';
    if (ep === EModelEndpoint.azureOpenAI) {
      ep = EModelEndpoint.openAI;
    }
    return getIconEndpoint({
      endpointsConfig,
      iconURL: conversation?.iconURL,
      endpoint: ep,
    });
  }, [conversation?.endpoint, conversation?.iconURL, endpointsConfig]);

  const { data: documentsMap = new Map() } = useGetAssistantDocsQuery(endpointType, {
    select: (data) => new Map(data.map((dbA) => [dbA.assistant_id, dbA])),
  });

  const { entity, isAgent } = getEntity({
    endpoint: endpointType,
    agentsMap,
    assistantMap,
    agent_id: conversation?.agent_id,
    assistant_id: conversation?.assistant_id,
  });

  const modelSpec = useMemo(
    () => getModelSpec({ specName: conversation?.spec, startupConfig }),
    [conversation?.spec, startupConfig],
  );

  const conversation_starters = useMemo(() => {
    if (entity?.conversation_starters != null) {
      return entity.conversation_starters;
    }

    if (
      isAgent &&
      conversation?.agent_id &&
      !isEphemeralAgentId(conversation.agent_id) &&
      !entity
    ) {
      return [];
    }

    if (modelSpec?.conversation_starters?.length) {
      return modelSpec.conversation_starters;
    }

    if (isAgent) {
      return [];
    }

    return documentsMap.get(entity?.id ?? '')?.conversation_starters ?? [];
  }, [documentsMap, isAgent, entity, modelSpec, conversation?.agent_id]);

  const { submitMessage } = useSubmitMessage();
  const entityKey = entity?.id ?? conversation?.agent_id ?? conversation?.spec ?? endpointType;
  const scope = `${location.key}:${entityKey}`;
  const selectedStarters = useConversationStarters(conversation_starters, scope, entityKey);
  const sendConversationStarter = useCallback(
    (text: string) => submitMessage({ text }),
    [submitMessage],
  );

  if (!selectedStarters.length) {
    return null;
  }

  return (
    <div
      role="group"
      aria-label={localize('com_assistants_conversation_starters')}
      className="mb-8 mt-2 flex w-full flex-wrap items-stretch justify-center gap-2 px-4"
    >
      {selectedStarters.map((text: string, index: number) => (
        <button
          key={text}
          type="button"
          onClick={() => sendConversationStarter(text)}
          style={{ animationDelay: `${index * 75}ms`, animationFillMode: 'backwards' }}
          className="flex max-w-[16rem] cursor-pointer items-center justify-center rounded-2xl border border-border-medium bg-surface-secondary px-4 py-2.5 text-center text-sm text-text-secondary shadow-sm transition-colors duration-200 fade-in hover:border-border-heavy hover:bg-surface-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
        >
          <span className="line-clamp-2 text-balance break-words">{text}</span>
        </button>
      ))}
    </div>
  );
};

export default ConversationStarters;
