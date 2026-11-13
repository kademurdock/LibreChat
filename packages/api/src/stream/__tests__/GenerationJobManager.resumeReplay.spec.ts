import type { ServerSentEvent } from '~/types';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';

jest.spyOn(console, 'log').mockImplementation();

function createInMemoryManager(): GenerationJobManagerClass {
  const manager = new GenerationJobManagerClass();
  manager.configure({
    jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
    eventTransport: new InMemoryEventTransport(),
    isRedis: false,
  });
  manager.initialize();
  return manager;
}

class SnapshotReplayJobStore extends InMemoryJobStore {
  async getJob(streamId: string) {
    const job = await super.getJob(streamId);
    return job ? { ...job } : null;
  }

  async updateJob(streamId: string, updates: Parameters<InMemoryJobStore['updateJob']>[1]) {
    if (updates.replayEvents) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await super.updateJob(streamId, updates);
  }
}

function createSnapshotReplayManager(): GenerationJobManagerClass {
  const manager = new GenerationJobManagerClass();
  manager.configure({
    jobStore: new SnapshotReplayJobStore({ ttlAfterComplete: 60000 }),
    eventTransport: new InMemoryEventTransport(),
    isRedis: false,
  });
  manager.initialize();
  return manager;
}

describe('GenerationJobManager resume replay events', () => {
  let manager: GenerationJobManagerClass | undefined;

  afterEach(async () => {
    await manager?.destroy();
    manager = undefined;
  });

  test('includes OAuth run step and delta replay events in resume state', async () => {
    manager = createInMemoryManager();
    const streamId = `oauth-delta-resume-${Date.now()}`;
    await manager.createJob(streamId, 'user-1', streamId);

    const runStepEvent = {
      event: 'on_run_step',
      data: {
        id: 'step-oauth',
        runId: 'USE_PRELIM_RESPONSE_MESSAGE_ID',
        index: 0,
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [{ id: 'call-oauth', name: 'oauth_mcp_Google-Workspace', args: '' }],
        },
      },
    } satisfies ServerSentEvent;
    const authEvent = {
      event: 'on_run_step_delta',
      data: {
        id: 'step-oauth',
        delta: {
          type: 'tool_calls',
          tool_calls: [{ name: 'oauth_mcp_Google-Workspace', args: '' }],
          auth: 'https://auth.example.com/oauth',
          expires_at: 1780791946,
        },
      },
    } satisfies ServerSentEvent;

    await manager.emitChunk(streamId, runStepEvent);
    await manager.emitChunk(streamId, authEvent);
    await manager.emitChunk(streamId, {
      event: 'on_run_step',
      data: {
        id: 'step-regular',
        runId: 'response-1',
        index: 1,
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [{ id: 'call-regular', name: 'regular-tool', args: '{}' }],
        },
      },
    });
    await manager.emitChunk(streamId, {
      event: 'on_run_step_delta',
      data: {
        id: 'step-no-auth',
        delta: {
          type: 'tool_calls',
          tool_calls: [{ name: 'regular-tool', args: '{}' }],
        },
      },
    });

    const resumeState = await manager.getResumeState(streamId);

    expect(resumeState?.replayEvents).toEqual([runStepEvent, authEvent]);
  });

  test('replaces OAuth replay event for the same step id', async () => {
    manager = createInMemoryManager();
    const streamId = `oauth-delta-replace-${Date.now()}`;
    await manager.createJob(streamId, 'user-1', streamId);

    await manager.emitChunk(streamId, {
      event: 'on_run_step_delta',
      data: {
        id: 'step-oauth',
        delta: {
          tool_calls: [{ name: 'oauth_mcp_Google-Workspace', args: '' }],
          auth: 'https://auth.example.com/first',
          expires_at: 1780791946,
        },
      },
    });

    const replacementEvent = {
      event: 'on_run_step_delta',
      data: {
        id: 'step-oauth',
        delta: {
          tool_calls: [{ name: 'oauth_mcp_Google-Workspace', args: '' }],
          auth: 'https://auth.example.com/latest',
          expires_at: 1780792000,
        },
      },
    } satisfies ServerSentEvent;

    await manager.emitChunk(streamId, replacementEvent);

    const resumeState = await manager.getResumeState(streamId);

    expect(resumeState?.replayEvents).toEqual([replacementEvent]);
  });

  test('does not replay non-MCP action auth deltas', async () => {
    manager = createInMemoryManager();
    const streamId = `action-auth-delta-${Date.now()}`;
    await manager.createJob(streamId, 'user-1', streamId);

    await manager.emitChunk(streamId, {
      event: 'on_run_step_delta',
      data: {
        id: 'step-action-auth',
        delta: {
          type: 'tool_calls',
          tool_calls: [{ name: 'google_calendar_action_api_example_com', args: '' }],
          auth: 'https://auth.example.com/action',
          expires_at: 1780791946,
        },
      },
    });

    const resumeState = await manager.getResumeState(streamId);

    expect(resumeState?.replayEvents).toBeUndefined();
  });

  test('serializes replay event updates for concurrent MCP OAuth prompts', async () => {
    manager = createSnapshotReplayManager();
    const streamId = `oauth-delta-concurrent-${Date.now()}`;
    await manager.createJob(streamId, 'user-1', streamId);

    const createRunStepEvent = (serverName: string, index: number) =>
      ({
        event: 'on_run_step',
        data: {
          id: `step-oauth-${serverName}`,
          runId: 'USE_PRELIM_RESPONSE_MESSAGE_ID',
          index,
          stepDetails: {
            type: 'tool_calls',
            tool_calls: [{ id: `call-${serverName}`, name: `oauth_mcp_${serverName}`, args: '' }],
          },
        },
      }) satisfies ServerSentEvent;

    const createAuthEvent = (serverName: string) =>
      ({
        event: 'on_run_step_delta',
        data: {
          id: `step-oauth-${serverName}`,
          delta: {
            type: 'tool_calls',
            tool_calls: [{ name: `oauth_mcp_${serverName}`, args: '' }],
            auth: `https://auth.example.com/${serverName}`,
            expires_at: 1780791946,
          },
        },
      }) satisfies ServerSentEvent;

    const events = [
      createRunStepEvent('Google-Workspace', 0),
      createAuthEvent('Google-Workspace'),
      createRunStepEvent('clickhouse-docs', 1),
      createAuthEvent('clickhouse-docs'),
    ];

    await Promise.all(events.map((event) => manager!.emitChunk(streamId, event)));

    const resumeState = await manager.getResumeState(streamId);

    expect(resumeState?.replayEvents).toHaveLength(events.length);
    expect(resumeState?.replayEvents).toEqual(expect.arrayContaining(events));
  });
});

describe('KADE cursor log', () => {
  let manager: GenerationJobManagerClass | undefined;
  const delta = (text: string) =>
    ({
      event: 'on_message_delta',
      data: { id: 'step-1', delta: { content: [{ type: 'text', text }] } },
    }) as ServerSentEvent;

  afterEach(async () => {
    delete process.env.KADE_STREAM_LOG;
    delete process.env.KADE_STREAM_LOG_MAX;
    delete process.env.KADE_STREAM_LOG_EAGER;
    await manager?.destroy();
    manager = undefined;
  });

  test('replays exactly the events after a cursor, including ones emitted with nobody listening', async () => {
    manager = createInMemoryManager();
    const streamId = `kade-log-${Date.now()}`;
    await manager.createJob(streamId, 'user-1', streamId);
    const a = delta('One. ');
    const b = delta('Two. ');
    const c = delta('Three.');
    const sub = await manager.subscribe(streamId, () => {});
    await manager.emitChunk(streamId, a);
    await manager.emitChunk(streamId, b);
    sub?.unsubscribe();
    await manager.emitChunk(streamId, c);

    const idA = manager.kadeIdOf(a);
    const idC = manager.kadeIdOf(c);
    expect(idA?.seq).toBe(1);
    expect(idC?.seq).toBe(3);
    expect(manager.kadeReplayAfter(streamId, idA!.epoch, idA!.seq)).toEqual({ exact: true, events: [b, c] });
    expect(manager.kadeReplayAfter(streamId, idC!.epoch, idC!.seq)).toEqual({ exact: true, events: [] });
  });

  test('a cursor from another job, or past the end, is not exact and says why', async () => {
    manager = createInMemoryManager();
    const streamId = `kade-log-epoch-${Date.now()}`;
    await manager.createJob(streamId, 'user-1', streamId);
    const a = delta('One.');
    await manager.emitChunk(streamId, a);
    const id = manager.kadeIdOf(a)!;
    expect(manager.kadeReplayAfter(streamId, 'deadbeef', 1)).toEqual({ exact: false, reason: 'other-job', events: [] });
    expect(manager.kadeReplayAfter(streamId, id.epoch, 99)).toEqual({ exact: false, reason: 'out-of-range', events: [] });
  });

  test('a trimmed log refuses a cursor from before the trim', async () => {
    process.env.KADE_STREAM_LOG_MAX = '200';
    manager = createInMemoryManager();
    const streamId = `kade-log-trim-${Date.now()}`;
    await manager.createJob(streamId, 'user-1', streamId);
    const first = delta('0');
    await manager.emitChunk(streamId, first);
    for (let i = 1; i < 500; i++) {
      await manager.emitChunk(streamId, delta(String(i)));
    }
    const id = manager.kadeIdOf(first)!;
    expect(manager.kadeReplayAfter(streamId, id.epoch, id.seq)?.exact).toBe(false);
    expect(manager.kadeReplayAfter(streamId, id.epoch, 500)).toEqual({ exact: true, events: [] });
    expect(manager.kadeReplayAfter(streamId, id.epoch, 499)?.events).toHaveLength(1);
  });

  test('the same event object is never logged twice', async () => {
    manager = createInMemoryManager();
    const streamId = `kade-log-once-${Date.now()}`;
    await manager.createJob(streamId, 'user-1', streamId);
    const a = delta('One.');
    await manager.emitChunk(streamId, a);
    await manager.emitChunk(streamId, a);
    expect(manager.kadeIdOf(a)?.seq).toBe(1);
  });

  test('KADE_STREAM_LOG=0 keeps no log', async () => {
    process.env.KADE_STREAM_LOG = '0';
    manager = createInMemoryManager();
    const streamId = `kade-log-off-${Date.now()}`;
    await manager.createJob(streamId, 'user-1', streamId);
    const a = delta('One.');
    await manager.emitChunk(streamId, a);
    expect(manager.kadeIdOf(a)).toBeUndefined();
    expect(manager.kadeReplayAfter(streamId, 'deadbeef', 0)).toBeNull();
  });

  test('a turn that replaces the job on the same stream answers an old cursor with other-job', async () => {
    manager = createInMemoryManager();
    const streamId = `kade-log-replaced-${Date.now()}`;
    await manager.createJob(streamId, 'user-1', streamId);
    const a = delta('Old turn.');
    await manager.emitChunk(streamId, a);
    const old = manager.kadeIdOf(a)!;
    await manager.createJob(streamId, 'user-1', streamId);
    const b = delta('New turn.');
    await manager.emitChunk(streamId, b);
    expect(manager.kadeIdOf(b)?.epoch).not.toBe(old.epoch);
    expect(manager.kadeReplayAfter(streamId, old.epoch, old.seq)).toEqual({
      exact: false,
      reason: 'other-job',
      events: [],
    });
  });

  /* Sweep 4.1 (Nov 13 2026): the epoch is made with the job, not on its first event. */
  test('a new turn with no event yet still answers an old cursor with other-job', async () => {
    manager = createInMemoryManager();
    const streamId = `kade-log-early-${Date.now()}`;
    await manager.createJob(streamId, 'user-1', streamId);
    const a = delta('Old turn.');
    await manager.emitChunk(streamId, a);
    const old = manager.kadeIdOf(a)!;
    await manager.createJob(streamId, 'user-1', streamId); // the new turn: nothing emitted yet
    expect(manager.kadeReplayAfter(streamId, old.epoch, old.seq)).toEqual({
      exact: false,
      reason: 'other-job',
      events: [],
    });
    const b = delta('New turn.');
    await manager.emitChunk(streamId, b);
    expect(manager.kadeIdOf(b)?.seq).toBe(1);
    expect(manager.kadeIdOf(b)?.epoch).not.toBe(old.epoch);
  });

  test('KADE_STREAM_LOG_EAGER=0 makes the log on the first event, as before', async () => {
    process.env.KADE_STREAM_LOG_EAGER = '0';
    manager = createInMemoryManager();
    const streamId = `kade-log-lazy-${Date.now()}`;
    await manager.createJob(streamId, 'user-1', streamId);
    expect(manager.kadeReplayAfter(streamId, 'deadbeef', 1)).toBeNull();
    await manager.emitChunk(streamId, delta('One.'));
    expect(manager.kadeReplayAfter(streamId, 'deadbeef', 1)?.reason).toBe('other-job');
  });

  /* Sweep 4.0 (Nov 13 2026): the heartbeat's quiet-cap follows the job's last real event. */
  test('kadeLastEventAt starts at creation and moves only when the job emits', async () => {
    manager = createInMemoryManager();
    const streamId = `kade-last-event-${Date.now()}`;
    expect(manager.kadeLastEventAt(streamId)).toBeUndefined();
    const nowSpy = jest.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_000_000);
      await manager.createJob(streamId, 'user-1', streamId);
      expect(manager.kadeLastEventAt(streamId)).toBe(1_000_000);
      nowSpy.mockReturnValue(1_050_000);
      const sub = await manager.subscribe(streamId, () => {});
      await manager.subscribeWithResume(streamId, () => {}, () => {}, () => {});
      expect(manager.kadeLastEventAt(streamId)).toBe(1_000_000); // listeners coming and going are not activity
      nowSpy.mockReturnValue(1_090_000);
      await manager.emitChunk(streamId, delta('One.'));
      expect(manager.kadeLastEventAt(streamId)).toBe(1_090_000);
      sub?.unsubscribe();
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('an event the manager refuses to send is never logged', async () => {
    manager = createInMemoryManager();
    const streamId = `kade-log-refused-${Date.now()}`;
    await manager.createJob(streamId, 'user-1', streamId);
    const internal = { _internal: true, event: 'x', data: {} } as unknown as ServerSentEvent;
    await manager.emitChunk(streamId, internal);
    expect(manager.kadeIdOf(internal)).toBeUndefined();
    const stale = delta('From another reply.');
    await manager.emitChunk(streamId, stale, 'not-the-current-response');
    expect(manager.kadeIdOf(stale)).toBeUndefined();
  });
});
