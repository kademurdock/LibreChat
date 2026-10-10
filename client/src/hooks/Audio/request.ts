import { useCallback, useEffect, useMemo, useRef } from 'react';

export function useSpeechRequest(
  conversationId: string,
  runId: string | null | undefined,
  callActive: boolean,
  onCancelled: () => void,
) {
  const current = useRef<AbortController | null>(null);
  const begin = useCallback(() => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    return controller;
  }, []);
  const isCurrent = useCallback(
    (controller: AbortController) => current.current === controller && !controller.signal.aborted,
    [],
  );
  const finish = useCallback((controller: AbortController) => {
    if (current.current !== controller) return false;
    current.current = null;
    return true;
  }, []);
  useEffect(
    () => () => {
      if (!current.current) return;
      const controller = current.current;
      current.current = null;
      controller.abort();
      onCancelled();
    },
    [conversationId, runId, callActive, onCancelled],
  );
  return useMemo(() => ({ begin, isCurrent, finish }), [begin, isCurrent, finish]);
}
