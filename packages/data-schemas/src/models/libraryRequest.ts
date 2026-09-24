import { Schema } from 'mongoose';
import type { Model, Mongoose } from 'mongoose';

export type LibraryRequestStatus =
  | 'requested'
  | 'searching'
  | 'located'
  | 'fulfilled'
  | 'unavailable'
  | 'cancelled';

export interface ILibraryRequest {
  _id: string;
  owner: string;
  ownerName: string;
  title: string;
  media: string;
  clues: string;
  status: LibraryRequestStatus;
  activeKey?: string;
  version: number;
  seenVersion: number;
  book?: string;
  history: { at: Date; by: string; status: LibraryRequestStatus; note: string }[];
  research?: { id?: string; state: string; depth: string; note?: string };
  notification?: { version: number; state: string; note?: string };
  createdAt: Date;
  updatedAt: Date;
}

export function createLibraryRequestModel(mongoose: Mongoose): Model<ILibraryRequest> {
  if (mongoose.models.KadeMediaRequest) {
    return mongoose.models.KadeMediaRequest as Model<ILibraryRequest>;
  }
  const schema = new Schema<ILibraryRequest>(
    {
      _id: String,
      owner: { type: String, required: true },
      ownerName: String,
      title: { type: String, required: true, maxlength: 240 },
      media: String,
      clues: { type: String, maxlength: 4000 },
      status: {
        type: String,
        enum: ['requested', 'searching', 'located', 'fulfilled', 'unavailable', 'cancelled'],
        default: 'requested',
      },
      activeKey: String,
      version: { type: Number, default: 1 },
      seenVersion: { type: Number, default: 1 },
      book: String,
      history: [{ _id: false, at: Date, by: String, status: String, note: String }],
      research: { id: String, state: String, depth: String, note: String },
      notification: { version: Number, state: String, note: String },
    },
    { timestamps: true, versionKey: false },
  );
  schema.index({ activeKey: 1 }, { unique: true, sparse: true });
  schema.index({ owner: 1, _id: -1 });
  schema.index({ status: 1, _id: -1 });
  schema.index({ 'notification.state': 1 });
  return mongoose.model<ILibraryRequest>('KadeMediaRequest', schema);
}
