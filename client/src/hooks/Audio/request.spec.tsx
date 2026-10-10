import { act, renderHook } from '@testing-library/react';
import { useSpeechRequest } from './request';

const props = { conversationId: 'chat-a', runId: 'run-a', callActive: false };

test.each([
  { ...props, conversationId: 'chat-b' },
  { ...props, runId: 'run-b' },
  { ...props, callActive: true },
])('scope change cancels buffered WAV ownership before late completion: %p', (next) => {
  const cancelled = jest.fn();
  const { result, rerender } = renderHook(
    (scope) => useSpeechRequest(scope.conversationId, scope.runId, scope.callActive, cancelled),
    { initialProps: props },
  );
  const controller = result.current.begin();
  const lateBlob = new Blob(['RIFF'], { type: 'audio/wav' });
  const publish = jest.fn();
  rerender(next);
  if (result.current.isCurrent(controller)) publish(lateBlob);
  expect(controller.signal.aborted).toBe(true);
  expect(publish).not.toHaveBeenCalled();
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(result.current.finish(controller)).toBe(false);
});

test('stale completion cannot clear or cancel a newer audio request', () => {
  const cancelled = jest.fn();
  const { result } = renderHook(() => useSpeechRequest('chat', 'run', false, cancelled));
  const previous = result.current.begin();
  const current = result.current.begin();
  expect(previous.signal.aborted).toBe(true);
  expect(result.current.finish(previous)).toBe(false);
  expect(result.current.isCurrent(current)).toBe(true);
  expect(current.signal.aborted).toBe(false);
  expect(cancelled).not.toHaveBeenCalled();
});

test('unmount aborts the pending response; successful completion needs no cancellation', () => {
  const cancelled = jest.fn();
  const first = renderHook(() => useSpeechRequest('chat', 'run', false, cancelled));
  const controller = first.result.current.begin();
  first.unmount();
  expect(controller.signal.aborted).toBe(true);
  expect(first.result.current.isCurrent(controller)).toBe(false);
  const second = renderHook(() => useSpeechRequest('chat', 'run', false, cancelled));
  const complete = second.result.current.begin();
  act(() => {
    expect(second.result.current.finish(complete)).toBe(true);
  });
  second.unmount();
  expect(cancelled).toHaveBeenCalledTimes(1);
});
