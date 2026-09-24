import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import type { FilterQuery, Model } from 'mongoose';
import type { ILibraryRequest, LibraryRequestStatus } from '@librechat/data-schemas';
import type { LibraryReader } from './catalog';

export interface RequestActor extends LibraryReader {
  name: string;
  admin: boolean;
}
export interface RequestInput {
  action: string;
  id?: string;
  title?: string;
  media?: string;
  clues?: string;
  note?: string;
  status?: LibraryRequestStatus;
  book?: string;
  version?: number;
  scope?: string;
  before?: string;
  depth?: string;
  researchConsent?: boolean;
}
export interface RequestDependencies {
  requests: Model<ILibraryRequest>;
  reader: (id: string) => Promise<RequestActor | null>;
  book: (id: string, reader: LibraryReader) => Promise<{ id: string; title: string } | null>;
  notify: (row: ILibraryRequest) => Promise<{ state: string; note?: string }>;
  startResearch: (
    owner: string,
    question: string,
    depth: string,
  ) => Promise<{ id: string; note: string }>;
  researchStatus: (owner: string, id: string) => Promise<{ state: string; note: string }>;
}

export interface RequestCard {
  id: string;
  title: string;
  media: string;
  clues: string;
  status: LibraryRequestStatus;
  version: number;
  unread: boolean;
  mine: boolean;
  requester?: string;
  history: ILibraryRequest['history'];
  research?: ILibraryRequest['research'];
  notification?: ILibraryRequest['notification'];
  item: { id: string; title: string; url: string } | null;
  availabilityNote: string;
  url: string;
  createdAt: Date;
  updatedAt: Date;
}
export interface RequestResult {
  request?: RequestCard;
  requests?: RequestCard[];
  next?: string | null;
  admin?: boolean;
  unread?: number;
  duplicate?: boolean;
  guidance?: string;
  ok?: boolean;
}
export interface RequestService {
  run: (input: RequestInput, actor: RequestActor) => Promise<RequestResult>;
  notifications: () => Promise<void>;
}

const statuses = ['requested', 'searching', 'located', 'fulfilled', 'unavailable', 'cancelled'];
const closed = new Set(['fulfilled', 'unavailable', 'cancelled']);
const isId = (id?: string): id is string => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id);
const text = (value: string | undefined, max: number) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

export class RequestError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function libraryRequestService(deps: RequestDependencies): RequestService {
  const rows = deps.requests;
  const access = (actor: RequestActor): FilterQuery<ILibraryRequest> =>
    actor.admin ? {} : { owner: actor.id };

  async function present(row: ILibraryRequest, actor: RequestActor): Promise<RequestCard> {
    const owner = row.owner === actor.id ? actor : await deps.reader(row.owner);
    const item = row.book && owner ? await deps.book(row.book, owner) : null;
    return {
      id: row._id,
      title: row.title,
      media: row.media,
      clues: row.clues,
      status: row.status,
      version: row.version,
      unread: row.owner === actor.id && row.seenVersion < row.version,
      mine: row.owner === actor.id,
      requester: actor.admin ? row.ownerName : undefined,
      history: row.history,
      research: row.research,
      notification: row.notification,
      item: item ? { ...item, url: '/library?book=' + item.id } : null,
      availabilityNote:
        row.book && !item ? 'The linked item is no longer available to this requester.' : '',
      url: '/library?request=' + row._id + '#libraryRequests',
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async function find(input: RequestInput, actor: RequestActor) {
    if (!isId(input.id)) throw new RequestError('Use the request ID from your request list.');
    const row = await rows.findOne({ _id: input.id, ...access(actor) }).lean();
    if (!row) throw new RequestError('Request not found.', 404);
    return row;
  }

  async function notifications() {
    for (let i = 0; i < 10; i++) {
      const row = await rows
        .findOneAndUpdate(
          { 'notification.state': 'pending' },
          { $set: { 'notification.state': 'sending' } },
          { new: true },
        )
        .lean();
      if (!row) return;
      const version = row.notification!.version;
      let receipt: { state: string; note?: string };
      try {
        receipt = await deps.notify(row);
      } catch {
        receipt = {
          state: 'unconfirmed',
          note: 'Phone delivery could not be confirmed. The update is saved here.',
        };
      }
      await rows.updateOne(
        { _id: row._id, 'notification.version': version, 'notification.state': 'sending' },
        { $set: { notification: { version, ...receipt } } },
      );
    }
  }

  async function run(input: RequestInput, actor: RequestActor): Promise<RequestResult> {
    if (!isId(actor.id)) throw new RequestError('Sign in to use library requests.', 401);
    if (input.action === 'create') {
      if (actor.hidden)
        throw new RequestError(
          'Shared library requests are available to approved family library members. Ask the library owner for access.',
          403,
        );
      const title = text(input.title, 240);
      const clues = text(input.clues, 4000);
      const media = text(input.media, 60) || 'Unknown';
      if (!title || (!clues && title.length < 3)) {
        throw new RequestError('Give the request a short title and describe what you remember.');
      }
      const normalized = [title, media, clues]
        .map((v) => v.toLowerCase().replace(/\s+/g, ' '))
        .join('\n');
      const activeKey = actor.id + ':' + createHash('sha256').update(normalized).digest('hex');
      const existing = await rows.findOne({ activeKey }).lean();
      if (existing) return { request: await present(existing, actor), duplicate: true };
      if ((await rows.countDocuments({ owner: actor.id, activeKey: { $exists: true } })) >= 50) {
        throw new RequestError(
          'You have 50 open requests. Close an old request before adding another.',
        );
      }
      let row: ILibraryRequest | null;
      try {
        row = await rows
          .findOneAndUpdate(
            { activeKey },
            {
              $setOnInsert: {
                _id: new Types.ObjectId().toHexString(),
                owner: actor.id,
                ownerName: actor.name,
                title,
                clues,
                media,
                status: 'requested',
                version: 1,
                seenVersion: 1,
                history: [{ at: new Date(), by: actor.name, status: 'requested', note: clues }],
              },
            },
            { upsert: true, new: true, runValidators: true },
          )
          .lean();
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 11000) throw error;
        row = await rows.findOne({ activeKey }).lean();
      }
      if (!row)
        throw new RequestError(
          'Could not save this request. Check your requests before retrying.',
          503,
        );
      return {
        request: await present(row, actor),
        guidance:
          'Request saved for the library owner to review. No acquisition or research has started.',
      };
    }
    if (input.action === 'list') {
      if (input.before && !isId(input.before)) throw new RequestError('Invalid request page.');
      if (input.status && !statuses.includes(input.status))
        throw new RequestError('Invalid request status.');
      const query: FilterQuery<ILibraryRequest> = {
        ...(actor.admin && input.scope === 'all' ? {} : { owner: actor.id }),
        ...(input.before ? { _id: { $lt: input.before } } : {}),
        ...(input.status ? { status: input.status } : {}),
      };
      const page = await rows.find(query).sort({ _id: -1 }).limit(26).lean();
      const visible = page.slice(0, 25);
      return {
        requests: await Promise.all(visible.map((row) => present(row, actor))),
        next: page.length > 25 ? visible[24]._id : null,
        admin: actor.admin,
        unread: await rows.countDocuments({
          owner: actor.id,
          $expr: { $lt: ['$seenVersion', '$version'] },
        }),
      };
    }
    const row = await find(input, actor);
    if (input.action === 'details') return { request: await present(row, actor) };
    if (input.action === 'read') {
      if (row.owner !== actor.id)
        throw new RequestError('Only the requester can mark their update as read.', 403);
      if (!Number.isInteger(input.version) || input.version! < 1 || input.version! > row.version) {
        throw new RequestError('Refresh this request before marking the update as read.');
      }
      await rows.updateOne(
        { _id: row._id, owner: actor.id },
        { $max: { seenVersion: input.version } },
      );
      return { ok: true };
    }
    if (input.action === 'research_status') {
      if (!row.research?.id) return { request: await present(row, actor) };
      const result = await deps.researchStatus(row.owner, row.research.id);
      await rows.updateOne(
        { _id: row._id, 'research.id': row.research.id },
        {
          $set: { 'research.state': result.state, 'research.note': result.note },
        },
      );
      row.research = { ...row.research, ...result };
      return {
        request: await present(row, actor),
        guidance:
          'A research result is not library availability. Only the library owner can fulfill the request.',
      };
    }
    if (input.action === 'research') {
      if (row.owner !== actor.id)
        throw new RequestError('Only the requester can start paid research for this request.', 403);
      if (closed.has(row.status)) throw new RequestError('This request is closed.');
      if (input.researchConsent !== true)
        throw new RequestError(
          'Ask whether the requester wants background research with the usual research charges before starting.',
        );
      const depth = input.depth || 'quick';
      if (!['quick', 'standard', 'deep'].includes(depth))
        throw new RequestError('Choose quick, standard, or deep research.');
      if (row.research?.state)
        return {
          request: await present(row, actor),
          guidance: 'Research was already attempted. Check its status; do not start a duplicate.',
        };
      const claimed = await rows.updateOne(
        { _id: row._id, version: row.version, 'research.state': { $exists: false } },
        {
          $set: { research: { state: 'starting', depth } },
        },
      );
      if (!claimed.modifiedCount)
        throw new RequestError('This request changed. Refresh it before continuing.', 409);
      try {
        const result = await deps.startResearch(
          row.owner,
          'Identify this requested media and find verifiable sources or acquisition leads. Preserve uncertainty; separate candidates from confirmed matches. Do not claim it is in our library. Title or working label: ' +
            row.title +
            '. Media: ' +
            row.media +
            '. Remembered clues: ' +
            row.clues,
          depth,
        );
        row.research = { id: result.id, state: 'running', depth, note: result.note };
      } catch {
        row.research = {
          state: 'unconfirmed',
          depth,
          note: 'Research start could not be confirmed. Check your existing research runs with the librarian before trying again.',
        };
      }
      await rows.updateOne(
        { _id: row._id, 'research.state': 'starting' },
        { $set: { research: row.research } },
      );
      return { request: await present(row, actor) };
    }
    if (!['note', 'cancel', 'update'].includes(input.action))
      throw new RequestError('Unknown library request action.');
    if (input.action === 'update' && !actor.admin)
      throw new RequestError('Only the library owner can change fulfillment status.', 403);
    if (input.action === 'cancel' && row.owner !== actor.id)
      throw new RequestError('Only the requester can cancel their request.', 403);
    if (!Number.isInteger(input.version) || input.version !== row.version) {
      throw new RequestError('This request changed. Read it again before saving your update.', 409);
    }
    const status =
      input.action === 'cancel'
        ? 'cancelled'
        : input.action === 'update'
          ? input.status
          : row.status;
    if (!status || !statuses.includes(status))
      throw new RequestError('Choose a valid request status.');
    if (closed.has(row.status))
      throw new RequestError(
        'This request is closed. Create a new request if you need another item.',
      );
    const note = text(input.note, 4000);
    if (!note && input.action !== 'cancel')
      throw new RequestError('Add a note explaining this update.');
    let book: string | undefined;
    if (status === 'fulfilled') {
      const owner = await deps.reader(row.owner);
      if (!isId(input.book) || !owner || !(await deps.book(input.book, owner))) {
        throw new RequestError(
          'Choose a ready library item that the requester can actually open. Share or finish importing it first.',
        );
      }
      book = input.book;
    }
    const version = row.version + 1;
    const notify = row.owner !== actor.id;
    const saved = await rows
      .findOneAndUpdate(
        { _id: row._id, version: row.version, ...access(actor) },
        {
          $set: {
            status,
            version,
            ...(book ? { book } : {}),
            ...(notify
              ? { notification: { version, state: 'pending' } }
              : { seenVersion: version }),
          },
          ...(closed.has(status) ? { $unset: { activeKey: 1 } } : {}),
          $push: {
            history: {
              $each: [
                {
                  at: new Date(),
                  by: actor.name,
                  status,
                  note: note || 'Cancelled by the requester.',
                },
              ],
              $slice: -100,
            },
          },
        },
        { new: true, runValidators: true },
      )
      .lean();
    if (!saved) throw new RequestError('This request changed. Read it again before saving.', 409);
    return { request: await present(saved, actor) };
  }
  return { run, notifications };
}

export function libraryRequestRouter(
  service: ReturnType<typeof libraryRequestService>,
  auth: RequestHandler,
  actor: (req: Request) => Promise<RequestActor | null>,
): Router {
  const router = Router();
  router.use(auth);
  const handle: RequestHandler = async (req, res) => {
    try {
      const reader = await actor(req);
      if (!reader) throw new RequestError('Sign in to use library requests.', 401);
      const input: RequestInput =
        req.method === 'GET'
          ? {
              action: 'list',
              scope: typeof req.query.scope === 'string' ? req.query.scope : '',
              before: typeof req.query.before === 'string' ? req.query.before : '',
            }
          : (req.body as RequestInput);
      if (!input || typeof input.action !== 'string')
        throw new RequestError('Choose a request action.');
      res.json(await service.run(input, reader));
    } catch (error) {
      res.status(error instanceof RequestError ? error.status : 503).json({
        error:
          error instanceof RequestError
            ? error.message
            : 'Library requests could not finish. Check your request list before retrying.',
      });
    }
  };
  router.get('/', handle);
  router.post('/', handle);
  return router;
}
