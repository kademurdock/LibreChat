import type { Schema, Model, Mongoose } from 'mongoose';

export interface IPersonRecognition {
  ownerId: string;
  agentId: string;
  personId: string;
  displayName: string;
  aliases: string[];
  provenance: 'direct' | 'introduced' | 'heard-of' | 'dream';
  relationship?: 'partner' | 'parent' | 'child' | 'sibling' | 'friend' | 'colleague';
  sourceConversationIds: string[];
  forgotten: boolean;
  revision: number;
  policyRevision: number;
  clearedAt?: Date;
}

export function createPeopleModel(mongoose: Mongoose): Model<IPersonRecognition> {
  const existing = mongoose.models.KadePersonRecognition as Model<IPersonRecognition> | undefined;
  if (existing) return existing;
  const schema: Schema<IPersonRecognition> = new mongoose.Schema<IPersonRecognition>(
    {
      ownerId: { type: String, required: true },
      agentId: { type: String, required: true },
      personId: { type: String, required: true },
      displayName: { type: String, required: true, maxlength: 100 },
      aliases: { type: [String], required: true, validate: (value: string[]) => value.length <= 8 },
      provenance: {
        type: String,
        enum: ['direct', 'introduced', 'heard-of', 'dream'],
        required: true,
      },
      relationship: {
        type: String,
        enum: ['partner', 'parent', 'child', 'sibling', 'friend', 'colleague'],
      },
      sourceConversationIds: { type: [String], default: [] },
      forgotten: { type: Boolean, default: false },
      revision: { type: Number, default: 0 },
      policyRevision: { type: Number, default: 0 },
      clearedAt: { type: Date },
    },
    { versionKey: false, autoIndex: true },
  );
  schema.index({ ownerId: 1, agentId: 1, personId: 1 }, { unique: true });
  schema.index({ agentId: 1, aliases: 1 });
  return mongoose.model<IPersonRecognition>('KadePersonRecognition', schema, 'kadepeople');
}
