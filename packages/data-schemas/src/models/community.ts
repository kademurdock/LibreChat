import { Schema } from 'mongoose';
import type { Model, Mongoose } from 'mongoose';

export interface IClubhousePlayback {
  _id: string;
  revision: number;
  host: string;
  hostName: string;
  heartbeat: number;
  book: string;
  track: number;
  key: string;
  position: number;
  playing: boolean;
  changedAt: number;
  expiresAt: Date;
}

export interface IPublicRelease {
  _id: string;
  title: string;
  description: string;
  book: string;
  track: number;
  key: string;
  publisher: string;
  publishedAt: Date;
  active: boolean;
}

export function createCommunityModels(mongoose: Mongoose): {
  playback: Model<IClubhousePlayback>;
  releases: Model<IPublicRelease>;
} {
  const playback = mongoose.models.KadeClubhousePlayback as Model<IClubhousePlayback> | undefined;
  const releases = mongoose.models.KadePublicRelease as Model<IPublicRelease> | undefined;
  const playbackSchema = new Schema<IClubhousePlayback>(
    {
      _id: String,
      revision: { type: Number, required: true },
      host: String,
      hostName: String,
      heartbeat: Number,
      book: String,
      track: Number,
      key: String,
      position: Number,
      playing: Boolean,
      changedAt: Number,
      expiresAt: { type: Date, index: { expires: 0 } },
    },
    { versionKey: false },
  );
  const releaseSchema = new Schema<IPublicRelease>(
    {
      _id: String,
      title: { type: String, required: true, maxlength: 160 },
      description: { type: String, maxlength: 3000 },
      book: String,
      track: Number,
      key: String,
      publisher: String,
      publishedAt: { type: Date, index: true },
      active: { type: Boolean, default: true },
    },
    { versionKey: false },
  );
  return {
    playback:
      playback ?? mongoose.model<IClubhousePlayback>('KadeClubhousePlayback', playbackSchema),
    releases: releases ?? mongoose.model<IPublicRelease>('KadePublicRelease', releaseSchema),
  };
}
