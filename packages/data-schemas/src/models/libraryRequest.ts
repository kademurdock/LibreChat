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
  /** Set while the request is open: one open request per person per title. */
  activeKey?: string;
  version: number;
  /** The requester has seen every change up to this version. */
  seenVersion: number;
  /** The library owner has reviewed every change up to this version. */
  reviewedVersion: number;
  book?: string;
  history: { at: Date; by: string; status: LibraryRequestStatus; note: string }[];
  /** Owner-started research; a lead, never availability. */
  research?: {
    id?: string;
    state: string;
    depth: string;
    by: string;
    at: Date;
    note?: string;
    costUsd?: number;
  };
  /** The last price the owner was told; research starts only against a fresh quote for its depth. */
  researchQuote?: { depth: string; maxCents: number; at: Date };
  /** The requester's alert for a change someone else made. `from` is the status before the first
   * change still waiting to go out, `status` and `item` what the library last set, so the alert
   * describes the library's change even if the requester edits the request meanwhile. */
  notification?: {
    version: number;
    state: string;
    at: Date;
    note?: string;
    claim?: string;
    from?: LibraryRequestStatus;
    status?: LibraryRequestStatus;
    item?: string;
  };
  /** When this request reached the library owner's digest (or was excluded from it). */
  digestedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Small shared state, such as when the owner's digest last went out. */
export interface ILibraryRequestState {
  _id: string;
  at: Date;
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
      reviewedVersion: { type: Number, default: 0 },
      book: String,
      history: [{ _id: false, at: Date, by: String, status: String, note: String }],
      research: {
        id: String,
        state: String,
        depth: String,
        by: String,
        at: Date,
        note: String,
        costUsd: Number,
      },
      researchQuote: { depth: String, maxCents: Number, at: Date },
      notification: {
        version: Number,
        state: String,
        at: Date,
        note: String,
        claim: String,
        from: String,
        status: String,
        item: String,
      },
      digestedAt: Date,
    },
    { timestamps: true, versionKey: false },
  );
  schema.index({ activeKey: 1 }, { unique: true, sparse: true });
  schema.index({ owner: 1, _id: -1 });
  schema.index({ status: 1, _id: -1 });
  schema.index({ 'notification.state': 1, 'notification.at': 1 });
  schema.index({ digestedAt: 1, _id: 1 });
  return mongoose.model<ILibraryRequest>('KadeMediaRequest', schema);
}

export function createLibraryRequestStateModel(mongoose: Mongoose): Model<ILibraryRequestState> {
  if (mongoose.models.KadeMediaRequestState) {
    return mongoose.models.KadeMediaRequestState as Model<ILibraryRequestState>;
  }
  const schema = new Schema<ILibraryRequestState>({ _id: String, at: Date }, { versionKey: false });
  return mongoose.model<ILibraryRequestState>('KadeMediaRequestState', schema);
}
