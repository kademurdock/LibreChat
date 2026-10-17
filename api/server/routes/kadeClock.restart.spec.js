/**
 * The nightly restart (Oct 17 2026): the clock's restart exit is not a SIGTERM, so nothing would
 * wait for a background task. The route declines while one runs and holds new starts once it
 * decides to exit.
 */
const express = require('express');
const request = require('supertest');

jest.mock('@librechat/api', () => ({ diaryDiagnostic: jest.fn() }), { virtual: true });
jest.mock('~/server/services/kadeNudges', () => ({
  runNudgeSweepOnce: jest.fn(),
  computeNextDueAt: jest.fn(),
}));
jest.mock('~/server/services/kadeMemorySummarySweep', () => ({ runSummarySweep: jest.fn() }));
jest.mock('~/server/services/Memory/consolidationSweep', () => ({
  runScheduledConsolidation: jest.fn(),
}));
jest.mock('~/server/services/Config', () => ({ getAppConfig: jest.fn() }));
jest.mock('~/server/services/Files/process', () => ({ sweepExpiredFiles: jest.fn() }));
jest.mock('~/server/services/kadeTasks', () => ({
  busy: jest.fn(),
  holdStarts: jest.fn(),
  runningHere: jest.fn(() => 0),
}));

const tasks = require('~/server/services/kadeTasks');
const router = require('./kadeClock');

const SECRET = 'clock-test-secret';
const app = express();
app.use('/api/kade/clock', router);

describe('POST /api/kade/clock/restart', () => {
  let exitSpy;
  let uptimeSpy;

  beforeEach(() => {
    process.env.BRIDGE_SECRET = SECRET;
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
    uptimeSpy = jest.spyOn(process, 'uptime').mockReturnValue(3 * 3600);
    tasks.runningHere.mockReturnValue(0);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    uptimeSpy.mockRestore();
    jest.useRealTimers();
  });

  const poke = () => request(app).post('/api/kade/clock/restart').set('x-kade-secret', SECRET);

  test('declines while a background task is running, and never exits', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    tasks.busy.mockResolvedValue({ here: 1, running: 1, draining: false });
    const res = await poke();
    expect(res.body).toMatchObject({ ok: true, restarted: false, busy: true, running: 1 });
    jest.advanceTimersByTime(5000);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(tasks.holdStarts).not.toHaveBeenCalledWith(true);
  });

  test('a task running on another server (deploy overlap) also holds the restart', async () => {
    tasks.busy.mockResolvedValue({ here: 0, running: 1, draining: false });
    const res = await poke();
    expect(res.body.busy).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('restarts when nothing runs, holding new starts from the moment it decides', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    tasks.busy.mockResolvedValue({ here: 0, running: 0, draining: false });
    const res = await poke();
    expect(res.body).toEqual({ ok: true, restarted: true });
    expect(tasks.holdStarts).toHaveBeenCalledWith(true);
    jest.advanceTimersByTime(1500);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('a start that slipped in while it decided makes it back out and lets starts go', async () => {
    tasks.busy.mockResolvedValue({ here: 0, running: 0, draining: false });
    tasks.runningHere.mockReturnValue(1);
    const res = await poke();
    expect(res.body).toMatchObject({ restarted: false, busy: true });
    expect(tasks.holdStarts).toHaveBeenLastCalledWith(false);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('still refuses within two hours of boot, and without the secret', async () => {
    uptimeSpy.mockReturnValue(600);
    expect((await poke()).body).toMatchObject({ restarted: false, reason: 'booted <2h ago' });
    expect((await request(app).post('/api/kade/clock/restart')).status).toBe(403);
  });
});
