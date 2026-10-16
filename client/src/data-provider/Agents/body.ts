import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dataService, MutationKeys, QueryKeys } from 'librechat-data-provider';
import type * as t from 'librechat-data-provider';
import type {
  QueryObserverResult,
  UseMutationResult,
  UseQueryOptions,
} from '@tanstack/react-query';
import { isEphemeralAgent } from '~/common';

/**
 * KADE Oct 16 2026: puppet bodies (/api/kade/agent-body). One cache entry per agent,
 * shared by the voice-message card, the call screen and the builder. A body changes only
 * when someone saves it, so it is kept for the session and replaced after a save or a
 * removal here. The server sends an ETag, so a refetch of an unchanged body is a 304.
 */
const validAgent = (agentId?: string | null): agentId is string =>
  !!agentId && /^agent_[A-Za-z0-9_-]{1,100}$/.test(agentId) && !isEphemeralAgent(agentId);

export const emptyAgentBody = (agentId: string): t.TAgentBody => ({
  agentId,
  rev: 0,
  source: null,
  updatedAt: null,
  recipe: null,
  description: null,
  sceneHash: null,
  scene: null,
});

export const useAgentBodyQuery = (
  agentId: string | null | undefined,
  config?: UseQueryOptions<t.TAgentBody>,
): QueryObserverResult<t.TAgentBody> =>
  useQuery<t.TAgentBody>(
    [QueryKeys.agentBody, agentId],
    () => dataService.getAgentBody(agentId as string),
    {
      staleTime: 10 * 60 * 1000,
      cacheTime: 30 * 60 * 1000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      retry: false,
      ...config,
      enabled: validAgent(agentId) && (config?.enabled ?? true),
    },
  );

/** Every part and colour with its spoken name; drives the body editor's controls. */
export const useAgentBodyCatalogQuery = (
  config?: UseQueryOptions<t.TAgentBodyCatalog>,
): QueryObserverResult<t.TAgentBodyCatalog> =>
  useQuery<t.TAgentBodyCatalog>(
    [QueryKeys.agentBodyCatalog],
    () => dataService.getAgentBodyCatalog(),
    {
      staleTime: 30 * 60 * 1000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 1,
      ...config,
    },
  );

/** Save with the revision the editor started from; a 409 carries `latest` (theirs). */
export const useSaveAgentBodyMutation = (): UseMutationResult<
  t.TAgentBody,
  unknown,
  t.TSaveAgentBodyRequest
> => {
  const queryClient = useQueryClient();
  return useMutation(
    [MutationKeys.saveAgentBody],
    (vars: t.TSaveAgentBodyRequest) => dataService.saveAgentBody(vars),
    {
      onSuccess: (saved, vars) => {
        queryClient.setQueryData<t.TAgentBody>([QueryKeys.agentBody, vars.agentId], saved);
      },
    },
  );
};

export const useDeleteAgentBodyMutation = (): UseMutationResult<
  { ok: boolean; agentId: string },
  unknown,
  string
> => {
  const queryClient = useQueryClient();
  return useMutation(
    [MutationKeys.deleteAgentBody],
    (agentId: string) => dataService.deleteAgentBody(agentId),
    {
      onSuccess: (_result, agentId) => {
        queryClient.setQueryData<t.TAgentBody>(
          [QueryKeys.agentBody, agentId],
          emptyAgentBody(agentId),
        );
      },
    },
  );
};

/** Compile a draft (no save). */
export const usePreviewAgentBodyMutation = (): UseMutationResult<
  t.TAgentBody,
  unknown,
  t.TAgentBodyRecipe
> => useMutation((recipe: t.TAgentBodyRecipe) => dataService.previewAgentBody(recipe));

export const useSurpriseAgentBodyMutation = (): UseMutationResult<
  t.TAgentBody,
  unknown,
  { seed?: string; fantasy?: boolean }
> =>
  useMutation((params: { seed?: string; fantasy?: boolean }) =>
    dataService.surpriseAgentBody(params),
  );

/** Small paid call: the answer carries costUSD. */
export const useAgentBodyFromWordsMutation = (): UseMutationResult<
  t.TAgentBody,
  unknown,
  { words: string; base?: t.TAgentBodyRecipe | null }
> =>
  useMutation((params: { words: string; base?: t.TAgentBodyRecipe | null }) =>
    dataService.agentBodyFromWords(params),
  );

/** Small paid call: the answer carries costUSD. */
export const useAgentBodyFromPortraitMutation = (): UseMutationResult<
  t.TAgentBody,
  unknown,
  string
> => useMutation((agentId: string) => dataService.agentBodyFromPortrait(agentId));
