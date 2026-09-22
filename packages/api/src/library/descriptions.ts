import { Router, json } from 'express';
import type { Request, RequestHandler } from 'express';

export interface DescriptionEntry { id: string; description: string }
interface BatchFilter { owner: string; _id: { $in: string[] }; state: 'ready'; kind: { $in: string[] } }
interface Operation {
  updateOne: {
    filter: { _id: string; owner: string; state: 'ready'; kind: { $in: string[] }; $or: object[] };
    update: { $set: { description: string } };
  };
}
interface StoredDescription { _id: { toString(): string }; description?: string }
interface DescriptionResult { id: string; status: 'confirmed' | 'preserved' | 'unavailable' | 'unconfirmed'; description?: string }
interface Dependencies {
  auth: RequestHandler;
  owner: (req: Request) => string;
  write: (operations: Operation[]) => Promise<void>;
  read: (filter: BatchFilter) => Promise<StoredDescription[]>;
}

export function descriptionOperations(entries: DescriptionEntry[], owner: string): Operation[] {
  if (!/^[a-f0-9]{24}$/i.test(owner)) throw new Error('Invalid owner.');
  if (!Array.isArray(entries) || !entries.length || entries.length > 200) throw new Error('Supply 1–200 descriptions.');
  const seen = new Set<string>();
  return entries.map((entry) => {
    if (!entry || typeof entry.id !== 'string' || !/^[a-f0-9]{24}$/i.test(entry.id) || seen.has(entry.id.toLowerCase())) throw new Error('Invalid or duplicate item ID.');
    if (typeof entry.description !== 'string' || !entry.description.trim() || entry.description.length > 2000) throw new Error('Descriptions must contain 1–2000 characters.');
    const id = entry.id.toLowerCase();
    seen.add(id);
    return { updateOne: {
      filter: { _id: id, owner, state: 'ready', kind: { $in: ['audio', 'video'] },
        $or: [{ description: { $exists: false } }, { description: null }, { description: { $regex: '^\\s*$' } }] },
      update: { $set: { description: entry.description } },
    } };
  });
}

export async function fillLibraryDescriptions(entries: DescriptionEntry[], owner: string, deps: Pick<Dependencies, 'write' | 'read'>): Promise<DescriptionResult[]> {
  const operations = descriptionOperations(entries, owner);
  await deps.write(operations);
  const ids = operations.map((op) => op.updateOne.filter._id);
  const stored = await deps.read({ owner, _id: { $in: ids }, state: 'ready', kind: { $in: ['audio', 'video'] } });
  const byId = new Map(stored.map((item) => [String(item._id), item.description || '']));
  return entries.map((entry) => {
    const id = entry.id.toLowerCase();
    if (!byId.has(id)) return { id, status: 'unavailable' as const };
    const description = byId.get(id)!;
    const status = description === entry.description ? 'confirmed' : description.trim() ? 'preserved' : 'unconfirmed';
    return { id, status, description };
  });
}

export function descriptionBatchRouter(deps: Dependencies): Router {
  const router = Router();
  router.get('/capabilities', deps.auth, (_req, res) => res.json({ version: 1, maxItems: 200, fillEmptyOnly: true }));
  router.post('/', deps.auth, json({ limit: '1mb' }), async (req, res) => {
    const entries: DescriptionEntry[] = req.body?.items;
    const owner = deps.owner(req);
    try { descriptionOperations(entries, owner); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid descriptions.' }); }
    try { return res.json({ version: 1, items: await fillLibraryDescriptions(entries, owner, deps) }); }
    catch { return res.status(500).json({ error: 'Could not confirm the description batch. Retrying preserves existing descriptions.' }); }
  });
  return router;
}
