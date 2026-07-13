const axios = require('axios');
const { logger } = require('@librechat/data-schemas');

/**
 * KADE July 13 2026 — "sight" for text-only agents.
 *
 * DeepSeek V4 Pro (the fleet model) is text-only on every endpoint, so when
 * someone shares a photo with Kiana she'd normally be blind to it. This
 * auto-describes attached images through the SAME proven blind-first vision
 * pipeline the /describe page and the gallery use (KADE_VISION_MODEL on
 * OpenRouter), then the description is injected into the message as text so a
 * text model "sees" it. Kade's ask: make it a DAMN GOOD describer — so the
 * prompt is richer here than the gallery's terse one (this is a companion
 * reacting to what a friend just shared, not a catalog caption).
 *
 * Fail-soft everywhere: any error returns null and the caller proceeds exactly
 * as before (image simply not described). Never throws into the chat pipeline.
 */

const VISION_MODEL = process.env.KADE_VISION_MODEL || 'google/gemini-3.1-flash-lite';

// Models with NATIVE image input — skip auto-describe for these (they see the
// image directly). Substring match on the agent's model string. Everything
// else (deepseek, hermes, glm, mistral, kimi, …) is treated as text-only.
const NATIVE_VISION_HINTS = [
  'minimax', 'gemini', 'grok-4', 'gpt-4o', 'gpt-5', 'claude', 'mimo', 'pixtral',
  'llava', 'qwen2.5-vl', 'qwen3-vl', 'gpt-4.1', 'o4', 'vl-', 'vision',
];

function modelHasNativeVision(model) {
  const m = String(model || '').toLowerCase();
  return NATIVE_VISION_HINTS.some((h) => m.includes(h));
}

const SIGHT_INSTRUCTION =
  'You are the eyes of a blind person who was just shown this image in a conversation. ' +
  'Describe it fully and vividly so they miss nothing a sighted friend would notice at a glance and on a second look. ' +
  'Lead with the single most important thing, then fill in: who or what is in it and what they are doing; ' +
  'facial expressions, body language, and mood; the setting and background; colors, lighting, and time of day; ' +
  'notable objects and how things are arranged; and ANY text, signs, labels, or writing reproduced EXACTLY, word for word. ' +
  'If it is a screenshot or document, read it out in full. If something is unclear or ambiguous, say so honestly rather than guessing. ' +
  'Write in warm, plain, concrete language — no "this image shows", no hedging preamble, just start describing. ' +
  'Aim for a thorough short paragraph (more if the image is dense with text or detail).';

/**
 * @param {Array<{type?:string, image_url?:{url?:string}}>} imageParts - OpenAI-format image parts (from encodeAndFormat).
 * @param {object} opts
 * @param {string} [opts.userId] - for usage logging.
 * @returns {Promise<string|null>} combined description, or null on any failure / no key.
 */
async function describeAttachedImages(imageParts, opts = {}) {
  try {
    const key = process.env.OPENROUTER_KEY;
    if (!key || !Array.isArray(imageParts) || imageParts.length === 0) {
      return null;
    }
    const urls = imageParts
      .map((p) => p && p.image_url && p.image_url.url)
      .filter((u) => typeof u === 'string' && u.length > 0)
      .slice(0, 4); // cap: never describe more than 4 images in one turn
    if (urls.length === 0) {
      return null;
    }

    const describeOne = async (url, idx) => {
      const content = [
        { type: 'text', text: SIGHT_INSTRUCTION },
        { type: 'image_url', image_url: { url } },
      ];
      const r = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: VISION_MODEL,
          max_tokens: 700,
          messages: [{ role: 'user', content }],
          usage: { include: true },
        },
        {
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://kademurdock.com',
            'X-Title': 'Kade-AI Companion Sight',
          },
          timeout: 60000,
        },
      );
      const text = r.data?.choices?.[0]?.message?.content;
      const cost = typeof r.data?.usage?.cost === 'number' ? r.data.usage.cost : 0;
      return { text: typeof text === 'string' ? text.trim() : '', cost, idx };
    };

    const results = await Promise.all(urls.map((u, i) => describeOne(u, i).catch((e) => {
      logger.warn(`[kadeImageSight] describe failed for image ${i}: ${e.message}`);
      return null;
    })));

    const good = results.filter((r) => r && r.text);
    if (good.length === 0) {
      return null;
    }

    // Usage logging (metered like the gallery describer), fail-soft.
    try {
      const totalCost = good.reduce((s, r) => s + (r.cost || 0), 0);
      if (opts.userId) {
        const { logKadeUsage } = require('~/models/kadeUsage');
        logKadeUsage({
          userId: String(opts.userId),
          service: 'describe',
          quantity: good.length,
          unit: 'items',
          costUSD: totalCost,
          metadata: { source: 'companion_sight', model: VISION_MODEL },
        });
      }
    } catch { /* logging must never break sight */ }

    if (good.length === 1) {
      return good[0].text;
    }
    return good
      .sort((a, b) => a.idx - b.idx)
      .map((r, i) => `Photo ${i + 1}: ${r.text}`)
      .join('\n\n');
  } catch (e) {
    logger.warn(`[kadeImageSight] describeAttachedImages failed: ${e.message}`);
    return null;
  }
}

module.exports = { describeAttachedImages, modelHasNativeVision };
