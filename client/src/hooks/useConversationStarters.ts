import { useState, useEffect } from 'react';
import {
  readPreviousStarters,
  rememberStarters,
  selectConversationStarters,
} from '~/utils/starters';

export default function useConversationStarters(
  pool: readonly string[],
  scope: string,
  entityKey: string,
): string[] {
  const storageKey = `kade:starters:${entityKey}`;
  const [selection, setSelection] = useState({ scope: '', prompts: [] as string[] });
  if (selection.scope !== scope || (!selection.prompts.length && pool.length)) {
    setSelection({
      scope,
      prompts: selectConversationStarters(pool, scope, 4, readPreviousStarters(storageKey)),
    });
  }
  useEffect(() => {
    if (selection.scope === scope && selection.prompts.length) {
      rememberStarters(storageKey, selection.prompts);
    }
  }, [scope, selection, storageKey]);
  return selection.prompts;
}
