const express = require('express');
const {
  isEnabled,
  GenerationJobManager,
  hasPersistableAbortContent,
  buildAbortedResponseMetadata,
  createTaskRouter,
  getTaskReceipts,
} = require('@librechat/api');
const { createSseStreamTelemetry } = require('@librechat/api/telemetry');
const { logger } = require('@librechat/data-schemas');
const {
  uaParser,
  checkBan,
  requireJwtAuth,
  messageIpLimiter,
  configMiddleware,
  messageUserLimiter,
} = require('~/server/middleware');
const { saveMessage, getMessages, getConvo } = require('~/models');
const responses = require('./responses');
const openai = require('./openai');
const { v1 } = require('./v1');
const chat = require('./chat');
const { createKadeStreamResume } = require('./kadeStreamResume');

const { LIMIT_MESSAGE_IP, LIMIT_MESSAGE_USER } = process.env ?? {};

/** Untenanted jobs (pre-multi-tenancy) remain accessible if the userId check passes. */
function hasTenantMismatch(job, user) {
  return job.metadata?.tenantId != null && job.metadata.tenantId !== user.tenantId;
}

const router = express.Router();

/**
 * Open Responses API routes (API key authentication handled in route file)
 * Mounted at /agents/v1/responses (full path: /api/agents/v1/responses)
 * NOTE: Must be mounted BEFORE /v1 to avoid being caught by the less specific route
 * @see https://openresponses.org/specification
 */
router.use('/v1/responses', responses);

/**
 * OpenAI-compatible API routes (API key authentication handled in route file)
 * Mounted at /agents/v1 (full path: /api/agents/v1/chat/completions)
 */
router.use('/v1', openai);

router.use(requireJwtAuth);
router.use(checkBan);
router.use(uaParser);
router.use('/chat/tasks', createTaskRouter({ getMessages, getConvo }));

/**
 * Stream endpoints - mounted before chatRouter to bypass rate limiters
 * These are GET requests and don't need message body validation or rate limiting
 */

/** KADE Nov 12 2026 (WEB-13): a comment line every 20 s so a connection that died without a word
 * is noticed (the web client reconnects after 45 s of no bytes). Every SSE parser skips ':' lines,
 * and the phone apps' parsers ignore lines that are not `event:`/`data:`.
 * KADE_SSE_HEARTBEAT_MS sets the gap; 0 turns the heartbeat off. Ship this before the client
 * watchdog, or a long silent tool call makes the web client reconnect.
 *
 * The pings stop once nothing real (an `event:`/`data:` write) has gone out for
 * KADE_SSE_HEARTBEAT_IDLE_CAP_MS (default 240000; 0 = never stop). A hung job must still go quiet,
 * so the clients' own byte-silence watchdogs can end the turn: the web call screen's 75 s, the
 * web chat's 45 s, and the phones' 300 s request timeouts (iPhone timeoutInterval, Android
 * readTimeout). Without the cap a stuck turn sat on "thinking" until the 20-minute job reaper.
 * Keep the cap under the phones' 300 s and well above 45 s. */
const DEFAULT_SSE_HEARTBEAT_MS = 20000;
const DEFAULT_SSE_HEARTBEAT_IDLE_CAP_MS = 240000;
function envMs(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function sseHeartbeatMs() {
  return envMs('KADE_SSE_HEARTBEAT_MS', DEFAULT_SSE_HEARTBEAT_MS);
}
function sseHeartbeatIdleCapMs() {
  return envMs('KADE_SSE_HEARTBEAT_IDLE_CAP_MS', DEFAULT_SSE_HEARTBEAT_IDLE_CAP_MS);
}
/** Returns { noteRealWrite } (call it on every real event written), or null when off. */
function startStreamHeartbeat(res) {
  const every = sseHeartbeatMs();
  if (!every) {
    return null;
  }
  const idleCap = sseHeartbeatIdleCapMs();
  let lastRealWriteAt = Date.now();
  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(heartbeat);
      return;
    }
    if (idleCap && Date.now() - lastRealWriteAt >= idleCap) {
      // Nothing real for the whole cap: the job is probably hung. Go quiet for good so the
      // clients' silence watchdogs can end the turn; the job reaper still ends the response.
      clearInterval(heartbeat);
      logger.warn(
        `[AgentStream] No events for ${Math.round(idleCap / 1000)}s - heartbeat stopped so clients can time out`,
      );
      return;
    }
    try {
      res.write(': ping\n\n');
      if (typeof res.flush === 'function') {
        res.flush();
      }
    } catch {
      clearInterval(heartbeat);
    }
  }, every);
  if (typeof heartbeat.unref === 'function') {
    heartbeat.unref();
  }
  res.on('close', () => clearInterval(heartbeat));
  res.on('finish', () => clearInterval(heartbeat));
  return {
    noteRealWrite() {
      lastRealWriteAt = Date.now();
    },
  };
}

/**
 * @route GET /chat/stream/:streamId
 * @desc Subscribe to an ongoing generation job's SSE stream with replay support
 * @access Private
 * @description Sends sync event with resume state, replays missed chunks, then streams live
 * @query resume=true - Indicates this is a reconnection (sends sync event)
 */
router.get('/chat/stream/:streamId', async (req, res) => {
  const { streamId } = req.params;
  const isResume = req.query.resume === 'true';

  const job = await GenerationJobManager.getJob(streamId);
  if (!job) {
    return res.status(404).json({
      error: 'Stream not found',
      message: 'The generation job does not exist or has expired.',
    });
  }

  if (job.metadata?.userId && job.metadata.userId !== req.user.id) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  if (hasTenantMismatch(job, req.user)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  if (req.query.taskId && req.query.taskId !== job.metadata.taskId) {
    return res.status(409).json({ error: 'This chat has a different request. Check Saved replies.' });
  }

  const streamTelemetry = createSseStreamTelemetry({ req, res, streamId, isResume });
  /* KADE Nov 12 2026 (phase 4 pick 4): event ids and exact resume by cursor (kadeStreamResume.js).
   * Only for a client that sends kadeSeq=1; off with KADE_STREAM_LOG=0. */
  const kadeResume = createKadeStreamResume({ req, manager: GenerationJobManager, logger });

  res.setHeader('Content-Encoding', 'identity');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  streamTelemetry.recordHeadersFlushed();
  const heartbeat = startStreamHeartbeat(res);

  logger.debug(`[AgentStream] Client subscribed to ${streamId}, resume: ${isResume}`);

  const writeEvent = (event, options = {}) => {
    if (!res.writableEnded) {
      const idLine = kadeResume.idLine(event);
      if (idLine === null) {
        return true; // KADE pick 4: this client already has it
      }
      const eventName = options.eventName ?? 'message';
      const payload = `${idLine}event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`;
      res.write(payload);
      streamTelemetry.recordWrite(payload, { final: options.final });
      heartbeat?.noteRealWrite();
      if (typeof res.flush === 'function') {
        res.flush();
      }
      return true;
    }

    return false;
  };

  const onDone = (event) => {
    if (kadeResume.holdDone(event)) {
      return; // KADE pick 4: a cursor replay is still being written; the final frame comes after it
    }
    streamTelemetry.recordFinalEventEmitted();
    writeEvent(event, { final: true });
    res.end();
  };

  const onError = (error) => {
    if (!res.writableEnded) {
      streamTelemetry.recordErrorEventEmitted();
      writeEvent({ error }, { eventName: 'error' });
      res.end();
    }
  };

  let result;
  const subscriptionOptions = {
    expectedTaskId: typeof req.query.taskId === 'string' ? req.query.taskId : undefined,
  };

  if (kadeResume.cursor) {
    const resumed = await kadeResume.subscribe({
      streamId,
      writeEvent,
      onDone,
      onError,
      subscriptionOptions,
      res,
    });
    if (resumed.ended) {
      return;
    }
    result = resumed.result;
  } else if (isResume) {
    const { subscription, resumeState, pendingEvents } =
      await GenerationJobManager.subscribeWithResume(
        streamId,
        writeEvent,
        onDone,
        onError,
        subscriptionOptions,
      );

    if (!res.writableEnded) {
      if (resumeState) {
        writeEvent({ sync: true, resumeState, pendingEvents });
        GenerationJobManager.markSyncSent(streamId);
        logger.debug(
          `[AgentStream] Sent sync event for ${streamId} with ${resumeState.runSteps.length} run steps, ${pendingEvents.length} pending events`,
        );
      } else if (pendingEvents.length > 0) {
        for (const event of pendingEvents) {
          writeEvent(event);
        }
        logger.warn(
          `[AgentStream] Resume state null for ${streamId}, replayed ${pendingEvents.length} gap events directly`,
        );
      }
    }

    result = subscription;
  } else {
    result = await GenerationJobManager.subscribe(
      streamId,
      writeEvent,
      onDone,
      onError,
      subscriptionOptions,
    );
  }

  if (!result) {
    streamTelemetry.recordSubscribeFailed();
    onError('Failed to subscribe to stream');
    return;
  }

  req.on('close', () => {
    logger.debug(`[AgentStream] Client disconnected from ${streamId}`);
    result.unsubscribe();
  });
});

/**
 * @route GET /chat/active
 * @desc Get all active generation job IDs for the current user
 * @access Private
 * @returns { activeJobIds: string[] }
 */
router.get('/chat/active', async (req, res) => {
  const activeJobIds = await GenerationJobManager.getActiveJobIdsForUser(
    req.user.id,
    req.user.tenantId,
  );
  res.json({ activeJobIds });
});

/**
 * @route GET /chat/status/:conversationId
 * @desc Check if there's an active generation job for a conversation
 * @access Private
 * @returns { active, streamId, status, aggregatedContent, createdAt, resumeState }
 */
router.get('/chat/status/:conversationId', async (req, res) => {
  const { conversationId } = req.params;

  // streamId === conversationId, so we can use getJob directly
  const job = await GenerationJobManager.getJob(conversationId);

  if (!job) {
    return res.json({ active: false });
  }

  if (job.metadata.userId !== req.user.id) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  if (hasTenantMismatch(job, req.user)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  // Get resume state which contains aggregatedContent
  // Avoid calling both getStreamInfo and getResumeState (both fetch content)
  const resumeState = await GenerationJobManager.getResumeState(conversationId);
  const isActive = job.status === 'running';

  res.json({
    active: isActive,
    streamId: conversationId,
    status: job.status,
    aggregatedContent: resumeState?.aggregatedContent ?? [],
    createdAt: job.createdAt,
    resumeState,
  });
});

/**
 * @route POST /chat/abort
 * @desc Abort an ongoing generation job
 * @access Private
 * @description Mounted before chatRouter to bypass buildEndpointOption middleware
 */
router.post('/chat/abort', async (req, res) => {
  logger.debug(`[AgentStream] ========== ABORT ENDPOINT HIT ==========`);
  logger.debug(`[AgentStream] Method: ${req.method}, Path: ${req.path}`);
  logger.debug(`[AgentStream] Body:`, req.body);

  const { streamId, conversationId, abortKey } = req.body;
  const userId = req.user?.id;

  // streamId === conversationId, so try any of the provided IDs
  // Skip "new" as it's a placeholder for new conversations, not an actual ID
  let jobStreamId =
    streamId || (conversationId !== 'new' ? conversationId : null) || abortKey?.split(':')[0];
  let job = jobStreamId ? await GenerationJobManager.getJob(jobStreamId) : null;

  // Fallback: if job not found and we have a userId, look up active jobs for user
  // This handles the case where frontend sends "new" but job was created with a UUID
  if (!jobStreamId && userId) {
    logger.debug(`[AgentStream] Job not found by ID, checking active jobs for user: ${userId}`);
    const activeJobIds = await GenerationJobManager.getActiveJobIdsForUser(
      userId,
      req.user.tenantId,
    );
    if (activeJobIds.length > 1) {
      return res
        .status(409)
        .json({ error: 'More than one chat is working. Open the chat you want to stop.' });
    }
    if (activeJobIds.length === 1) {
      jobStreamId = activeJobIds[0];
      job = await GenerationJobManager.getJob(jobStreamId);
      logger.debug(`[AgentStream] Found active job for user: ${jobStreamId}`);
    }
  }

  logger.debug(`[AgentStream] Computed jobStreamId: ${jobStreamId}`);

  if (job && jobStreamId) {
    if (job.metadata?.userId && job.metadata.userId !== userId) {
      logger.warn(`[AgentStream] Unauthorized abort attempt for ${jobStreamId} by user ${userId}`);
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (hasTenantMismatch(job, req.user)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    logger.debug(`[AgentStream] Job found, aborting: ${jobStreamId}`);
    const abortResult = await GenerationJobManager.abortJob(jobStreamId);
    if (!abortResult.success) {
      return res
        .status(409)
        .json({ error: 'The request could not be stopped. Check the chat before trying again.' });
    }
    if (abortResult.jobData?.taskId) {
      try {
        await getTaskReceipts().settle(
          { userId, tenantId: req.user.tenantId },
          abortResult.jobData.taskId,
          'stopped',
          {
            userMessageId: abortResult.jobData.userMessage?.messageId,
            responseMessageId: abortResult.jobData.responseMessageId,
          },
        );
      } catch (error) {
        logger.error('[AgentTasks] Stop receipt failed', { error: error.message });
      }
    }
    logger.debug(`[AgentStream] Job aborted successfully: ${jobStreamId}`, {
      abortResultSuccess: abortResult.success,
      abortResultUserMessageId: abortResult.jobData?.userMessage?.messageId,
      abortResultResponseMessageId: abortResult.jobData?.responseMessageId,
    });

    // CRITICAL: Save partial response BEFORE returning to prevent race condition.
    // If user sends a follow-up immediately after abort, the parentMessageId must exist in DB.
    // Only save if we have a valid responseMessageId (skip early aborts before generation started)
    if (
      abortResult.success &&
      abortResult.jobData?.userMessage?.messageId &&
      abortResult.jobData?.responseMessageId &&
      hasPersistableAbortContent(abortResult.content)
    ) {
      const { jobData, content, text } = abortResult;
      const responseMessage = {
        messageId: jobData.responseMessageId,
        parentMessageId: jobData.userMessage.messageId,
        conversationId: jobData.conversationId,
        content: content || [],
        text: text || '',
        sender: jobData.sender || 'AI',
        endpoint: jobData.endpoint,
        iconURL: jobData.iconURL,
        model: jobData.model,
        unfinished: true,
        error: false,
        isCreatedByUser: false,
        user: userId,
      };

      /** Persist the usage/cost rollup + context breakdown for the stopped
       *  response (from the job's tracked tokenUsage/contextUsage) so its
       *  branch/total cost and granular rows survive a reload — parity with the
       *  normal completion path. */
      const abortMetadata = buildAbortedResponseMetadata(jobData);
      if (abortMetadata) {
        responseMessage.metadata = abortMetadata;
      }

      try {
        await saveMessage(
          {
            userId: req?.user?.id,
            isTemporary: req?.body?.isTemporary,
            interfaceConfig: req?.config?.interfaceConfig,
          },
          responseMessage,
          { context: 'api/server/routes/agents/index.js - abort endpoint' },
        );
        logger.debug(`[AgentStream] Saved partial response for: ${jobStreamId}`);
      } catch (saveError) {
        logger.error(`[AgentStream] Failed to save partial response: ${saveError.message}`);
      }
    }

    return res.json({ success: true, aborted: jobStreamId });
  }

  logger.warn(`[AgentStream] Job not found for streamId: ${jobStreamId}`);
  return res.status(404).json({ error: 'Job not found', streamId: jobStreamId });
});

router.use('/', v1);

const chatRouter = express.Router();
chatRouter.use(configMiddleware);

if (isEnabled(LIMIT_MESSAGE_IP)) {
  chatRouter.use(messageIpLimiter);
}

if (isEnabled(LIMIT_MESSAGE_USER)) {
  chatRouter.use(messageUserLimiter);
}

chatRouter.use('/', chat);
router.use('/chat', chatRouter);

module.exports = router;
