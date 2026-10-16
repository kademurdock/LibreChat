'use strict';
/* Oct 16 2026: one /voices.json read feeds voices, hidden and aliases together. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchLiveCatalog, getCachedLiveHidden } = require('./voiceCatalog');

test('fetchLiveCatalog hands back voices, hidden and aliases from the same read', async () => {
  const realFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return {
      ok: true,
      json: async () => ({
        voices: ['New Name'],
        hidden: ['Old Name'],
        aliases: ['Kiana (Comedian)'],
      }),
    };
  };
  try {
    const catalog = await fetchLiveCatalog('https://tts.example.invalid/v1/audio/speech');
    assert.deepEqual(catalog, {
      voices: ['New Name'],
      hidden: ['Old Name'],
      aliases: ['Kiana (Comedian)'],
    });
    assert.deepEqual(urls, ['https://tts.example.invalid/voices.json']);
    assert.deepEqual(getCachedLiveHidden(), ['Old Name'], 'the TTS lane reads the same snapshot');
    globalThis.fetch = async () => {
      throw new Error('proxy down');
    };
    assert.deepEqual(
      await fetchLiveCatalog('https://tts.example.invalid/v1/audio/speech'),
      catalog,
      'inside the 5-minute window the cached read answers',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
