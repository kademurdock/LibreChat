import { randomBytes } from 'node:crypto';
import { Router, json } from 'express';
import type { Request, RequestHandler } from 'express';
import type { IClubhousePlayback } from '@librechat/data-schemas';
import { familyLibraryMember } from '../library/access';
import { playbackPosition, trackBounds } from './contracts';
import type { CommunityDependencies, MediaBook, MediaTrack } from './contracts';
import { publicPage, releaseCard } from './pages';

const idPattern = /^[a-f0-9]{24}$/i;
const slugPattern = /^[a-z0-9][a-z0-9-]{0,89}$/;
const leaseMs = 25000;

export function createCommunityRouter(deps: CommunityDependencies): ReturnType<typeof Router> {
  const router = Router();
  const uid = (req: Request): string => String(deps.actor(req).id || '');
  const owner: RequestHandler = (req, res, next) => {
    if (deps.actor(req).role !== 'ADMIN') {
      res.status(403).json({ error: 'Only Kade can publish on this website.' });
      return;
    }
    next();
  };
  const run =
    (handler: RequestHandler): RequestHandler =>
    async (req, res, next) => {
      try {
        await handler(req, res, next);
      } catch (error) {
        deps.log(error instanceof Error ? error.message : 'Community request failed');
        if (!res.headersSent)
          res.status(503).json({ error: 'This could not be completed. Please try again.' });
      }
    };
  const room: RequestHandler = (req, res, next) => {
    if (!deps.room(req)) {
      res.status(403).json({ error: 'Join the Clubhouse room again to use its player.' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
  };
  const permittedTrack = async (
    req: Request,
    bookId: string,
    index: number,
  ): Promise<{ book: MediaBook; track: MediaTrack } | null> => {
    if (
      !familyLibraryMember(deps.actor(req)) ||
      !idPattern.test(bookId) ||
      !Number.isInteger(index) ||
      index < 0
    )
      return null;
    const book = await deps.openBook(req, bookId);
    if (!book || !book.shared || book.state !== 'ready' || book.kind === 'text') return null;
    const track = book.tracks[index];
    if (!track?.key || !/^(audio|video)\//.test(track.mime)) return null;
    return { book, track };
  };

  router.get(
    '/api/community/library',
    deps.auth,
    run(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const publishing = req.query.publishing === '1' && deps.actor(req).role === 'ADMIN';
      if (!publishing && !familyLibraryMember(deps.actor(req))) {
        res.json({ items: [], more: false });
        return;
      }
      const q = String(req.query.q || '')
        .trim()
        .slice(0, 120);
      const page = Math.min(10000, Math.max(0, Number(req.query.page) || 0));
      const words = q
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
      const items = await deps.books
        .find({
          state: 'ready',
          kind: { $in: ['audio', 'video'] },
          ...(publishing ? {} : { shared: true }),
          ...((await deps.child(req)) ? { grownUpsOnly: { $ne: true } } : {}),
          ...(words.length ? { $and: words.map((word) => ({ title: word })) } : {}),
        })
        .sort({ title: 1, _id: 1 })
        .skip(Math.floor(page) * 40)
        .limit(41)
        .lean();
      res.json({
        items: items
          .slice(0, 40)
          .map((book) => ({ id: String(book._id), title: book.title, kind: book.kind })),
        more: items.length > 40,
      });
    }),
  );

  router.get(
    '/api/community/tracks/:id',
    deps.auth,
    run(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const bookId = String(req.params.id);
      if (!idPattern.test(bookId)) {
        res.status(404).json({ error: 'That recording is unavailable.' });
        return;
      }
      const book = await deps.openBook(req, bookId);
      if (!book || book.kind === 'text' || book.state !== 'ready') {
        res.status(404).json({ error: 'That recording is unavailable.' });
        return;
      }
      res.json({
        id: String(book._id),
        title: book.title,
        tracks: book.tracks.map((track, index) => ({
          index,
          title: track.title || `Part ${index + 1}`,
          mime: track.mime,
          ...trackBounds(track),
        })),
      });
    }),
  );

  router.get(
    '/api/community/playback',
    deps.auth,
    room,
    run(async (req, res) => {
      const now = Date.now();
      const state = await deps.playback.findById(deps.room(req)).lean();
      if (!state || state.expiresAt.getTime() <= now || !state.book) {
        res.json({ active: false, revision: state?.revision || 0, serverTime: now });
        return;
      }
      const media = await permittedTrack(req, state.book, state.track);
      if (!media || media.track.key !== state.key) {
        res.json({ active: false, unavailable: true, revision: state.revision, serverTime: now });
        return;
      }
      if (state.host === uid(req))
        await deps.playback.updateOne(
          { _id: state._id, host: state.host, revision: state.revision },
          { $set: { heartbeat: now } },
        );
      const bounds = trackBounds(media.track);
      const position = playbackPosition(state, now, media.track);
      res.json({
        active: true,
        revision: state.revision,
        serverTime: now,
        book: state.book,
        track: state.track,
        title: media.book.title,
        trackTitle: media.track.title || '',
        mime: media.track.mime,
        position,
        playing: state.playing && (bounds.end === null || position < bounds.end),
        ...bounds,
        hostName: state.hostName,
        controlling: state.host === uid(req),
        canTakeControl: now - state.heartbeat > leaseMs,
        ...(req.query.url === '1'
          ? { url: await deps.sign(media.track.key, media.track.mime, 3600) }
          : {}),
      });
    }),
  );

  router.post(
    '/api/community/playback',
    deps.auth,
    room,
    json({ limit: '4kb' }),
    run(async (req, res) => {
      const roomId = deps.room(req)!;
      const now = Date.now();
      const input: {
        action?: string;
        revision?: number;
        book?: string;
        track?: number;
        position?: number;
      } = req.body || {};
      if (
        !['load', 'play', 'pause', 'seek', 'stop', 'take-control'].includes(input.action || '') ||
        !Number.isSafeInteger(input.revision)
      ) {
        res.status(400).json({ error: 'Refresh the player and try that control again.' });
        return;
      }
      const old = await deps.playback.findById(roomId).lean();
      if ((old?.revision || 0) !== input.revision) {
        res.status(409).json({ error: 'The room changed. Try again with its current position.' });
        return;
      }
      const active = !!old?.book && old.expiresAt.getTime() > now;
      const hostAway = !active || now - old!.heartbeat > leaseMs;
      if (active && old!.host !== uid(req) && !(input.action === 'take-control' && hostAway)) {
        res
          .status(403)
          .json({ error: 'The person running the player controls playback for the room.' });
        return;
      }
      if (input.action !== 'load' && !active) {
        res.status(409).json({ error: 'Choose a recording first.' });
        return;
      }
      const bookId = input.action === 'load' ? String(input.book || '') : old!.book;
      const trackIndex = input.action === 'load' ? (input.track ?? 0) : old!.track;
      const media = await permittedTrack(req, bookId, trackIndex);
      if (!media && input.action !== 'stop') {
        res.status(404).json({ error: 'That shared recording is unavailable to your account.' });
        return;
      }
      if (media && input.action !== 'load' && media.track.key !== old!.key) {
        res.status(409).json({ error: 'This file changed. Choose it from the library again.' });
        return;
      }
      const bounds = media ? trackBounds(media.track) : { begin: 0, end: null };
      let position = bounds.begin;
      if (input.action !== 'load') {
        position = media ? playbackPosition(old!, now, media.track) : 0;
      }
      if (input.action === 'seek') {
        if (
          typeof input.position !== 'number' ||
          !Number.isFinite(input.position) ||
          input.position < bounds.begin ||
          input.position > (bounds.end ?? 604800)
        ) {
          res.status(400).json({ error: 'Choose a position within this recording.' });
          return;
        }
        position = input.position;
      }
      const stopped = input.action === 'stop';
      let playing = input.action === 'play';
      if (input.action === 'seek') {
        playing = old!.playing;
      }
      const state: IClubhousePlayback = {
        _id: roomId,
        revision: input.revision! + 1,
        host: uid(req),
        hostName: String(deps.actor(req).name || 'Host')
          .split(/\s+/)[0]
          .slice(0, 60),
        heartbeat: now,
        book: stopped ? '' : bookId,
        track: trackIndex,
        key: stopped ? '' : media!.track.key,
        position,
        playing,
        changedAt: now,
        expiresAt: new Date(now + 12 * 3600000),
      };
      if (old) {
        const changed = await deps.playback.replaceOne(
          {
            _id: roomId,
            revision: input.revision,
            ...(input.action === 'take-control' ? { heartbeat: old.heartbeat } : {}),
          },
          state,
        );
        if (!changed.modifiedCount) {
          res.status(409).json({ error: 'Another control reached the room first. Try again.' });
          return;
        }
      } else {
        try {
          await deps.playback.create(state);
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 11000) {
            res.status(409).json({ error: 'Someone else started the player. Refresh it.' });
            return;
          }
          throw error;
        }
      }
      res.json({ ok: true, revision: state.revision });
    }),
  );

  const publicMedia = async (slug: string) => {
    if (!slugPattern.test(slug)) return null;
    const release = await deps.releases.findOne({ _id: slug, active: true }).lean();
    if (!release) return null;
    const book = await deps.books.findOne({ _id: release.book, state: 'ready' }).lean();
    const track = book?.tracks[release.track];
    if (!track || track.key !== release.key) return null;
    return { release, track };
  };
  router.get(
    ['/', '/watch'],
    run(async (req, res) => {
      const rows = await deps.releases
        .find({ active: true })
        .sort({ publishedAt: -1 })
        .limit(100)
        .lean();
      const available = await Promise.all(rows.map((row) => publicMedia(row._id)));
      const cards = available.flatMap((item) => (item ? [releaseCard(item.release)] : []));
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(publicPage(req.path === '/' ? 'home' : 'watch', cards));
    }),
  );
  router.get(
    '/watch/:slug',
    run(async (req, res) => {
      const item = await publicMedia(String(req.params.slug));
      res.setHeader('Cache-Control', 'no-store');
      if (!item) {
        res.status(404).type('html').send(publicPage('missing', []));
        return;
      }
      res.type('html').send(publicPage('release', [], item.release, item.track));
    }),
  );
  router.get(
    '/api/community/releases/:slug/stream',
    run(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const item = await publicMedia(String(req.params.slug));
      if (!item) {
        res.status(404).json({ error: 'This release is unavailable.' });
        return;
      }
      res.redirect(302, await deps.sign(item.track.key, item.track.mime, 3600));
    }),
  );
  router.get(
    '/api/community/releases',
    deps.auth,
    owner,
    run(async (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const releases = await deps.releases
        .find({ active: true }, { key: 0, publisher: 0 })
        .sort({ publishedAt: -1 })
        .lean();
      res.json({ releases });
    }),
  );
  router.post(
    '/api/community/releases',
    deps.auth,
    owner,
    json({ limit: '8kb' }),
    run(async (req, res) => {
      const input: {
        book?: string;
        track?: number;
        title?: string;
        description?: string;
        confirmPublic?: boolean;
      } = req.body || {};
      if (
        input.confirmPublic !== true ||
        !idPattern.test(String(input.book)) ||
        !Number.isInteger(input.track) ||
        input.track! < 0 ||
        typeof input.title !== 'string' ||
        !input.title.trim()
      ) {
        res
          .status(400)
          .json({ error: 'Choose a recording, give it a title, and confirm public access.' });
        return;
      }
      const book = await deps.openBook(req, input.book!);
      const track = book?.tracks[input.track!];
      if (
        !book ||
        book.state !== 'ready' ||
        book.shortcutOf ||
        !track?.key ||
        !/^(audio|video)\//.test(track.mime)
      ) {
        res
          .status(400)
          .json({ error: 'Choose the original playable audio or video file from the library.' });
        return;
      }
      const slug =
        input.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 65) || 'release';
      const release = await deps.releases.create({
        _id: `${slug}-${randomBytes(4).toString('hex')}`,
        title: input.title.trim().slice(0, 160),
        description: String(input.description || '')
          .trim()
          .slice(0, 3000),
        book: String(book._id),
        track: input.track,
        key: track.key,
        publisher: uid(req),
        publishedAt: new Date(),
        active: true,
      });
      res.status(201).json({ url: `/watch/${release._id}` });
    }),
  );
  router.delete(
    '/api/community/releases/:slug',
    deps.auth,
    owner,
    run(async (req, res) => {
      await deps.releases.updateOne({ _id: String(req.params.slug) }, { $set: { active: false } });
      res.json({ ok: true });
    }),
  );
  return router;
}
