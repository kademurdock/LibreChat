import type { Types, Document } from 'mongoose';

export type MemoryStatus = 'active' | 'superseded';
export type MemoryEntryType = 'fact' | 'reminder';

// Base memory interfaces
export interface IMemoryEntry extends Document {
  userId: Types.ObjectId;
  agentId?: string;
  key: string;
  value: string;
  tokenCount?: number;
  status?: MemoryStatus;
  supersedes?: Types.ObjectId;
  type?: MemoryEntryType;
  dueAt?: Date;
  recurrence?: string;
  completed?: boolean;
  updated_at?: Date;
  tenantId?: string;
}

export interface IMemoryEntryLean {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  agentId?: string;
  key: string;
  value: string;
  tokenCount?: number;
  status?: MemoryStatus;
  supersedes?: Types.ObjectId;
  type?: MemoryEntryType;
  dueAt?: Date;
  recurrence?: string;
  completed?: boolean;
  updated_at?: Date;
  tenantId?: string;
  __v?: number;
}

// Method parameter interfaces
export interface SetMemoryParams {
  userId: string | Types.ObjectId;
  /** Omit or pass null for the shared bucket; pass the agent's string id for that agent's own bucket. */
  agentId?: string | null;
  key: string;
  value: string;
  tokenCount?: number;
  /** Reminder-groundwork fields (Part 3) -- optional, default type is 'fact'. */
  type?: MemoryEntryType;
  dueAt?: Date;
  recurrence?: string;
  completed?: boolean;
}

export interface DeleteMemoryParams {
  userId: string | Types.ObjectId;
  agentId?: string | null;
  key: string;
}

export interface GetFormattedMemoriesParams {
  userId: string | Types.ObjectId;
  /** When provided, merges this agent's own bucket in with the shared one. */
  agentId?: string | null;
  /** When true and agentId is set, fetch ONLY that agent's bucket -- don't merge in shared. Default false (merge, for live chat context). */
  onlyThisBucket?: boolean;
}

export interface GetAllUserMemoriesOptions {
  /** Filter to one bucket: omit for "all buckets" (back-compat default), null for shared-only, a string for one agent's bucket. */
  agentId?: string | null;
  /** Include 'superseded' history rows. Default false -- most callers only want current facts. */
  includeSuperseded?: boolean;
}

export interface DeleteAllUserMemoriesOptions {
  /** Omit to wipe every bucket for the user (back-compat default); pass null/agentId to scope the wipe. */
  agentId?: string | null;
}

/** One (user, bucket) pair that currently has active memory content. Platform-wide -- not scoped to a caller. */
export interface MemoryBucketRef {
  userId: Types.ObjectId;
  /** null = the shared bucket; string = one agent's own agent_notes bucket. */
  agentId: string | null;
}

// Result interfaces
export interface MemoryResult {
  ok: boolean;
}

export interface FormattedMemoriesResult {
  withKeys: string;
  withoutKeys: string;
  totalTokens?: number;
}
