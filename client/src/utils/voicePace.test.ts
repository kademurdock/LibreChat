import {
  characterSpeedFor,
  generationRate,
  purgeOldVoiceCache,
  speedLabel,
  speedOptions,
  speedSpoken,
  voiceCacheKey,
  voiceSpeeds,
} from './voicePace';

describe('voice speed list', () => {
  it('is exactly the agreed numbers, keeping everything shipped apps send', () => {
    expect([...voiceSpeeds]).toEqual([0.75, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5]);
    for (const shipped of [0.75, 0.9, 1, 1.2, 1.5]) {
      expect(voiceSpeeds).toContain(shipped);
    }
  });
  it('shows a saved number off the list as itself, in order', () => {
    expect(speedOptions(1.25)).toEqual([0.75, 0.8, 0.9, 1, 1.1, 1.2, 1.25, 1.3, 1.4, 1.5]);
    expect(speedOptions(0.6)[0]).toBe(0.6);
    expect(speedOptions(1.2)).toEqual([...voiceSpeeds]);
    expect(speedOptions(null)).toEqual([...voiceSpeeds]);
    expect(speedOptions(undefined)).toEqual([...voiceSpeeds]);
    expect(speedOptions(NaN)).toEqual([...voiceSpeeds]);
  });
  it('labels for the eye and for the ear', () => {
    expect(speedLabel(1.2)).toBe('1.2x');
    expect(speedLabel(1)).toBe('1x');
    expect(speedSpoken(1.2)).toBe('1.2 times');
  });
  it('says 1x as Normal, never "1 times"', () => {
    expect(speedSpoken(1)).toBe('Normal');
    expect(speedLabel(1)).toBe('1x');
    for (const speed of voiceSpeeds.filter((rate) => rate !== 1)) {
      expect(speedSpoken(speed)).toBe(`${speed} times`);
    }
  });
});

describe('provider generation pace', () => {
  it('restricts API speed and lets an explicit listener choice override the character', () => {
    expect(generationRate(1.4, 1.2)).toBe(1.2);
    expect(generationRate(1.25, null)).toBe(1.25);
    expect(generationRate(1, 2)).toBe(1.5);
    expect(generationRate(1, 0.1)).toBe(0.5);
    expect(generationRate(undefined, NaN)).toBe(1);
    expect(generationRate(undefined, null)).toBe(1);
  });
});

describe('a character speed belongs to its own builder voice', () => {
  it('applies with the builder voice in use', () => {
    expect(characterSpeedFor('Builder', undefined, 1.2)).toBe(1.2);
    expect(characterSpeedFor('Builder', null, 1.2)).toBe(1.2);
  });
  it('still applies when the listener picked that same voice by hand', () => {
    expect(characterSpeedFor('Builder', 'Builder', 1.2)).toBe(1.2);
  });
  it('does not follow a listener onto their own voice', () => {
    expect(characterSpeedFor('Builder', 'Mine', 1.2)).toBeUndefined();
  });
  it('needs both a builder voice and a number', () => {
    expect(characterSpeedFor(undefined, undefined, 1.2)).toBeUndefined();
    expect(characterSpeedFor(undefined, 'Mine', 1.2)).toBeUndefined();
    expect(characterSpeedFor('Builder', undefined, null)).toBeUndefined();
    expect(characterSpeedFor('Builder', undefined, undefined)).toBeUndefined();
  });
});

describe('voice audio cache', () => {
  it('never reuses an old pace, voice, filler, or text-only audio cache entry', () => {
    const key = voiceCacheKey('same words', 'Fish voice', 1.2, true);
    expect(key).not.toBe(voiceCacheKey('same words', 'Classic voice', 1.2, true));
    expect(key).not.toBe(voiceCacheKey('same words', 'Fish voice', 1, true));
    expect(key).not.toBe(voiceCacheKey('same words', 'Fish voice', 1.2, false));
    expect(key).toContain('pacing-v4');
    expect(key).not.toContain('pacing-v3');
  });

  describe('purge of older keys', () => {
    const realCaches = (globalThis as { caches?: unknown }).caches;
    const origin = 'https://example.test';
    const makeStore = (paths: string[]) => {
      const entries = new Map(paths.map((path) => [`${origin}${path}`, true]));
      const open = jest.fn(async () => ({
        keys: async () => [...entries.keys()].map((url) => ({ url })),
        delete: async (request: { url: string }) => entries.delete(request.url),
      }));
      (globalThis as { caches?: unknown }).caches = { open };
      return { entries, open };
    };

    afterEach(() => {
      localStorage.clear();
      (globalThis as { caches?: unknown }).caches = realCaches;
    });

    it('deletes every older /__voice-cache/ key and leaves everything else', async () => {
      const current = voiceCacheKey('new', 'Voice', 1.2, true);
      const { entries, open } = makeStore([
        '/__voice-cache/pacing-v3?text=a',
        '/__voice-cache/pacing-v2?text=b',
        current,
        '/api/files/speech/tts?messageId=kept',
      ]);
      await expect(purgeOldVoiceCache()).resolves.toBe(2);
      expect(open).toHaveBeenCalledWith('tts-responses');
      expect([...entries.keys()]).toEqual([
        `${origin}${current}`,
        `${origin}/api/files/speech/tts?messageId=kept`,
      ]);
    });

    it('runs once per browser', async () => {
      const { open } = makeStore(['/__voice-cache/pacing-v3?text=a']);
      await purgeOldVoiceCache();
      await purgeOldVoiceCache();
      expect(open).toHaveBeenCalledTimes(1);
    });

    it('never throws when the Cache API is missing or broken, and tries again next time', async () => {
      (globalThis as { caches?: unknown }).caches = undefined;
      await expect(purgeOldVoiceCache()).resolves.toBe(0);
      (globalThis as { caches?: unknown }).caches = {
        open: async () => {
          throw new Error('blocked');
        },
      };
      await expect(purgeOldVoiceCache()).resolves.toBe(0);
      expect(localStorage.getItem('voiceCachePurged')).toBeNull();
    });
  });
});
