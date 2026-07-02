const axios = require('axios');
const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');
const { logKadeUsage } = require('~/models/kadeUsage');
const { logKadeAsset } = require('~/models/kadeAsset');

/**
 * FalAI ("fal_studio") — video + design-image generation via fal.ai.
 *
 * Models (verified July 2026):
 *  - Video standard: fal-ai/kling-video/v3/standard/text-to-video ($0.084/s, +audio $0.126/s)
 *  - Video premium:  fal-ai/veo3.1/fast ($0.10/s, +audio $0.15/s @1080p)
 *  - Image:          fal-ai/bytedance/seedream/v4.5/text-to-image ($0.04/image, 4K, best text-in-image)
 *
 * Auth: FAL_KEY env var (or per-user key via the tool auth dialog).
 * Usage is logged to kadeusage (services fal_video / fal_image) at submit
 * time with the deterministic per-second price so it lands on the user's tab.
 */
const FAL_MODELS = {
  image: 'fal-ai/bytedance/seedream/v4.5/text-to-image',
  video_standard: 'fal-ai/kling-video/v3/standard/text-to-video',
  video_premium: 'fal-ai/veo3.1/fast',
};
const QUEUE_ALIAS = {
  video_standard: 'fal-ai/kling-video',
  video_premium: 'fal-ai/veo3.1',
};

const falJsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['generate_image', 'generate_video', 'check_video'],
      description:
        "'generate_image' = Seedream 4.5 design/photo image (fast, ~$0.04). 'generate_video' = text-to-video clip. 'check_video' = poll a video that wasn't finished when generate_video returned.",
    },
    prompt: {
      type: 'string',
      description:
        'Detailed prompt. For video: describe shot, subject, motion, mood, camera. For images: Seedream 4.5 excels at legible TEXT inside images (logos, signs, flyers, memes) — quote any exact wording.',
    },
    quality: {
      type: 'string',
      enum: ['standard', 'premium'],
      description:
        "Video only. 'standard' = Kling 3.0 (default, ~$0.42-0.63 per 5s). 'premium' = Veo 3.1 Fast, cinematic + native audio (~$0.75 per 5-8s). Use premium only when the user asks for top quality.",
    },
    duration_seconds: {
      type: 'integer',
      description: 'Video length in seconds. Standard: 5 or 10 (default 5). Premium: 4, 6, or 8 (default 8).',
    },
    audio: {
      type: 'boolean',
      description: 'Video only: generate native audio/sound. Default false for standard (cheaper), true for premium.',
    },
    aspect_ratio: {
      type: 'string',
      enum: ['16:9', '9:16', '1:1'],
      description: 'Aspect ratio (default 16:9). Use 9:16 for phone-style vertical video.',
    },
    image_size: {
      type: 'string',
      enum: ['square_hd', 'portrait_4_3', 'portrait_16_9', 'landscape_4_3', 'landscape_16_9'],
      description: 'Image only: output shape (default landscape_4_3).',
    },
    request_id: {
      type: 'string',
      description: "check_video only: the request id returned by generate_video.",
    },
  },
  required: ['action'],
};

class FalAI extends Tool {
  constructor(fields = {}) {
    super();
    this.override = fields.override ?? false;
    this.userId = fields.userId;
    this.name = 'fal_studio';
    this.description =
      'Generate short AI VIDEOS (Kling 3.0 standard / Veo 3.1 Fast premium) and best-in-class design IMAGES with legible text (Seedream 4.5) via fal.ai. ' +
      'Video costs real money per second (~$0.42-1.30 per clip) and takes 1-4 minutes to render; images cost ~$0.04 and are fast.';
    this.description_for_model =
      this.description +
      " For video: tell the user the clip is rendering and the rough cost BEFORE generating; if generate_video returns a request_id instead of a URL, wait for the user's next message or ~2 minutes, then call check_video with it. " +
      'Always show returned media as markdown: images as ![desc](url), videos as [Watch the video](url). Enhance thin prompts into rich visual descriptions first.';
    this.schema = falJsonSchema;
    this.apiKey = fields.FAL_KEY || process.env.FAL_KEY || '';
    if (!this.apiKey && !this.override) {
      throw new Error('Missing FAL_KEY — add a fal.ai API key to enable video/design generation.');
    }
  }

  headers() {
    return { Authorization: `Key ${this.apiKey}`, 'Content-Type': 'application/json' };
  }

  logUsage(service, quantity, unit, costUSD, metadata) {
    logKadeUsage({ userId: this.userId, service, quantity, unit, costUSD, metadata }).catch(() => {});
  }

  async _call(data) {
    const { action } = data || {};
    try {
      if (action === 'generate_image') return await this.generateImage(data);
      if (action === 'generate_video') return await this.generateVideo(data);
      if (action === 'check_video') return await this.checkVideo(data);
      return "Unknown action. Use 'generate_image', 'generate_video', or 'check_video'.";
    } catch (err) {
      const msg = err?.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
      logger.error('[FalAI] error:', msg);
      return `fal.ai request failed: ${msg}`;
    }
  }

  async generateImage(data) {
    if (!data.prompt) return 'prompt is required for generate_image.';
    const body = {
      prompt: data.prompt,
      image_size: data.image_size || 'landscape_4_3',
      num_images: 1,
      enable_safety_checker: true,
    };
    const r = await axios.post(`https://fal.run/${FAL_MODELS.image}`, body, {
      headers: this.headers(),
      timeout: 120000,
    });
    const img = r.data?.images?.[0];
    if (!img?.url) return 'Seedream returned no image. Try rewording the prompt.';
    this.logUsage('fal_image', 1, 'images', 0.04, { model: 'seedream-4.5' });
    logKadeAsset({
      userId: this.userId,
      kind: 'image',
      service: 'fal_image',
      url: img.url,
      prompt: data.prompt,
      model: 'seedream-4.5',
      costUSD: 0.04,
    }).catch(() => {});
    return `![${(data.prompt || 'generated image').slice(0, 80).replace(/[[\]]/g, '')}](${img.url})\n\nImage generated with Seedream 4.5 (~$0.04). Saved to your gallery at /my-creations.`;
  }

  videoPricing(quality, seconds, audio) {
    if (quality === 'premium') return seconds * (audio === false ? 0.10 : 0.15);
    return seconds * (audio ? 0.126 : 0.084);
  }

  async generateVideo(data) {
    if (!data.prompt) return 'prompt is required for generate_video.';
    const quality = data.quality === 'premium' ? 'premium' : 'standard';
    const model = FAL_MODELS[`video_${quality}`];
    let body;
    let seconds;
    const audio = typeof data.audio === 'boolean' ? data.audio : quality === 'premium';
    if (quality === 'premium') {
      seconds = [4, 6, 8].includes(data.duration_seconds) ? data.duration_seconds : 8;
      body = {
        prompt: data.prompt,
        duration: `${seconds}s`,
        aspect_ratio: data.aspect_ratio || '16:9',
        generate_audio: audio,
        resolution: '1080p',
      };
    } else {
      seconds = data.duration_seconds === 10 ? 10 : 5;
      body = {
        prompt: data.prompt,
        duration: String(seconds),
        aspect_ratio: data.aspect_ratio || '16:9',
        generate_audio: audio,
      };
    }
    const submit = await axios.post(`https://queue.fal.run/${model}`, body, {
      headers: this.headers(),
      timeout: 30000,
    });
    const requestId = submit.data?.request_id;
    const statusUrl = submit.data?.status_url;
    const responseUrl = submit.data?.response_url;
    if (!requestId) return 'fal.ai did not accept the video job. Try again.';

    const estUSD = Math.round(this.videoPricing(quality, seconds, audio) * 100) / 100;
    this.logUsage('fal_video', seconds, 'seconds', estUSD, {
      model: quality === 'premium' ? 'veo-3.1-fast' : 'kling-3.0-standard',
      requestId,
      audio,
    });

    // Poll in-call for up to ~150s — Kling standard 5s clips usually finish inside this.
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 6000));
      try {
        const st = await axios.get(statusUrl, { headers: this.headers(), timeout: 15000 });
        if (st.data?.status === 'COMPLETED') {
          const out = await axios.get(responseUrl, { headers: this.headers(), timeout: 20000 });
          const url = out.data?.video?.url || out.data?.videos?.[0]?.url;
          if (url) {
            logKadeAsset({
              userId: this.userId,
              kind: 'video',
              service: 'fal_video',
              url,
              prompt: data.prompt,
              model: quality === 'premium' ? 'veo-3.1-fast' : 'kling-3.0-standard',
              costUSD: estUSD,
              metadata: { requestId, seconds, audio },
            }).catch(() => {});
            return `[Watch the video](${url})\n\n${seconds}s ${quality} clip (~$${estUSD}) — it plays right in the chat, and it's saved to your gallery at /my-creations.`;
          }
          return `The video finished but no URL came back. Raw: ${JSON.stringify(out.data).slice(0, 300)}`;
        }
        if (st.data?.status === 'FAILED') {
          return 'Video generation failed on fal.ai (you were still charged ~$' + estUSD + ' per their billing — mention this to the user).';
        }
      } catch (e) {
        logger.warn('[FalAI] poll error:', e.message);
      }
    }
    return (
      `The video is still rendering (request_id: ${requestId}, quality: ${quality}). ` +
      `Call check_video with that request_id and quality in about 2 minutes. Estimated cost ~$${estUSD} was logged.`
    );
  }

  async checkVideo(data) {
    if (!data.request_id) return 'request_id is required for check_video.';
    const quality = data.quality === 'premium' ? 'premium' : 'standard';
    const alias = QUEUE_ALIAS[`video_${quality}`];
    const st = await axios.get(`https://queue.fal.run/${alias}/requests/${data.request_id}/status`, {
      headers: this.headers(),
      timeout: 20000,
    });
    if (st.data?.status === 'COMPLETED') {
      const out = await axios.get(`https://queue.fal.run/${alias}/requests/${data.request_id}`, {
        headers: this.headers(),
        timeout: 20000,
      });
      const url = out.data?.video?.url || out.data?.videos?.[0]?.url;
      if (url) {
        logKadeAsset({
          userId: this.userId,
          kind: 'video',
          service: 'fal_video',
          url,
          prompt: data.prompt,
          model: quality === 'premium' ? 'veo-3.1-fast' : 'kling-3.0-standard',
          metadata: { requestId: data.request_id },
        }).catch(() => {});
        return `[Watch the video](${url})\n\nIt plays right in the chat, and it's saved to your gallery at /my-creations.`;
      }
      return `Finished but no URL in the response: ${JSON.stringify(out.data).slice(0, 300)}`;
    }
    if (st.data?.status === 'FAILED') return 'That video generation failed on fal.ai.';
    return `Still rendering (status: ${st.data?.status || 'IN_PROGRESS'}). Check again in a minute or two.`;
  }
}

module.exports = FalAI;
