/* Sweep 5.0 (Nov 13 2026): the helpers that keep auto read-aloud from ending in silence. */
import {
  SpeechFetchTimeout,
  sameChatGotItsAddress,
  speechFetchTimeoutMs,
  voiceFallbackOn,
  withAnswerTimeout,
} from './speechFetch';

beforeEach(() => {
  localStorage.clear();
  jest.useRealTimers();
});

describe('withAnswerTimeout', () => {
  it('rejects with a plain timeout error when the request never answers, and aborts nothing', async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const never = new Promise<Response>(() => undefined);
    const waiting = withAnswerTimeout(never, 25000);
    const seen = jest.fn();
    waiting.catch(seen);
    jest.advanceTimersByTime(24999);
    await Promise.resolve();
    expect(seen).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await expect(waiting).rejects.toBeInstanceOf(SpeechFetchTimeout);
    await expect(waiting).rejects.toThrow('25 seconds');
    // The caller reports the failure first; an aborted controller would read as "cancelled".
    expect(controller.signal.aborted).toBe(false);
  });

  it('passes an answer or a failure through and leaves no timer behind', async () => {
    jest.useFakeTimers();
    await expect(withAnswerTimeout(Promise.resolve('ok'), 25000)).resolves.toBe('ok');
    await expect(withAnswerTimeout(Promise.reject(new Error('down')), 25000)).rejects.toThrow(
      'down',
    );
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a limit of 0 waits for ever, as before', () => {
    const request = new Promise<string>(() => undefined);
    expect(withAnswerTimeout(request, 0)).toBe(request);
  });
});

describe('speechFetchTimeoutMs', () => {
  it('is 25 s by default, settable per browser, and off with the undo switch', () => {
    expect(speechFetchTimeoutMs()).toBe(25000);
    localStorage.setItem('kadeVoiceFetchTimeoutMs', '40000');
    expect(speechFetchTimeoutMs()).toBe(40000);
    localStorage.setItem('kadeVoiceFetchTimeoutMs', '0');
    expect(speechFetchTimeoutMs()).toBe(0);
    localStorage.setItem('kadeVoiceFetchTimeoutMs', 'soon');
    expect(speechFetchTimeoutMs()).toBe(25000);
    localStorage.removeItem('kadeVoiceFetchTimeoutMs');
    localStorage.setItem('kadeVoiceFallback', '0');
    expect(voiceFallbackOn()).toBe(false);
    expect(speechFetchTimeoutMs()).toBe(0);
  });
});

describe('sameChatGotItsAddress', () => {
  it('is true only for /c/new becoming the chat that is on screen', () => {
    expect(sameChatGotItsAddress('new', 'abc', 'abc')).toBe(true);
    expect(sameChatGotItsAddress('new', 'abc', 'other')).toBe(false); // she opened another chat
    expect(sameChatGotItsAddress('new', 'abc', undefined)).toBe(false);
    expect(sameChatGotItsAddress('abc', 'def', 'def')).toBe(false);
    expect(sameChatGotItsAddress('new', 'new', 'new')).toBe(false);
    expect(sameChatGotItsAddress(undefined, 'abc', 'abc')).toBe(false);
  });

  it('the kadeVoiceFallback undo switch pauses on every route change again', () => {
    localStorage.setItem('kadeVoiceFallback', '0');
    expect(sameChatGotItsAddress('new', 'abc', 'abc')).toBe(false);
  });
});
