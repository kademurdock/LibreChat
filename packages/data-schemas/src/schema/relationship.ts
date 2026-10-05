import type { Schema, Mongoose } from 'mongoose';
import type {
  RelationshipImpression,
  RelationshipImpressions,
  RelationshipRevision,
} from '../types/continuity';

export function createRelationshipSchemas(mongoose: Mongoose): {
  relationship: Schema<RelationshipImpressions>;
  revision: Schema<RelationshipRevision>;
} {
  const impression = new mongoose.Schema<RelationshipImpression>(
    {
      stance: { type: String, enum: ['positive', 'mixed', 'negative', 'unknown'], required: true },
      confidence: { type: String, enum: ['tentative', 'supported'], required: true },
      basis: {
        type: String,
        enum: [
          'shared-interest',
          'compatibility',
          'care',
          'reliability',
          'dishonesty',
          'coercion',
          'boundary',
          'repair',
        ],
        required: true,
      },
      reason: { type: String, required: true, maxlength: 400 },
      evidence: { type: String, required: true, minlength: 8, maxlength: 300 },
      provenance: { type: String, enum: ['interaction', 'reported', 'dream'], required: true },
    },
    { _id: false },
  );
  return {
    relationship: new mongoose.Schema<RelationshipImpressions>(
      { affinity: impression, trust: impression, ease: impression },
      { _id: false },
    ),
    revision: new mongoose.Schema<RelationshipRevision>(
      {
        dimension: { type: String, enum: ['affinity', 'trust', 'ease'], required: true },
        previous: { type: impression, required: true },
        current: { type: impression, required: true },
      },
      { _id: false },
    ),
  };
}
