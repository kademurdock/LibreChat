/**
 * Tests for job replacement detection in ResumableAgentController
 *
 * Tests the following fixes from PR #11462:
 * 1. Job creation timestamp tracking
 * 2. Stale job detection and event skipping
 * 3. Response message saving before final event emission
 */

const mockLogger = {
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
};

const mockGenerationJobManager = {
  createJob: jest.fn(),
  getJob: jest.fn(),
  emitDone: jest.fn(),
  emitChunk: jest.fn(),
  completeJob: jest.fn(),
  updateMetadata: jest.fn(),
  setContentParts: jest.fn(),
  subscribe: jest.fn(),
};

const mockSaveMessage = jest.fn();
const mockDecrementPendingRequest = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: mockLogger,
}));

jest.mock('@librechat/api', () => ({
  isEnabled: jest.fn().mockReturnValue(false),
  GenerationJobManager: mockGenerationJobManager,
  getReferencedQuotes: jest.fn((quotes) => {
    if (!Array.isArray(quotes)) {
      return null;
    }
    const normalized = quotes
      .filter((quote) => typeof quote === 'string' && quote.trim().length > 0)
      .map((quote) => quote.trim());
    return normalized.length > 0 ? normalized : null;
  }),
  checkAndIncrementPendingRequest: jest.fn().mockResolvedValue({ allowed: true }),
  decrementPendingRequest: (...args) => mockDecrementPendingRequest(...args),
  getViolationInfo: jest.fn(),
  sanitizeMessageForTransmit: jest.fn((msg) => msg),
  sanitizeFileForTransmit: jest.fn((file) => file),
  Constants: { NO_PARENT: '00000000-0000-0000-0000-000000000000' },
}));

jest.mock('~/models', () => ({
  saveMessage: (...args) => mockSaveMessage(...args),
}));

describe('Job Replacement Detection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Job Creation Timestamp Tracking', () => {
    it('should capture createdAt when job is created', async () => {
      const streamId = 'test-stream-123';
      const createdAt = Date.now();

      mockGenerationJobManager.createJob.mockResolvedValue({
        createdAt,
        readyPromise: Promise.resolve(),
        abortController: new AbortController(),
        emitter: { on: jest.fn() },
      });

      const job = await mockGenerationJobManager.createJob(streamId, 'user-123', streamId);

      expect(job.createdAt).toBe(createdAt);
    });
  });

  describe('Job Replacement Detection Logic', () => {
    /**
     * Simulates the job replacement detection logic from request.js
     * This is extracted for unit testing since the full controller is complex
     */
    const detectJobReplacement = async (streamId, originalCreatedAt) => {
      const currentJob = await mockGenerationJobManager.getJob(streamId);
      return !!currentJob && currentJob.createdAt !== originalCreatedAt;
    };

    it('should detect when job was replaced (different createdAt)', async () => {
      const streamId = 'test-stream-123';
      const originalCreatedAt = 1000;
      const newCreatedAt = 2000;

      mockGenerationJobManager.getJob.mockResolvedValue({
        createdAt: newCreatedAt,
      });

      const wasReplaced = await detectJobReplacement(streamId, originalCreatedAt);

      expect(wasReplaced).toBe(true);
    });

    /**
     * ⚠️ THIS TEST USED TO ASSERT THE BUG (`expect(wasReplaced).toBe(true)`).
     * A deleted job is not a replaced job — a job deletes itself on abort and on
     * completion cleanup, so "absent" means nobody owns the stream. Aug 23 2026:
     * reading absent as replaced is what left Amber Lacey's seat silent.
     */
    it('should NOT call a deleted job a replaced job', async () => {
      const streamId = 'test-stream-123';
      const originalCreatedAt = 1000;

      mockGenerationJobManager.getJob.mockResolvedValue(null);

      const wasReplaced = await detectJobReplacement(streamId, originalCreatedAt);

      expect(wasReplaced).toBe(false);
    });

    it('should not detect replacement when same job (same createdAt)', async () => {
      const streamId = 'test-stream-123';
      const originalCreatedAt = 1000;

      mockGenerationJobManager.getJob.mockResolvedValue({
        createdAt: originalCreatedAt,
      });

      const wasReplaced = await detectJobReplacement(streamId, originalCreatedAt);

      expect(wasReplaced).toBe(false);
    });
  });

  describe('Event Emission Behavior', () => {
    /**
     * Simulates the final event emission logic from request.js
     */
    const emitFinalEventIfNotReplaced = async ({
      streamId,
      originalCreatedAt,
      finalEvent,
      userId,
    }) => {
      const currentJob = await mockGenerationJobManager.getJob(streamId);
      const jobWasReplaced = !!currentJob && currentJob.createdAt !== originalCreatedAt;

      if (jobWasReplaced) {
        mockLogger.debug('Skipping FINAL emit - job was replaced', {
          streamId,
          originalCreatedAt,
          currentCreatedAt: currentJob?.createdAt,
        });
        await mockDecrementPendingRequest(userId);
        return false;
      }

      mockGenerationJobManager.emitDone(streamId, finalEvent);
      mockGenerationJobManager.completeJob(streamId);
      await mockDecrementPendingRequest(userId);
      return true;
    };

    it('should skip emitting when job was replaced', async () => {
      const streamId = 'test-stream-123';
      const originalCreatedAt = 1000;
      const newCreatedAt = 2000;
      const userId = 'user-123';

      mockGenerationJobManager.getJob.mockResolvedValue({
        createdAt: newCreatedAt,
      });

      const emitted = await emitFinalEventIfNotReplaced({
        streamId,
        originalCreatedAt,
        finalEvent: { final: true },
        userId,
      });

      expect(emitted).toBe(false);
      expect(mockGenerationJobManager.emitDone).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
      expect(mockDecrementPendingRequest).toHaveBeenCalledWith(userId);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Skipping FINAL emit - job was replaced',
        expect.objectContaining({
          streamId,
          originalCreatedAt,
          currentCreatedAt: newCreatedAt,
        }),
      );
    });

    it('should emit when job was not replaced', async () => {
      const streamId = 'test-stream-123';
      const originalCreatedAt = 1000;
      const userId = 'user-123';
      const finalEvent = { final: true, conversation: { conversationId: streamId } };

      mockGenerationJobManager.getJob.mockResolvedValue({
        createdAt: originalCreatedAt,
      });

      const emitted = await emitFinalEventIfNotReplaced({
        streamId,
        originalCreatedAt,
        finalEvent,
        userId,
      });

      expect(emitted).toBe(true);
      expect(mockGenerationJobManager.emitDone).toHaveBeenCalledWith(streamId, finalEvent);
      expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(streamId);
      expect(mockDecrementPendingRequest).toHaveBeenCalledWith(userId);
    });
  });

  describe('Response Message Saving Order', () => {
    /**
     * Tests that response messages are saved BEFORE final events are emitted
     * This prevents race conditions where clients send follow-up messages
     * before the response is in the database
     */
    it('should save message before emitting final event', async () => {
      const callOrder = [];

      mockSaveMessage.mockImplementation(async () => {
        callOrder.push('saveMessage');
      });

      mockGenerationJobManager.emitDone.mockImplementation(() => {
        callOrder.push('emitDone');
      });

      mockGenerationJobManager.getJob.mockResolvedValue({
        createdAt: 1000,
      });

      // Simulate the order of operations from request.js
      const streamId = 'test-stream-123';
      const originalCreatedAt = 1000;
      const response = { messageId: 'response-123' };
      const userId = 'user-123';

      // Step 1: Save message
      await mockSaveMessage({}, { ...response, user: userId }, { context: 'test' });

      // Step 2: Check for replacement
      const currentJob = await mockGenerationJobManager.getJob(streamId);
      const jobWasReplaced = !!currentJob && currentJob.createdAt !== originalCreatedAt;

      // Step 3: Emit if not replaced
      if (!jobWasReplaced) {
        mockGenerationJobManager.emitDone(streamId, { final: true });
      }

      expect(callOrder).toEqual(['saveMessage', 'emitDone']);
    });
  });

  describe('Aborted Request Handling', () => {
    it('should use unfinished: true instead of error: true for aborted requests', () => {
      const response = { messageId: 'response-123', content: [] };

      // The new format for aborted responses
      const abortedResponse = { ...response, unfinished: true };

      expect(abortedResponse.unfinished).toBe(true);
      expect(abortedResponse.error).toBeUndefined();
    });

    it('should include unfinished flag in final event for aborted requests', () => {
      const response = { messageId: 'response-123', content: [] };

      // Old format (deprecated)
      const _oldFinalEvent = {
        final: true,
        responseMessage: { ...response, error: true },
        error: { message: 'Request was aborted' },
      };

      // New format (PR #11462)
      const newFinalEvent = {
        final: true,
        responseMessage: { ...response, unfinished: true },
      };

      expect(newFinalEvent.responseMessage.unfinished).toBe(true);
      expect(newFinalEvent.error).toBeUndefined();
      expect(newFinalEvent.responseMessage.error).toBeUndefined();
    });
  });
  /**
   * ────────────────────────────────────────────────────────────────────────
   * AMBER LACEY'S SILENT TURN — Aug 23 2026, 22:21:44Z
   *
   * Reproduced from her seat's live log, in order:
   *
   *   22:21:44.513  [InMemoryJobStore] Created job: 75ba512a-…
   *   22:21:46.027  [AgentStream] Client subscribed …, resume: false
   *   22:21:51.443  [AgentStream] Method: POST, Path: /chat/abort
   *   22:21:51.443  [AgentStream] Job found, aborting: 75ba512a-…
   *   22:21:51.445  [InMemoryJobStore] Deleted job: 75ba512a-…
   *   22:22:04      (reframe) content-turn response sent, finalLength=1359
   *   22:21:53.223  [ResumableAgentController] Skipping FINAL emit -
   *                 job was replaced   ← currentCreatedAt: UNDEFINED
   *
   * `currentCreatedAt: undefined` is the tell. A genuine replacement carries a
   * newer NUMBER there; undefined means the job was simply gone — deleted by
   * its own abort. The generation ran on to completion and produced a real
   * 1,359-character reply, which was saved to the database and then announced
   * to nobody. Her client, still painting tool activity, had no terminal event
   * to act on and sat that way for about ninety seconds. She is blind; the
   * silence WAS the bug.
   * ────────────────────────────────────────────────────────────────────────
   */
  describe("Amber Lacey's silent turn (Aug 23 2026)", () => {
    /** The real order of operations from request.js, with the fixed predicate. */
    const finishTurn = async ({ streamId, jobCreatedAt, wasAbortedBeforeComplete, response }) => {
      const currentJob = await mockGenerationJobManager.getJob(streamId);
      const jobWasReplaced = !!currentJob && currentJob.createdAt !== jobCreatedAt;

      if (jobWasReplaced) {
        mockLogger.debug('Skipping FINAL emit - job was replaced', {
          streamId,
          originalCreatedAt: jobCreatedAt,
          currentCreatedAt: currentJob?.createdAt,
        });
        return { emitted: false, reason: 'replaced' };
      }

      const finalEvent = {
        final: true,
        responseMessage: wasAbortedBeforeComplete ? { ...response, unfinished: true } : response,
      };
      mockGenerationJobManager.emitDone(streamId, finalEvent);
      mockGenerationJobManager.completeJob(
        streamId,
        wasAbortedBeforeComplete ? 'Request aborted' : undefined,
      );
      return { emitted: true, reason: wasAbortedBeforeComplete ? 'aborted' : 'complete', finalEvent };
    };

    const HER_REPLY = 'x'.repeat(1359);

    it('emits a terminal event when the abort deleted the job and the reply finished anyway', async () => {
      const streamId = '75ba512a-3bf8-4191-9746-d406e035f7b7';
      const jobCreatedAt = 1787523704513;

      /** abortJob → deleteJob, so the store now answers with nothing at all. */
      mockGenerationJobManager.getJob.mockResolvedValue(null);

      const result = await finishTurn({
        streamId,
        jobCreatedAt,
        wasAbortedBeforeComplete: true,
        response: { messageId: 'resp-1', text: HER_REPLY },
      });

      expect(result.emitted).toBe(true);
      expect(result.reason).toBe('aborted');
      expect(mockGenerationJobManager.emitDone).toHaveBeenCalledTimes(1);
      expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(streamId, 'Request aborted');
    });

    it('carries her actual reply, marked unfinished, rather than an empty turn', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(null);

      const { finalEvent } = await finishTurn({
        streamId: '75ba512a-3bf8-4191-9746-d406e035f7b7',
        jobCreatedAt: 1787523704513,
        wasAbortedBeforeComplete: true,
        response: { messageId: 'resp-1', text: HER_REPLY },
      });

      expect(finalEvent.responseMessage.text).toHaveLength(1359);
      expect(finalEvent.responseMessage.unfinished).toBe(true);
    });

    it('never logs "job was replaced" when nothing replaced it', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(null);

      await finishTurn({
        streamId: '75ba512a-3bf8-4191-9746-d406e035f7b7',
        jobCreatedAt: 1787523704513,
        wasAbortedBeforeComplete: true,
        response: { messageId: 'resp-1', text: HER_REPLY },
      });

      expect(mockLogger.debug).not.toHaveBeenCalledWith(
        'Skipping FINAL emit - job was replaced',
        expect.anything(),
      );
    });

    it('still stays quiet for a genuinely NEWER job — the case the guard is for', async () => {
      const streamId = '75ba512a-3bf8-4191-9746-d406e035f7b7';

      mockGenerationJobManager.getJob.mockResolvedValue({ createdAt: 1787523999999 });

      const result = await finishTurn({
        streamId,
        jobCreatedAt: 1787523704513,
        wasAbortedBeforeComplete: false,
        response: { messageId: 'resp-1', text: 'stale' },
      });

      expect(result.emitted).toBe(false);
      expect(result.reason).toBe('replaced');
      expect(mockGenerationJobManager.emitDone).not.toHaveBeenCalled();
    });

    /**
     * The helpers above can drift from the controller they model — that is how a
     * spec keeps passing while production regresses. This one reads the real
     * file, so an upstream merge that restores `!currentJob ||` goes red here.
     */
    it('the real controller does not treat an absent job as replaced', () => {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'request.js'),
        'utf8',
      );

      expect(src).toContain(
        'const jobWasReplaced = !!currentJob && currentJob.createdAt !== jobCreatedAt;',
      );
      expect(src).not.toContain(
        'const jobWasReplaced = !currentJob || currentJob.createdAt !== jobCreatedAt;',
      );
    });
  });
});
