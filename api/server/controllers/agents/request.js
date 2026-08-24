const crypto = require('crypto');
const { logger } = require('@librechat/data-schemas');
const { Constants, ViolationTypes, isEphemeralAgentId } = require('librechat-data-provider');
const {
  sendEvent,
  getViolationInfo,
  buildMessageFiles,
  getReferencedQuotes,
  resolveTitleTiming,
  GenerationJobManager,
  filterPersistableAbortContent,
  decrementPendingRequest,
  sanitizeMessageForTransmit,
  checkAndIncrementPendingRequest,
  isUnpersistedPreliminaryParent,
} = require('@librechat/api');
const { disposeClient, clientRegistry, requestDataMap } = require('~/server/cleanup');
const {
  getMCPRequestContext,
  cleanupMCPRequestContextForReq,
} = require('~/server/services/MCPRequestContext');
const { handleAbortError } = require('~/server/middleware');
const { logViolation } = require('~/cache');
const { saveMessage, getMessages, getConvo } = require('~/models');
const { scrubMessageForTransmit } = require('~/server/utils/stripAiTells');

/**
 * KADE prepaid Stage B (2026-07-28): translate the balance gate's raw JSON
 * throw into a warm, hearable line before it reaches the stream. The gate
 * itself (BaseClient -> checkBalance) has been ARMED since the v0.8.7 rebase
 * (yaml balance.enabled:true, startBalance seeds missing records lazily);
 * this only fixes what a blocked turn SAYS. Fail-soft: any parse problem
 * falls back to the original message untouched.
 */
const friendlyTurnError = (message) => {
  try {
    if (typeof message === 'string' && message.includes('token_balance')) {
      let balanceUSD = null;
      try {
        const parsed = JSON.parse(message);
        if (Number.isFinite(Number(parsed && parsed.balance))) {
          balanceUSD = Number(parsed.balance) / 1e6;
        }
      } catch (_e) {
        /* raw string is fine */
      }
      const balLine =
        balanceUSD != null && balanceUSD > 0.005
          ? 'You have about $' + balanceUSD.toFixed(2) + ' of credit left, but this turn needed more than that. '
          : 'Your prepaid credit has run dry, so this turn could not run. ';
      return (
        balLine +
        'Ask Kade to top you up - it takes her ten seconds - and this chat picks ' +
        'right back up where you left off. Nothing you wrote is lost.'
      );
    }
  } catch (_e) {
    /* fall through */
  }
  return message;
};

function createCloseHandler(abortController) {
  return function (manual) {
    if (!manual) {
      logger.debug('[AgentController] Request closed');
    }
    if (!abortController) {
      return;
    } else if (abortController.signal.aborted) {
      return;
    } else if (abortController.requestCompleted) {
      return;
    }

    abortController.abort();
    logger.debug('[' + 'stream-job] abort reason=close-handler');
    logger.debug('[AgentController] Request aborted on close');
  };
}

function toValidISOString(value) {
  if (value == null) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Returns the cached AgentController for the given conversationId, or creates one.
 * Uses a fixed-size Map to guard against unbounded memory growth.
 *
 * @param {Object} req - request
 * @param {Object} res - response
 * @param {Function} next - next
 * @param {Function} initializeClient - Client init
 * @param {Function|Error|null} addTitleOrAbortError - Title fn or error
 */
const AgentController = async (req, res, next, initializeClient, addTitleOrAbortError) => {
  const { user } = req;
  const userId = user.id;
  const conversationId = req.body?.conversationId;
  const isNewConvo = conversationId === 'new' || !conversationId;
  const abortError = addTitleOrAbortError instanceof Error ? addTitleOrAbortError : null;
  const addTitle = !abortError ? addTitleOrAbortError : null;

  // Validate parent message if it has an underscore suffix (preliminary ID)
  // This check MUST come before checkAndIncrementPendingRequest to avoid consuming
  // the rate limit on a request that will be rejected anyway.
  const pendingParentMessageId = req.body?.parentMessageId;
  if (pendingParentMessageId && pendingParentMessageId.endsWith('_')) {
    const isUnpersisted = await isUnpersistedPreliminaryParent({
      userId,
      conversationId,
      parentMessageId: pendingParentMessageId,
      getMessages,
    });

    if (isUnpersisted) {
      res.status(409).json({
        error: 'selected parent response is still being saved; wait for it to complete before sending a follow-up',
      });
      return;
    }
  }

  // Check and increment pending request count
  const { allowed } = await checkAndIncrementPendingRequest(userId);
  if (!allowed) {
    res.status(429).json({ error: 'Too many pending requests' });
    return;
  }

  // Create the generation job
  const streamId = conversationId;
  const job = await GenerationJobManager.createJob(streamId, userId, conversationId, {
    createdAt: Date.now(),
  });
  const jobCreatedAt = job.createdAt;

  // Store job in request data map for cleanup (WeakMap is keyed on the request object)
  const contextMap = requestDataMap.get(req) || new Map();
  requestDataMap.set(req, contextMap);
  contextMap.set(conversationId, {
    abortController: job.abortController,
    createdAt: jobCreatedAt,
  });

  logger.debug(
    `[AgentController] Created job for conversation ${conversationId} with createdAt: ${jobCreatedAt}`,
  );

  // Pre-generate the response message ID
  const responseMessageId = `${req.body?.messageId || crypto.randomUUID()}_`;

  // Store early resume metadata (before MCP initialization)
  const endpointOption = req.body?.endpointOption || {};
  const modelConfig = endpointOption.modelOptions || endpointOption.model_parameters || {};
  const iconURL =
    endpointOption.iconURL ||
    req.body?.iconURL ||
    resolveModelSpecIcon(req.config, endpointOption.spec) ||
    endpointOption.endpoint;

  GenerationJobManager.updateMetadata(streamId, {
    conversationId,
    endpoint: endpointOption.endpoint || 'agents',
    iconURL,
    model: modelConfig.model,
    responseMessageId,
    userMessage: {
      messageId: req.body?.messageId,
      parentMessageId: req.body?.parentMessageId,
      conversationId,
      text: req.body?.text || '',
    },
  });

  // Resolve resume state for reconnection
  const resumeState = await GenerationJobManager.getResumeState(streamId);

  // Respond immediately with the stream info
  if (!res.headersSent) {
    res.json({
      streamId,
      conversationId,
      status: resumeState ? 'resumed' : 'started',
    });
  }

  // If there's an abort error from the beginning, handle it
  if (abortError) {
    if (abortError.message) {
      logger.error(
        `[AgentController] Abort error during initialization for ${conversationId}: ${abortError.message}`,
      );
    }
    await handleAbortError(res, req, abortError, {
      conversationId,
      sender: null,
      messageId: responseMessageId,
      parentMessageId: req.body?.parentMessageId,
      userMessageId: req.body?.messageId,
    });
    return;
  }

  // Set up SSE response headers for streaming
  res.setHeader('Content-Encoding', 'identity');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Create close handler for SSE disconnect
  const closeHandler = createCloseHandler(job.abortController);
  /**
   * TODO: Restore SSE disconnect tracking after verification.
   * This handler was removed because it was causing aborts that interfered
   * with the job replacement detection. Once the job replacement fix is stable,
   * re-enable this to detect client-side disconnects.
   *
   * Relevant code to restore:
   * req.on('close', () => {
   *   if (!job.abortController.signal.aborted) {
   *     closeHandler();
   *   }
   * });
   */

  /**
   * Cleanup function for the request.
   */
  let finished = false;
  const finishResumableRequest = async (req, userId) => {
    if (finished) {
      return;
    }
    finished = true;
    await decrementPendingRequest(req, userId);
    const contextMap = requestDataMap.get(req);
    if (contextMap) {
      contextMap.delete(conversationId);
    }
  };

  // Handle all subscribers left event for partial response persistence
  if (job.emitter) {
    job.emitter.on('allSubscribersLeft', async (contentParts) => {
      if (!contentParts || contentParts.length === 0) {
        return;
      }

      const resumeState = await GenerationJobManager.getResumeState(streamId);
      if (!resumeState) {
        return;
      }

      const persistableContent = filterPersistableAbortContent(contentParts);
      if (persistableContent.length === 0) {
        return;
      }

      const partialResponse = {
        messageId: resumeState.responseMessageId,
        parentMessageId: resumeState.userMessage.messageId,
        conversationId: resumeState.conversationId || conversationId,
        content: persistableContent,
        text: '',
        sender: 'AI',
        endpoint: endpointOption.endpoint || 'agents',
        iconURL: resumeState.iconURL || iconURL,
        model: resumeState.model || modelConfig.model,
        unfinished: true,
        error: false,
        isCreatedByUser: false,
        user: userId,
      };

      try {
        await saveMessage(
          {
            userId,
            isTemporary: req.body?.isTemporary,
            interfaceConfig: req.config?.interfaceConfig,
          },
          partialResponse,
          {
            context: 'api/server/controllers/agents/request.js - allSubscribersLeft',
          },
        );
        logger.debug(`[AgentController] Saved partial response for ${streamId} after all subscribers left`);
      } catch (saveError) {
        logger.error(`[AgentController] Failed to save partial response: ${saveError.message}`);
      }
    });
  }

  let client;

  // Start the generation process
  try {
    logger.debug(
      `[AgentController] Starting generation for conversation ${conversationId}, endpoint: ${endpointOption?.endpoint}`,
    );

    const result = await initializeClient({
      req,
      res,
      endpointOption,
      signal: job.abortController.signal,
    });

    if (job.abortController.signal.aborted) {
      logger.debug(`[stream-job] abort reason=init-abort conversationId=${conversationId} createdAt=${jobCreatedAt}`);
      GenerationJobManager.completeJob(streamId, 'Request aborted during initialization');
      await finishResumableRequest(req, userId);
      return;
    }

    client = result.client;

    // Resolve title timing from the public agents endpoint first, then fall
    // back to the agent's actual backing provider/custom endpoint.
    let titleTiming = 'deferred';
    if (resolveTitleTiming) {
      titleTiming = resolveTitleTiming({
        appConfig: req.config,
        endpoint: [endpointOption?.endpoint, client?.options?.agent?.endpoint],
      });
    }

    if (client?.sender) {
      GenerationJobManager.updateMetadata(streamId, { sender: client.sender });
    }

    // Store reference to client's contentParts - graph will be set when run is created
    if (client?.contentParts) {
      GenerationJobManager.setContentParts(streamId, client.contentParts);
    }

    let userMessage;

    const getReqData = (data = {}) => {
      if (data.userMessage) {
        userMessage = data.userMessage;
      }
    };

    // Start background generation
    const startGeneration = async () => {
      try {
        await Promise.race([job.readyPromise, new Promise((resolve) => setTimeout(resolve, 100))]);
      } catch (waitError) {
        logger.warn(
          `[ResumableAgentController] Error waiting for subscriber: ${waitError.message}`,
        );
      }

      let immediateTitlePromise = null;
      let resolveConvoReady;
      const convoReady = new Promise((resolve) => {
        resolveConvoReady = resolve;
      });
      const titleAbortController = new AbortController();
      const titleDiscardController = new AbortController();
      const abortTitleOnJobAbort = () => titleAbortController.abort();
      if (job.abortController.signal.aborted) {
        titleAbortController.abort();
      } else {
        job.abortController.signal.addEventListener('abort', abortTitleOnJobAbort, { once: true });
      }
      const shouldGenerateTitle = isNewConvo && !req.body?.isTemporary;

      try {
        const onStart = (userMsg, respMsgId, _isNewConvo) => {
          userMessage = userMsg;

          GenerationJobManager.updateMetadata(streamId, {
            responseMessageId: respMsgId,
            userMessage: {
              messageId: userMsg.messageId,
              parentMessageId: userMsg.parentMessageId,
              conversationId: userMsg.conversationId,
              text: userMsg.text,
              quotes: userMsg.quotes,
            },
          });
        };

        const response = await client.run({
          signal: job.abortController.signal,
          getReqData,
          onStart,
          conversationId,
          userMessage: {
            messageId: req.body?.messageId,
            parentMessageId: req.body?.parentMessageId,
            conversationId,
            text: req.body?.text,
            ...(req.body?.files && { files: req.body.files }),
          },
        });

        // Resolve convo ready for title generation
        if (resolveConvoReady) {
          resolveConvoReady();
        }

        const wasAbortedBeforeComplete = response?.unfinished === true;
        const text = typeof response?.text === 'string' ? response.text : '';

        const conversation = await getConvo(userId, conversationId);

        if (!wasAbortedBeforeComplete) {
          const finalEvent = {
            final: true,
            conversation,
            title: conversation?.title,
            requestMessage: sanitizeMessageForTransmit(userMessage),
            responseMessage: scrubMessageForTransmit(response),
          };

          await GenerationJobManager.emitDone(streamId, finalEvent);
          GenerationJobManager.completeJob(streamId);

          await finishResumableRequest(req, userId);
        } else {
          logger.debug(`[stream-job] abort reason=completion-abort conversationId=${conversationId} createdAt=${jobCreatedAt}`);

          const finalEvent = {
            final: true,
            conversation,
            title: conversation?.title,
            requestMessage: sanitizeMessageForTransmit(userMessage),
            responseMessage: scrubMessageForTransmit({ ...response, unfinished: true }),
          };

          await GenerationJobManager.emitDone(streamId, finalEvent);
          GenerationJobManager.completeJob(streamId, 'Request aborted');
          await finishResumableRequest(req, userId);
        }

        if (titleTiming === 'immediate') {
          if (immediateTitlePromise) {
            immediateTitlePromise.finally(() => {
              if (client) {
                disposeClient(client);
              }
            });
          } else if (client) {
            disposeClient(client);
          }
        } else if (shouldGenerateTitle && addTitle) {
          addTitle(req, {
            text,
            response: { ...response },
            client,
          })
            .catch((err) => {
              logger.error('[ResumableAgentController] Error in title generation', err);
            })
            .finally(() => {
              if (client) {
                disposeClient(client);
              }
            });
        } else {
          if (client) {
            disposeClient(client);
          }
        }
      } catch (error) {
        titleAbortController.abort();
        titleDiscardController.abort();
        job.abortController.signal.removeEventListener('abort', abortTitleOnJobAbort);
        if (resolveConvoReady) {
          resolveConvoReady();
        }

        const wasAborted = job.abortController.signal.aborted || error.message?.includes('abort');

        if (wasAborted) {
          logger.debug(`[stream-job] abort reason=generation-abort conversationId=${conversationId} createdAt=${jobCreatedAt}`);
        } else {
          logger.debug(`[stream-job] abort reason=generation-error conversationId=${conversationId} createdAt=${jobCreatedAt}`);
          logger.error(`[ResumableAgentController] Generation error for ${streamId}:`, error);
          await GenerationJobManager.emitError(
            streamId,
            friendlyTurnError(error.message) || 'Generation failed',
          );
          GenerationJobManager.completeJob(streamId, friendlyTurnError(error.message));
        }

        await finishResumableRequest(req, userId);

        if (immediateTitlePromise) {
          immediateTitlePromise.finally(() => {
            if (client) {
              disposeClient(client);
            }
          });
        } else if (client) {
          disposeClient(client);
        }

        return;
      }
    };

    startGeneration().catch(async (err) => {
      logger.debug(`[stream-job] abort reason=background-error conversationId=${conversationId} createdAt=${jobCreatedAt}`);
      logger.error(`[ResumableAgentController] Unhandled error in background generation: ${err.message}`);
      GenerationJobManager.completeJob(streamId, friendlyTurnError(err.message));
      await finishResumableRequest(req, userId);
    });
  } catch (error) {
    logger.debug(`[stream-job] abort reason=init-error conversationId=${conversationId} createdAt=${jobCreatedAt}`);
    logger.error('[ResumableAgentController] Initialization error:', error);

    // Clean up MCP connections
    const mcpContext = getMCPRequestContext(req, res);
    if (mcpContext) {
      await cleanupMCPRequestContextForReq(req);
    }

    await finishResumableRequest(req, userId);
    if (client) {
      disposeClient(client);
    }
  }
};

/**
 * Resolve model spec icon URL from the config.
 * @param {Object} config - App config
 * @param {string} specName - Model spec name
 * @returns {string|null}
 */
function resolveModelSpecIcon(config, specName) {
  if (!config?.modelSpecs?.list || !specName) {
    return null;
  }

  const spec = config.modelSpecs.list.find((s) => s.name === specName);
  return spec?.preset?.iconURL || null;
}

module.exports = AgentController;