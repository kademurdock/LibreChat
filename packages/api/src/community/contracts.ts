import type { Model, Types } from 'mongoose';
import type { Request, RequestHandler } from 'express';
import type { IClubhousePlayback, IPublicRelease } from '@librechat/data-schemas';
import type { LibraryAccount } from '../library/access';

export interface MediaTrack {
  title?: string;
  key: string;
  seconds?: number;
  clipBegin?: number;
  clipEnd?: number;
  mime: string;
}

export interface MediaBook {
  _id: Types.ObjectId;
  title: string;
  owner: Types.ObjectId;
  shared: boolean;
  state: string;
  kind: string;
  grownUpsOnly?: boolean;
  shortcutOf?: Types.ObjectId;
  tracks: MediaTrack[];
}

export interface CommunityDependencies {
  auth: RequestHandler;
  actor(req: Request): LibraryAccount;
  child(req: Request): Promise<boolean>;
  room(req: Request): string | null;
  openBook(req: Request, id: string): Promise<MediaBook | null>;
  sign(key: string, mime: string, seconds: number): Promise<string>;
  books: Model<MediaBook>;
  playback: Model<IClubhousePlayback>;
  releases: Model<IPublicRelease>;
  log(message: string): void;
}

export function trackBounds(track: MediaTrack): { begin: number; end: number | null } {
  const begin = Math.max(0, track.clipBegin || 0);
  const durationEnd = track.seconds && track.seconds > begin ? track.seconds : null;
  const end = track.clipEnd && track.clipEnd > begin ? track.clipEnd : durationEnd;
  return { begin, end };
}

export function playbackPosition(
  state: IClubhousePlayback,
  now: number,
  track: MediaTrack,
): number {
  const { begin, end } = trackBounds(track);
  const position = state.position + (state.playing ? Math.max(0, now - state.changedAt) / 1000 : 0);
  return Math.max(begin, end === null ? position : Math.min(end, position));
}
