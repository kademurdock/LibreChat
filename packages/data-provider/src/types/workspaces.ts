export type WorkspacePlatform = 'windows' | 'ios' | 'android';
export type WorkspaceRuntime = 'inspect' | 'codex' | 'claude' | 'custom';
export type WorkspaceRunState =
  'queued' | 'running' | 'stopping' | 'done' | 'failed' | 'stopped' | 'interrupted';
export type WorkspaceReadKind = 'alerts' | 'announcements' | 'agentWork';

export interface WorkspaceDevice {
  id: string;
  name: string;
  platform: WorkspacePlatform;
  capabilities: string[];
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface WorkspaceProject {
  id: string;
  name: string;
  deviceId: string;
  workspaceKey: string;
  allowEdits: boolean;
  chatProjectId?: string;
  createdAt: string;
}

export interface WorkspaceSession {
  id: string;
  projectId: string;
  title: string;
  runtime: WorkspaceRuntime;
  model?: string;
  createdAt: string;
}

export interface WorkspaceEventInput {
  eventId: string;
  type: 'status' | 'message' | 'tool' | 'result';
  text?: string;
  state?: Exclude<WorkspaceRunState, 'queued' | 'stopping'>;
  data?: Record<string, string>;
}

export interface WorkspaceEvent extends WorkspaceEventInput {
  sequence: number;
  at: string;
}

export interface WorkspaceRun {
  id: string;
  sessionId: string;
  projectId: string;
  deviceId: string;
  workspaceKey: string;
  runtime: WorkspaceRuntime;
  model?: string;
  prompt: string;
  mode: 'inspect' | 'edit';
  state: WorkspaceRunState;
  lastSequence: number;
  seenSequence: number;
  unread: boolean;
  needsAttention: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceWorkerRun extends WorkspaceRun {
  leaseId: string;
}

export type WorkspaceReadState = Record<WorkspaceReadKind, string | null>;
