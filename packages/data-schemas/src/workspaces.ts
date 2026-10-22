import type { Collection, Connection } from 'mongoose';
import type {
  WorkspaceDevice,
  WorkspaceProject,
  WorkspaceSession,
  WorkspaceEvent,
  WorkspaceRun,
  WorkspaceReadState,
} from 'librechat-data-provider';

export interface WorkspaceOwner {
  userId: string;
  tenantId: string;
}

interface RecordIdentity extends WorkspaceOwner {
  _id: string;
  fingerprint: string;
}

export interface WorkspaceDeviceRecord extends RecordIdentity, WorkspaceDevice {
  tokenHash: string;
}
export interface WorkspaceProjectRecord extends RecordIdentity, WorkspaceProject {}
export interface WorkspaceSessionRecord extends RecordIdentity, WorkspaceSession {}
export interface WorkspaceRunRecord extends RecordIdentity, WorkspaceRun {
  revision: number;
  events: WorkspaceEvent[];
  activeDevice?: string;
  activeWorkspace?: string;
  leaseId?: string;
  workerInstanceId?: string;
  heartbeatAt?: string;
}
export interface WorkspaceReadRecord extends WorkspaceOwner {
  _id: string;
  readState: WorkspaceReadState;
}

export interface WorkspaceCollections {
  devices: Collection<WorkspaceDeviceRecord>;
  projects: Collection<WorkspaceProjectRecord>;
  sessions: Collection<WorkspaceSessionRecord>;
  runs: Collection<WorkspaceRunRecord>;
  reads: Collection<WorkspaceReadRecord>;
  ready: Promise<string[]>;
}

export function workspaceCollections(connection: Connection): WorkspaceCollections {
  const devices = connection.collection<WorkspaceDeviceRecord>('kadeworkspacedevices');
  const projects = connection.collection<WorkspaceProjectRecord>('kadeworkspaceprojects');
  const sessions = connection.collection<WorkspaceSessionRecord>('kadeworkspacesessions');
  const runs = connection.collection<WorkspaceRunRecord>('kadeworkspaceruns');
  const reads = connection.collection<WorkspaceReadRecord>('kadeworkspacereads');
  const scope = { userId: 1, tenantId: 1 } as const;
  const ready = Promise.all([
    devices.createIndex({ tokenHash: 1 }, { unique: true }),
    devices.createIndex({ ...scope, createdAt: -1, _id: -1 }),
    projects.createIndex({ ...scope, deviceId: 1, workspaceKey: 1 }, { unique: true }),
    projects.createIndex({ ...scope, createdAt: -1, _id: -1 }),
    sessions.createIndex({ ...scope, projectId: 1, createdAt: -1, _id: -1 }),
    sessions.createIndex({ ...scope, createdAt: -1, _id: -1 }),
    runs.createIndex(
      { ...scope, activeDevice: 1 },
      { unique: true, partialFilterExpression: { activeDevice: { $type: 'string' } } },
    ),
    runs.createIndex(
      { ...scope, activeWorkspace: 1 },
      { unique: true, partialFilterExpression: { activeWorkspace: { $type: 'string' } } },
    ),
    runs.createIndex({ ...scope, createdAt: -1, _id: -1 }),
    runs.createIndex({ ...scope, state: 1, heartbeatAt: 1 }),
  ]);
  void ready.catch(() => {});
  return { devices, projects, sessions, runs, reads, ready };
}
