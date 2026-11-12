/**
 * TURN-1 (turn audit, Nov 12 2026): FINAL no longer waits for the memory keeper.
 *
 * chatCompletion's `finally` used to race the keeper against a fixed 3 s timer, which held the
 * reply's FINAL event (and with it the website's read-aloud, every client's "done" and the next
 * send) for up to 3 s on short replies. It now passes kadeKeeperFinalWaitMs() -- 0 by default --
 * and a keeper still running is left to scheduleMemoryArtifactPersistence (request.js).
 */
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('~/server/services/Config', () => ({
  getMCPServerTools: jest.fn(),
}));

jest.mock('~/server/services/MCP', () => ({
  resolveConfigServers: jest.fn().mockResolvedValue({}),
}));

const { logger } = require('@librechat/data-schemas');
const AgentClient = require('../client');

const wait = (promise, ms) => AgentClient.prototype.awaitMemoryWithTimeout.call({}, promise, ms);

describe('AgentClient.awaitMemoryWithTimeout (TURN-1)', () => {
  beforeEach(() => {
    logger.info.mockClear();
    logger.error.mockClear();
    logger.warn.mockClear();
  });

  it('takes a keeper that already finished, even with a 0 ms wait', async () => {
    await expect(wait(Promise.resolve(['a']), 0)).resolves.toEqual(['a']);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('does not wait for a keeper still running at 0 ms, and says so once', async () => {
    const t0 = Date.now();
    await expect(wait(new Promise(() => {}), 0)).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(20);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0][0]).toMatch(/keeper still running at FINAL/);
  });

  it('returns a keeper that finishes inside a longer wait and leaves no timer behind', async () => {
    jest.useFakeTimers();
    try {
      const keeper = new Promise((resolve) => setTimeout(() => resolve(['late']), 5));
      const out = wait(keeper, 200);
      jest.advanceTimersByTime(5);
      await expect(out).resolves.toEqual(['late']);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a keeper that fails returns nothing and logs one error, with no stray rejection', async () => {
    const stray = [];
    const onStray = (e) => stray.push(e);
    process.on('unhandledRejection', onStray);
    try {
      await expect(wait(Promise.reject(new Error('boom')), 0)).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(stray).toHaveLength(0);
    } finally {
      process.removeListener('unhandledRejection', onStray);
    }
  });

  it('no keeper at all returns nothing and logs nothing', async () => {
    await expect(wait(undefined, 0)).resolves.toBeUndefined();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
