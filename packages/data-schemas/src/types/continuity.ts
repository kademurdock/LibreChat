export type RelationshipDimension = 'affinity' | 'trust' | 'ease';
export type RelationshipBasis =
  | 'shared-interest'
  | 'compatibility'
  | 'care'
  | 'reliability'
  | 'dishonesty'
  | 'coercion'
  | 'boundary'
  | 'repair';

export interface RelationshipImpression {
  stance: 'positive' | 'mixed' | 'negative' | 'unknown';
  confidence: 'tentative' | 'supported';
  basis: RelationshipBasis;
  reason: string;
  evidence: string;
  provenance: 'interaction' | 'reported' | 'dream';
}

export type RelationshipImpressions = Partial<
  Record<RelationshipDimension, RelationshipImpression>
>;

export interface RelationshipRevision {
  dimension: RelationshipDimension;
  previous: RelationshipImpression;
  current: RelationshipImpression;
}
