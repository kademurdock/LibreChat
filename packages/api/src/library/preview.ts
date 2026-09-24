interface FilingItem {
  _id: string;
  title: string;
  kind: string;
  path?: string;
  category?: string;
}
interface FilingDecision {
  item: FilingItem;
  to?: string | null;
  why?: string;
  error?: string;
  confidence?: number;
}
interface FilingDependencies {
  zoneOf: (item: FilingItem) => string;
  categoryOf: (path: string, kind: string) => string;
  fileMedia: (items: FilingItem[]) => Promise<{ decisions: FilingDecision[]; costUSD: number }>;
}

export function filingPreviewIds(ids: string[]): string[] {
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some((id) => typeof id !== 'string' || !/^[a-f0-9]{24}$/i.test(id))) {
    throw new Error('Choose between 1 and 100 library items per batch.');
  }
  return [...new Set(ids.map((id) => id.toLowerCase()))];
}

export async function previewLibraryFolders(items: FilingItem[], deps: FilingDependencies) {
  const intake = items.filter((item) => deps.zoneOf(item) === 'intake');
  const skipped = items.filter((item) => !intake.includes(item)).map((item) => ({ id: String(item._id), title: item.title, path: item.path || '', reason: 'Already filed. Use a manual folder correction if its current folder is wrong.' }));
  const result = intake.length ? await deps.fileMedia(intake) : { decisions: [], costUSD: 0 };
  const changes = [];
  for (const decision of result.decisions) {
    const item = decision.item;
    if (!decision.to || decision.to === item.path || decision.error) {
      skipped.push({ id: String(item._id), title: item.title, path: item.path || '', reason: decision.error ? 'The librarian could not check this item. Try again later.' : 'No confident folder yet. An exact source description or a manual folder choice is needed.' });
      continue;
    }
    changes.push({ id: String(item._id), title: item.title, kind: item.kind, from: item.path || '', to: decision.to, category: deps.categoryOf(decision.to, item.kind), oldCategory: item.category || 'other', reason: decision.why || 'Suggested from the title and description.', confidence: decision.confidence || 0 });
  }
  return { changes, skipped, costUSD: result.costUSD };
}
