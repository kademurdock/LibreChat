import { logger, getTenantId, SYSTEM_TENANT_ID } from '@librechat/data-schemas';
import { EventEmitter } from 'events';
import {
  Constants,
  UsageEvents,
  parseTextParts,
  reconcileContextUsage,
  promptTokensFromUsage,
} from 'librechat-data-provider';
import type {
  TMessageContentParts,
  TContextUsageEvent,
  TTokenUsageEvent,
  Agents,
} from 'librechat-data-provider';
import type { StandardGraph } from '@librechat/agents';
import type {
  SerializableJobData,
  IEventTransport,
  UsageMetadata,
  AbortResult,
  IJobStore,
} from './interfaces/IJobStore';
import type { GenerationJobStore } from '~/app/metrics';
import type * as t from '~/types';
import {
  recordGenerationStreamResumePendingEvents,
  recordGenerationStreamSubscription,
  setGenerationJobsInFlight,
  recordGenerationJob,
} from '~/app/metrics';
import { InMemoryEventTransport } from './implementations/InMemoryEventTransport';
import { InMemoryJobStore } from './implementations/InMemoryJobStore';
import { filterPersistableAbortContent } from './abortContent';

/** Error surfaced to any client still attached when a stale/hung job is reaped. */
const REAPED_JOB_ERROR = 'Generation timed out';
const OAUTH_TOOL_CALL_PREFIX = `oauth${Constants.mcp_delimiter}`;

function getToolCallName(toolCall: unknown): unknown {
  return toolCall != null && typeof toolCall === 'object' && 'name' in toolCall
    ? toolCall.name
    : undefined;
}

function hasOAuthToolCall(toolCalls: unknown): boolean {
  return (
    Array.isArray(toolCalls) &&
    toolCalls.some((toolCall) => {
      const name = getToolCallName(toolCall);
      return typeof name === 'string' && name.startsWith(OAUTH_TOOL_CALL_PREFIX);
    })
  );
}

function getReplayStepId(event: t.ServerSentEvent): unknown {
  if (!('event' in event) || !event.data || typeof event.data !== 'object') {
    return undefined;
  }

  if (event.event === 'on_run_step' || event.event === 'on_run_step_delta') {
    return 'id' in event.data ? event.data.id : undefined;
  }

  if (event.event === 'on_run_step_completed') {
    const result = 'result' in event.data ? event.data.result : undefined;
    return result != null && typeof result === 'object' && 'id' in result ? result.id : undefined;
  }

  return undefined;
}

function isOAuthReplayEvent(event: t.ServerSentEvent): boolean {
  if (!('event' in event) || !event.data || typeof event.data !== 'object') {
    return false;
  }

  if (event.event === 'on_run_step') {
    const stepDetails = 'stepDetails' in event.data ? event.data.stepDetails : undefined;
    return (
      stepDetails != null &&
      typeof stepDetails === 'object' &&
      'tool_calls' in stepDetails &&
      hasOAuthToolCall(stepDetails.tool_calls)
    );
  }

  if (event.event === 'on_run_step_delta') {
    const delta = 'delta' in event.data ? event.data.delta : undefined;
    if (delta == null || typeof delta !== 'object') {
      return false;
    }
    if (!('tool_calls' in delta) || !hasOAuthToolCall(delta.tool_calls)) {
      return false;
    }

    return true;
  }

  if (event.event === 'on_run_step_completed') {
    const result = 'result' in event.data ? event.data.result : undefined;
    if (result == null || typeof result !== 'object' || !('tool_call' in result)) {
      return false;
    }
    const name = getToolCallName(result.tool_call);
    return typeof name === 'string' && name.startsWith(OAUTH_TOOL_CALL_PREFIX);
  }

  return false;
}

/**
 * Configuration options for GenerationJobManager
 */
export interface GenerationJobManagerOptions {
  jobStore?: IJobStore;
  eventTransport?: IEventTransport;
  /**
   * If true, cleans up event transport immediately when job completes.
   * If false, keeps EventEmitters until periodic cleanup for late reconnections.
   * Default: true (immediate cleanup to save memory)
   */
  cleanupOnComplete?: boolean;
}

/**
 * Runtime state for active jobs - not serializable, kept in-memory per instance.
 * Contains AbortController, ready promise, and other non-serializable state.
 *
 * @property abortController - Controller to abort the generation
 * @property readyPromise - Resolves immediately (legacy, kept for API compatibility)
 * @property resolveReady - Function to resolve readyPromise
 * @property finalEvent - Cached final event for late subscribers
 * @property errorEvent - Cached error event for late subscribers (errors before client connects)
 * @property syncSent - Whether sync event was sent (reset when all subscribers leave)
 * @property earlyEventBuffer - Buffer for events emitted before first subscriber connects
 * @property hasSubscriber - Whether at least one subscriber has connected
 * @property allSubscribersLeftHandlers - Internal handlers for disconnect events.
 *   These are stored separately from eventTransport subscribers to avoid being counted
 *   in subscriber count. This is critical: if these were registered via subscribe(),
 *   they would count as subscribers, causing isFirstSubscriber() to return false
 *   when the real client connects, which would prevent readyPromise from resolving.
 */
interface RuntimeJobState {
  abortController: AbortController;
  readyPromise: Promise<void>;
  resolveReady: () => void;
  finalEvent?: t.ServerSentEvent;
  errorEvent?: string;
  syncSent: boolean;
  earlyEventBuffer: t.ServerSentEvent[];
  hasSubscriber: boolean;
  allSubscribersLeftHandlers?: Array<(...args: unknown[]) => void>;
}

/**
 * Manages generation jobs for resumable LLM streams.
 *
 * Architecture: Composes two pluggable services via dependency injection:
 * - jobStore: Job metadata + content state (InMemory → Redis for horizontal scaling)
 * - eventTransport: Pub/sub events (InMemory → Redis Pub/Sub for horizontal scaling)
 *
 * Content state is tied to jobs:
 * - In-memory: jobStore holds WeakRef to graph for live content/run steps access
 * - Redis: jobStore persists chunks, reconstructs content on demand
 *
 * All storage methods are async to support both in-memory and external stores (Redis, etc.).
 *
 * @example Redis injection:
 * ```ts
 * const manager = new GenerationJobManagerClass({
 *   jobStore: new RedisJobStore(redisClient),
 *   eventTransport: new RedisPubSubTransport(redisClient),
 * });
 * ```
 */
class GenerationJobManagerClass {
  /** Job metadata + content state storage - swappable for Redis, etc. */
  private jobStore: IJobStore;
  /** Event pub/sub transport - swappable for Redis Pub/Sub, etc. */
  private eventTransport: IEventTransport;

  /** Runtime state - always in-memory, not serializable */
  private runtimeState = new Map<string, RuntimeJobState>();

  /** Jobs actively generating in this process. */
  private runningJobs = new Set<string>();

  /** Serializes replay-event read/modify/write updates per stream. */
  private replayEventWriteQueues = new Map<string, Promise<void>>();

  /** Serializes token-usage read/modify/write updates per stream. */
  private tokenUsageWriteQueues = new Map<string, Promise<void>>();

  private cleanupInterval: NodeJS.Timeout | null = null;

  /** Whether we're using Redis stores */
  private _isRedis = false;

  /** Whether to cleanup event transport immediately on job completion */
  private _cleanupOnComplete = true;

  constructor(options?: GenerationJobManagerOptions) {
    this.jobStore =
      options?.jobStore ?? new InMemoryJobStore({ ttlAfterComplete: 0, maxJobs: 1000 });
    this.eventTransport = options?.eventTransport ?? new InMemoryEventTransport();
    this._cleanupOnComplete = options?.cleanupOnComplete ?? true;
  }

  /**
   * Initialize the job manager with periodic cleanup.
   * Call this once at application startup.
   */
  initialize(): void {
    if (this.cleanupInterval) {
      return;
    }

    this.jobStore.initialize();

    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000);

    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }

    logger.debug('[GenerationJobManager] Initialized');
  }

  /**
   * Configure the manager with custom stores.
   * Call this BEFORE initialize() to use Redis or other stores.
   *
   * @example Using Redis
   * ```ts
   * import { createStreamServicesFromCache } from '~/stream/createStreamServices';
   * import { cacheConfig, ioredisClient } from '~/cache';
   *
   * const services = createStreamServicesFromCache({ cacheConfig, ioredisClient });
   * GenerationJobManager.configure(services);
   * GenerationJobManager.initialize();
   * ```
   */
  configure(services: {
    jobStore: IJobStore;
    eventTransport: IEventTransport;
    isRedis?: boolean;
    cleanupOnComplete?: boolean;
  }): void {
    const previousStore = this.storeLabel;
    if (this.cleanupInterval) {
      logger.warn(
        '[GenerationJobManager] Reconfiguring after initialization - destroying existing services',
      );
      this.destroy();
    }

    this.runningJobs.clear();
    setGenerationJobsInFlight(previousStore, 0);

    this.jobStore = services.jobStore;
    this.eventTransport = services.eventTransport;
    this._isRedis = services.isRedis ?? false;
    this._cleanupOnComplete = services.cleanupOnComplete ?? true;
    this.syncRunningJobMetrics();

    logger.info(
      `[GenerationJobManager] Configured with ${this._isRedis ? 'Redis' : 'in-memory'} stores`,
    );
  }

  /**
   * Check if using Redis stores.
   */
  get isRedis(): boolean {
    return this._isRedis;
  }

  private get storeLabel(): GenerationJobStore {
    return this._isRedis ? 'redis' : 'memory';
  }

  private syncRunningJobMetrics(store: GenerationJobStore = this.storeLabel): void {
    setGenerationJobsInFlight(store, this.runningJobs.size);
  }

  /**
   * Get the job store instance (for advanced use cases).
   */
  getJobStore(): IJobStore {
    return this.jobStore;
  }

  /**
   * Create a new generation job.
   *
   * This sets up:
   * 1. Serializable job data in the job store
   * 2. Runtime state including readyPromise (resolves when first SSE client connects)
   * 3. allSubscribersLeft callback for handling client disconnections
   *
   * The readyPromise mechanism ensures generation doesn't start before the client
   * is ready to receive events. The controller awaits this promise (with a short timeout)
   * before starting LLM generation.
   *
   * @param streamId - Unique identifier for this stream
   * @param userId - User who initiated the request
   * @param conversationId - Optional conversation ID for lookup
   * @returns A facade object for the GenerationJob
   */
  async createJob(
    streamId: string,
    userId: string,
    conversationId?: string,
  ): Promise<t.GenerationJob> {
    const tenantId = getTenantId();
    const safeTenantId = tenantId && tenantId !== SYSTEM_TENANT_ID ? tenantId : undefined;
    const jobData = await this.jobStore.createJob(streamId, userId, conversationId, safeTenantId);

    /**
     * Create runtime state with readyPromise.
     *
     * With the resumable stream architecture, we no longer need to wait for the
     * first subscriber before starting generation:
     * - Redis mode: Events are persisted and can be replayed via sync
     * - In-memory mode: Content is aggregated and sent via sync on connect
     *
     * We resolve readyPromise immediately to eliminate startup latency.
     * The sync mechanism handles late-connecting clients.
     */
    let resolveReady: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    const runtime: RuntimeJobState = {
      abortController: new AbortController(),
      readyPromise,
      resolveReady: resolveReady!,
      syncSent: false,
      earlyEventBuffer: [],
      hasSubscriber: false,
    };
    this.runtimeState.set(streamId, runtime);
    this.runningJobs.add(streamId);
    this.syncRunningJobMetrics();
    recordGenerationJob(this.storeLabel, 'created');

    // Resolve immediately - early event buffer handles late subscribers
    resolveReady!();

    /**
     * Set up all-subscribers-left callback.
     * When all SSE clients disconnect, this:
     * 1. Resets syncSent so reconnecting clients get sync event (persisted to Redis)
     * 2. Calls any registered allSubscribersLeft handlers (e.g., to save partial responses)
     */
    this.eventTransport.onAllSubscribersLeft(streamId, () => {
      const currentRuntime = this.runtimeState.get(streamId);
      if (currentRuntime) {
        currentRuntime.syncSent = false;
        currentRuntime.hasSubscriber = false;
        // Persist syncSent=false to Redis for cross-replica consistency
        this.jobStore.updateJob(streamId, { syncSent: false }).catch((err) => {
          logger.error(`[GenerationJobManager] Failed to persist syncSent=false:`, err);
        });
        // Call registered handlers (from job.emitter.on('allSubscribersLeft', ...))
        if (currentRuntime.allSubscribersLeftHandlers) {
          this.jobStore
            .getContentParts(streamId)
            .then((result) => {
              const parts = result?.content ?? [];
              for (const handler of currentRuntime.allSubscribersLeftHandlers ?? []) {
                try {
                  handler(parts);
                } catch (err) {
                  logger.error(`[GenerationJobManager] Error in allSubscribersLeft handler:`, err);
                }
              }
            })
            .catch((err) => {
              logger.error(
                `[GenerationJobManager] Failed to get content parts for allSubscribersLeft handlers:`,
                err,
              );
            });
        }
      }
    });

    /**
     * Set up cross-replica abort listener (Redis mode only).
     * When abort is triggered on ANY replica, this replica receives the signal
     * and aborts its local AbortController (if it's the one running generation).
     */
    if (this.eventTransport.onAbort) {
      this.eventTransport.onAbort(streamId, () => {
        const currentRuntime = this.runtimeState.get(streamId);
        if (currentRuntime && !currentRuntime.abortController.signal.aborted) {
          logger.debug(`[GenerationJobManager] Received cross-replica abort for ${streamId}`);
          currentRuntime.abortController.abort();
        }
      });
    }

    logger.debug(`[GenerationJobManager] Created job: ${streamId}`);

    // Return facade for backwards compatibility
    return this.buildJobFacade(streamId, jobData, runtime);
  }

  /**
   * Build a GenerationJob facade from composed services.
   *
   * This facade provides a unified API (job.emitter, job.abortController, etc.)
   * while internally delegating to the injected services (jobStore, eventTransport,
   * contentState). This allows swapping implementations (e.g., Redis) without
   * changing consumer code.
   *
   * IMPORTANT: The emitterProxy.on('allSubscribersLeft') handler registration
   * does NOT use eventTransport.subscribe(). This is intentional:
   *
   * If we used subscribe() for internal handlers, those handlers would count
   * as subscribers. When the real SSE client connects, isFirstSubscriber()
   * would return false (because internal handler was "first"), and readyPromise
   */
  private buildJobFacade(
    streamId: string,
    jobData: SerializableJobData,
    runtime: RuntimeJobState,
  ): t.GenerationJob {
    const emitter = new EventEmitter();
    const emitterProxy = new Proxy(emitter, {
      get(target, prop, receiver) {
        if (prop === 'on') {
          return (event: string, handler: (...args: unknown[]) => void) => {
            if (event === 'allSubscribersLeft') {
              // Store handler separately - don't register on EventEmitter
              const currentRuntime = runtime;
              if (!currentRuntime.allSubscribersLeftHandlers) {
                currentRuntime.allSubscribersLeftHandlers = [];
              }
              currentRuntime.allSubscribersLeftHandlers.push(handler);
              return target;
            }
            return Reflect.get(target, prop, receiver).apply(target, [event, handler]);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    return {
      createdAt: jobData.createdAt,
      emitter: emitterProxy,
      abortController: runtime.abortController,
      readyPromise: runtime.readyPromise,
      watcherCount: 0,
    };
  }

  /**
   * Subscribe to a stream's events.
   * Returns a subscription object with an unsubscribe method.
   */
  async subscribe(
    streamId: string,
    onChunk: t.ChunkHandler,
    onDone?: t.DoneHandler,
    onError?: t.ErrorHandler,
    options?: t.SubscribeOptions,
  ): Promise<{ unsubscribe: t.UnsubscribeFn } | null> {
    // Ensure runtime state exists (lazy creation for cross-replica jobs)
    let runtime = this.runtimeState.get(streamId);
    if (!runtime) {
      const jobData = await this.jobStore.getJob(streamId);
      if (!jobData) {
        return null;
      }
      // Lazy-create runtime state from persisted job data
      let resolveReady: () => void;
      const readyPromise = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      runtime = {
        abortController: new AbortController(),
        readyPromise,
        resolveReady: resolveReady!,
        syncSent: jobData.syncSent,
        earlyEventBuffer: [],
        hasSubscriber: false,
      };
      this.runtimeState.set(streamId, runtime);
      resolveReady!();
    }

    // If job has an error, send it immediately to the onError callback
    if (runtime.errorEvent && onError) {
      setImmediate(() => {
        onError(runtime.errorEvent!);
      });
      return { unsubscribe: () => {} };
    }

    // If job has a final event and no error, send it via onDone
    if (runtime.finalEvent && onDone) {
      setImmediate(() => {
        onDone(runtime.finalEvent!);
      });
      return { unsubscribe: () => {} };
    }

    const skipBufferReplay = options?.skipBufferReplay ?? false;

    // Subscribe to event transport
    const result = this.eventTransport.subscribe(streamId, {
      onChunk,
      onDone: onDone ? (event) => onDone(event) : undefined,
      onError: onError ? (error) => onError(error) : undefined,
    });

    // Replay early event buffer
    if (!skipBufferReplay && runtime.earlyEventBuffer.length > 0) {
      const buffer = [...runtime.earlyEventBuffer];
      for (const event of buffer) {
        setImmediate(() => {
          onChunk(event);
        });
      }
    }

    runtime.hasSubscriber = true;

    // Clear buffer after replay or skip
    if (skipBufferReplay) {
      runtime.earlyEventBuffer = [];
    }

    logger.debug(
      `[GenerationJobManager] subscribe ${streamId}: skipBufferReplay=${skipBufferReplay} bufferSize=${runtime.earlyEventBuffer.length}`,
    );

    recordGenerationStreamSubscription(this.storeLabel);

    return result;
  }

  /**
   * Atomic subscribe-and-resume for reconnecting clients.
   * Returns resume state, pending events, and a subscription in one async call.
   */
  async subscribeWithResume(
    streamId: string,
    onChunk: t.ChunkHandler,
    onDone?: t.DoneHandler,
    onError?: t.ErrorHandler,
  ): Promise<t.SubscribeWithResumeResult> {
    // Get resume state before subscribing
    const resumeState = await this.getResumeState(streamId);

    // Subscribe to events
    const subscription = await this.subscribe(streamId, onChunk, onDone, onError, {
      skipBufferReplay: true,
    });

    // For in-memory mode, drain earlyEventBuffer as pendingEvents
    let pendingEvents: t.ServerSentEvent[] = [];
    if (!this._isRedis) {
      const runtime = this.runtimeState.get(streamId);
      if (runtime) {
        pendingEvents = [...runtime.earlyEventBuffer];
        runtime.earlyEventBuffer = [];
      }
    }

    recordGenerationStreamResumePendingEvents(this.storeLabel, pendingEvents.length);

    return { subscription, resumeState, pendingEvents };
  }

  /**
   * Emit a chunk event to all subscribers.
   */
  async emitChunk(streamId: string, event: t.ServerSentEvent): Promise<void> {
    const runtime = this.runtimeState.get(streamId);

    // Buffer events if no subscriber yet
    if (runtime && !runtime.hasSubscriber) {
      runtime.earlyEventBuffer.push(event);
    }

    // Emit via event transport
    this.eventTransport.emitChunk(streamId, event);

    // Track title event
    if (event.event === 'title') {
      await this.jobStore.updateJob(streamId, { titleEvent: JSON.stringify(event) });
    }

    // Track token usage events
    if (event.event === 'on_token_usage') {
      await this.accumulateTokenUsage(streamId, event);
    }

    // Track OAuth replay events
    if (isOAuthReplayEvent(event)) {
      await this.accumulateReplayEvent(streamId, event);
    }

    // Record activity for stale-job failsafe
    this.jobStore.recordActivity?.(streamId);
  }

  /**
   * Accumulate token usage events for resume state.
   */
  private async accumulateTokenUsage(
    streamId: string,
    event: t.ServerSentEvent,
  ): Promise<void> {
    const queue = this.tokenUsageWriteQueues;
    const previous = queue.get(streamId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const jobData = await this.jobStore.getJob(streamId);
      if (!jobData) {
        return;
      }
      const existing = jobData.tokenUsage ? JSON.parse(jobData.tokenUsage) : [];
      existing.push(event.data);
      await this.jobStore.updateJob(streamId, { tokenUsage: JSON.stringify(existing) });
    });
    queue.set(streamId, next);
    await next;
  }

  /**
   * Accumulate OAuth replay events for resume state.
   */
  private async accumulateReplayEvent(
    streamId: string,
    event: t.ServerSentEvent,
  ): Promise<void> {
    const queue = this.replayEventWriteQueues;
    const previous = queue.get(streamId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const jobData = await this.jobStore.getJob(streamId);
      if (!jobData) {
        return;
      }
      const existing = jobData.replayEvents ? JSON.parse(jobData.replayEvents) : [];
      const stepId = getReplayStepId(event);

      // Replace existing event for same step id (OAuth prompt updates)
      if (stepId !== undefined) {
        const existingIndex = existing.findIndex(
          (e: t.ServerSentEvent) => getReplayStepId(e) === stepId,
        );
        if (existingIndex !== -1) {
          existing[existingIndex] = event;
        } else {
          existing.push(event);
        }
      } else {
        existing.push(event);
      }

      await this.jobStore.updateJob(streamId, { replayEvents: JSON.stringify(existing) });
    });
    queue.set(streamId, next);
    await next;
  }

  /**
   * Emit an error event to subscribers.
   */
  async emitError(streamId: string, error: string): Promise<void> {
    const runtime = this.runtimeState.get(streamId);
    if (runtime) {
      runtime.errorEvent = error;
    }

    this.eventTransport.emitError(streamId, error);
    logger.debug(`[GenerationJobManager] Error emitted for ${streamId}: ${error}`);
  }

  /**
   * Emit a done event to subscribers.
   */
  async emitDone(streamId: string, finalEvent: t.ServerSentEvent): Promise<void> {
    const runtime = this.runtimeState.get(streamId);
    if (runtime) {
      runtime.finalEvent = finalEvent;
    }

    this.eventTransport.emitDone(streamId, finalEvent);
    logger.debug(`[GenerationJobManager] Done event emitted for ${streamId}`);
  }

  /**
   * Get a job by streamId.
   */
  async getJob(streamId: string): Promise<SerializableJobData | null> {
    return this.jobStore.getJob(streamId);
  }

  /**
   * Check if a job exists.
   */
  async hasJob(streamId: string): Promise<boolean> {
    return this.jobStore.hasJob(streamId);
  }

  /**
   * Get resume state for a reconnecting client.
   * Aggregates content from run steps and persisted chunks.
   */
  async getResumeState(streamId: string): Promise<t.ResumeState | null> {
    const jobData = await this.jobStore.getJob(streamId);
    if (!jobData) {
      return null;
    }

    // Get run steps from graph (in-memory mode) or persisted chunks
    let runSteps: Agents.RunStep[] = [];
    try {
      runSteps = await this.jobStore.getRunSteps(streamId);
    } catch {
      // In Redis mode, run steps may not be available via getRunSteps
    }

    // Get aggregated content
    let aggregatedContent: Agents.MessageContentComplex[] = [];
    const contentResult = await this.jobStore.getContentParts(streamId);
    if (contentResult) {
      aggregatedContent = contentResult.content;
    }

    // Parse token usage
    let collectedUsage: UsageMetadata[] = [];
    if (jobData.tokenUsage) {
      try {
        collectedUsage = JSON.parse(jobData.tokenUsage);
      } catch {
        logger.warn(`[GenerationJobManager] Failed to parse token usage for ${streamId}`);
      }
    }

    // Parse replay events
    let replayEvents: Array<{ event: string; data?: unknown; [key: string]: unknown }> | undefined;
    if (jobData.replayEvents) {
      try {
        replayEvents = JSON.parse(jobData.replayEvents);
      } catch {
        logger.warn(`[GenerationJobManager] Failed to parse replay events for ${streamId}`);
      }
    }

    // Parse title event
    let titleEvent: { event: 'title'; data?: { conversationId?: string; title?: string } } | undefined;
    if (jobData.titleEvent) {
      try {
        titleEvent = JSON.parse(jobData.titleEvent);
      } catch {
        logger.warn(`[GenerationJobManager] Failed to parse title event for ${streamId}`);
      }
    }

    return {
      runSteps,
      aggregatedContent,
      userMessage: jobData.userMessage,
      responseMessageId: jobData.responseMessageId,
      conversationId: jobData.conversationId,
      sender: jobData.sender,
      iconURL: jobData.iconURL,
      model: jobData.model,
      titleEvent,
      replayEvents,
      collectedUsage,
    };
  }

  /**
   * Get active job IDs for a user.
   */
  async getActiveJobIdsForUser(userId: string): Promise<string[]> {
    const tenantId = getTenantId();
    const safeTenantId = tenantId && tenantId !== SYSTEM_TENANT_ID ? tenantId : undefined;
    return this.jobStore.getActiveJobIdsByUser(userId, safeTenantId);
  }

  /**
   * Mark that a sync event has been sent for a stream.
   */
  markSyncSent(streamId: string): void {
    const runtime = this.runtimeState.get(streamId);
    if (runtime) {
      runtime.syncSent = true;
    }
    // Persist to store for cross-replica consistency
    this.jobStore.updateJob(streamId, { syncSent: true }).catch((err) => {
      logger.error(`[GenerationJobManager] Failed to persist syncSent=true:`, err);
    });
  }

  /**
   * Check if a sync event has been sent for a stream.
   */
  async wasSyncSent(streamId: string): Promise<boolean> {
    // Check runtime first
    const runtime = this.runtimeState.get(streamId);
    if (runtime) {
      return runtime.syncSent;
    }
    // Fall back to persisted data
    const jobData = await this.jobStore.getJob(streamId);
    return jobData?.syncSent ?? false;
  }

  /**
   * Update job metadata.
   */
  async updateMetadata(
    streamId: string,
    metadata: Partial<SerializableJobData>,
  ): Promise<void> {
    await this.jobStore.updateJob(streamId, metadata);
  }

  /**
   * Set content parts reference for a job.
   */
  setContentParts(streamId: string, contentParts: Agents.MessageContentComplex[]): void {
    this.jobStore.setContentParts(streamId, contentParts);
  }

  /**
   * Set collected usage reference for a job.
   */
  setCollectedUsage(streamId: string, usage: UsageMetadata[]): void {
    this.jobStore.setCollectedUsage(streamId, usage);
  }

  /**
   * Set the graph reference for a job.
   */
  setGraph(streamId: string, graph: StandardGraph): void {
    this.jobStore.setGraph(streamId, graph);
  }

  /**
   * Complete a job (called when generation finishes or errors).
   * Cleans up content state and optionally deletes the job.
   */
  async completeJob(streamId: string, error?: string): Promise<void> {
    const runtime = this.runtimeState.get(streamId);

    // Abort the controller to signal all pending operations (e.g., OAuth flow monitors)
    // that the job is done and they should clean up
    if (runtime) {
      runtime.abortController.abort();
    }

    // Clear content state and run step buffer (Redis only)
    this.jobStore.clearContentState(streamId);
    this.replayEventWriteQueues.delete(streamId);
    this.tokenUsageWriteQueues.delete(streamId);

    // For error jobs, DON'T delete immediately - keep around so late-connecting
    // clients can receive the error. This handles the race condition where error
    // occurs before client connects to SSE stream.
    //
    // Cleanup strategy: Error jobs are cleaned up by periodic cleanup (every 60s)
    // via jobStore.cleanup() which checks for jobs with status 'error' and
    // completedAt set. The TTL is configurable via jobStore options (default: 0,
    // meaning cleanup on next interval). This gives clients ~60s to connect and
    // receive the error before the job is removed.
    if (error) {
      await this.jobStore.updateJob(streamId, {
        status: 'error',
        completedAt: Date.now(),
        error,
      });
      this.runningJobs.delete(streamId);
      this.syncRunningJobMetrics();
      recordGenerationJob(this.storeLabel, 'error');
      // Keep runtime state so subscribe() can access errorEvent
      logger.debug(
        `[GenerationJobManager] Job completed with error (keeping for late subscribers): ${streamId}`,
      );
      return;
    }

    // Immediate cleanup if configured (default: true) - only for successful completions
    if (this._cleanupOnComplete) {
      this.runtimeState.delete(streamId);
      // Don't cleanup eventTransport here - let the done event fully transmit first.
      // EventTransport will be cleaned up when subscribers disconnect or by periodic cleanup.
      await this.jobStore.deleteJob(streamId);
      logger.debug(`[stream-job] reason=completion-cleanup streamId=${streamId}`);
    } else {
      // Only update status if keeping the job around
      await this.jobStore.updateJob(streamId, {
        status: 'complete',
        completedAt: Date.now(),
      });
    }

    this.runningJobs.delete(streamId);
    this.syncRunningJobMetrics();
    recordGenerationJob(this.storeLabel, 'completed');
    logger.debug(`[GenerationJobManager] Job completed: ${streamId}`);
  }

  /**
   * Abort a job (user-initiated).
   * Returns all data needed for token spending and message saving.
   *
   * Cross-replica support (Redis mode):
   * - Emits abort signal via Redis pub/sub
   * - The replica running generation receives signal and aborts its AbortController
   */
  async abortJob(streamId: string): Promise<AbortResult> {
    const jobData = await this.jobStore.getJob(streamId);
    const runtime = this.runtimeState.get(streamId);

    if (!jobData) {
      logger.warn(`[GenerationJobManager] Cannot abort - job not found: ${streamId}`);
      recordGenerationJob(this.storeLabel, 'abort_failed');
      return {
        text: '',
        content: [],
        jobData: null,
        success: false,
        finalEvent: null,
        collectedUsage: [],
      };
    }

    // Telemetry: catch-all breadcrumb for any abort path that reaches this method
    logger.debug(
      `[stream-job] reason=abort-job conversationId=${jobData.conversationId ?? streamId} createdAt=${jobData.createdAt}`,
    );

    // Emit abort signal for cross-replica support (Redis mode)
    // This ensures the generating replica receives the abort signal
    if (this.eventTransport.emitAbort) {
      this.eventTransport.emitAbort(streamId);
    }

    // Also abort local controller if we have it (same-replica abort)
    if (runtime) {
      runtime.abortController.abort();
    }

    /** Content before clearing state */
    const result = await this.jobStore.getContentParts(streamId);
    const content = result?.content ?? [];
    const abortContent = filterPersistableAbortContent(content);
    const shouldPersistAbortContent = abortContent.length > 0;

    /** Collected usage for all models */
    const collectedUsage = this.jobStore.getCollectedUsage(streamId);

    /** Text from content parts for fallback token counting */
    const text = shouldPersistAbortContent
      ? parseTextParts(abortContent as TMessageContentParts[])
      : '';

    /** Detect "early abort" - aborted before any generation happened (e.g., during tool loading)
    In this case, no messages were saved to DB, so frontend shouldn't navigate to conversation */
    const isEarlyAbort = !shouldPersistAbortContent && jobData.createdEventEmitted !== true;

    /** Final event for abort */
    const userMessageId = jobData.userMessage?.messageId;

    const abortFinalEvent: t.ServerSentEvent = {
      final: true,
      // Don't include conversation for early aborts - it doesn't exist in DB
      conversation: isEarlyAbort ? null : { conversationId: jobData.conversationId },
      title: 'New Chat',
      requestMessage: jobData.userMessage
        ? {
            messageId: userMessageId,
            parentMessageId: jobData.userMessage.parentMessageId,
            conversationId: jobData.conversationId,
            text: jobData.userMessage.text ?? '',
            quotes: jobData.userMessage.quotes,
            isCreatedByUser: true,
          }
        : null,
      responseMessage: isEarlyAbort
        ? null
        : {
            messageId: jobData.responseMessageId ?? `${userMessageId ?? 'aborted'}_`,
            parentMessageId: userMessageId,
            conversationId: jobData.conversationId,
            content: abortContent,
            sender: jobData.sender ?? 'AI',
            endpoint: jobData.endpoint,
            iconURL: jobData.iconURL,
            model: jobData.model,
            unfinished: true,
            error: false,
            isCreatedByUser: false,
          },
      aborted: true,
      // Flag for early abort - no messages saved, frontend should go to new chat
      earlyAbort: isEarlyAbort,
    } satisfies t.FinalEvent as t.ServerSentEvent;

    if (runtime) {
      runtime.finalEvent = abortFinalEvent;
    }

    await this.eventTransport.emitDone(streamId, abortFinalEvent);
    this.jobStore.clearContentState(streamId);
    this.replayEventWriteQueues.delete(streamId);
    this.tokenUsageWriteQueues.delete(streamId);

    // Immediate cleanup if configured (default: true)
    if (this._cleanupOnComplete) {
      this.runtimeState.delete(streamId);
      // Don't cleanup eventTransport here - let the abort event fully transmit first.
      await this.jobStore.deleteJob(streamId);
    } else {
      // Only update status if keeping the job around
      await this.jobStore.updateJob(streamId, {
        status: 'aborted',
        completedAt: Date.now(),
      });
    }

    this.runningJobs.delete(streamId);
    this.syncRunningJobMetrics();
    recordGenerationJob(this.storeLabel, 'aborted');
    logger.debug(`[GenerationJobManager] Job aborted: ${streamId}`);

    return {
      success: true,
      jobData,
      content: abortContent,
      finalEvent: abortFinalEvent,
      text,
      collectedUsage,
    };
  }

  /**
   * Run periodic cleanup of expired jobs.
   */
  private async cleanup(): Promise<void> {
    // Cleanup job store
    await this.jobStore.cleanup();
  }

  /**
   * Destroy the job manager and release all resources.
   */
  async destroy(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    this.runtimeState.clear();
    this.runningJobs.clear();
    this.replayEventWriteQueues.clear();
    this.tokenUsageWriteQueues.clear();
    this.eventTransport.destroy();
    await this.jobStore.destroy();
    logger.debug('[GenerationJobManager] Destroyed');
  }
}

export const GenerationJobManager = new GenerationJobManagerClass();
export { GenerationJobManagerClass };