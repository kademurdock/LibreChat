const axios = require('axios');
const mongoose = require('mongoose');
const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');
const { logKadeUsage, KadeUsage } = require('~/models/kadeUsage');
const { logKadeAsset, KadeAsset } = require('~/models/kadeAsset');

/**
 * FalAI ("fal_studio") — video + design-image generation via fal.ai.
 *
 * Models (verified July 2026):
 *  - Video standard: fal-ai/kling-video/v3/standard/text-to-video ($0.084/s, +audio $0.126/s)
 *  - Video premium:  fal-ai/veo3.1/fast ($0.10/s, +audio $0.15/s @1080p)
 *  - Image→video:    fal-ai/kling-video/v3/standard/image-to-video (param start_image_url; $0.084/s)
 *  - Image:          fal-ai/bytedance/seedream/v4.5/text-to-image ($0.04/image, 4K, best text-in-image)
 *
 * Auth: FAL_KEY env var (or per-user key via the tool auth dialog).
 * Usage is logged to kadeusage (services fal_video / fal_image) at submit
 * time with the deterministic per-second price so it lands on the user's tab.
 *
 * SPEND GUARDRAIL: video generation is capped per user per calendar month
 * (KADE_FAL_MONTHLY_CAP_USD, default $5; 0 disables; admins exempt). The cap
 * counts all fal spend (video + Seedream images) already logged this month.
 */
const FAL_MODELS = {
  image: 'fal-ai/bytedance/seedream/v4.5/text-to-image',
  video_standard: 'fal-ai/kling-video/v3/standard/text-to-video',
  video_premium: 'fal-ai/veo3.1/fast',
  video_animate: 'fal-ai/kling-video/v3/standard/image-to-video',
  audio: 'bytedance/seed-audio-1.0',
};
const QUEUE_ALIAS = {
  video_standard: 'fal-ai/kling-video',
  video_premium: 'fal-ai/veo3.1',
  video_animate: 'fal-ai/kling-video',
};

// Seed Audio 1.0 preset voices (English/Chinese leaning). A reference clip in
// audio_urls overrides any preset.
const AUDIO_VOICES = [
  'vivi_mixed_en_zh_ja_es_id', 'mindy_en_es_id_pt_zh', 'kian_en_zh', 'cedric_en_zh',
  'sophie_en_zh', 'jean_en_zh', 'magnus_en_zh', 'mabel_en_zh', 'nadia_en_zh',
  'opal_en_zh', 'pearl_en_zh', 'quentin_en_zh', 'corinne_mixed_en_zh',
  'esther_mixed_en_zh', 'lyla_mixed_en_zh', 'tracy_es_zh', 'sandy_es_mixed_en_zh',
  'felix_zh', 'celeste_zh', 'monkey_king_zh',
];

const MONTHLY_CAP_USD = (() => {
  const v = parseFloat(process.env.KADE_FAL_MONTHLY_CAP_USD ?? '5');
  return Number.isFinite(v) ? v : 5;
})();

const falJsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['generate_image', 'generate_video', 'animate_image', 'check_video', 'generate_audio'],
      description:
        "'generate_image' = Seedream 4.5 design/photo image (fast, ~$0.04). 'generate_video' = text-to-video clip. " +
        "'animate_image' = bring a still image to LIFE as a video (Kling image-to-video) — e.g. make a dog photo wag its tail. " +
        "'check_video' = poll a video that wasn't finished when generate_video/animate_image returned. " +
        "'generate_audio' = Seed Audio 1.0 CINEMATIC AUDIO: multi-character dialogue, sound effects, music and ambience in ONE clip (up to ~2 min), plus text-to-speech, voice cloning, and editing existing audio (extend / inpaint / stitch / swap a line) via audio_urls. Returns fast and synchronously with a real audio URL. ~$0.075/minute.",
    },
    prompt: {
      type: 'string',
      description:
        'Detailed prompt. For video: describe shot, subject, motion, mood, camera. For animate_image: describe the MOTION you want (what moves and how). For images: Seedream 4.5 excels at legible TEXT inside images (logos, signs, flyers, memes) — quote any exact wording. For generate_audio: write it like a short audio SCRIPT — [genre + environment + mood], a continuous sound bed, then each line as `Name (voice traits, emotion, pace) says: \"dialogue.\"` with concrete [sound effect] cues; specify the language (English or Chinese). Max 2,048 characters (~2 minutes).',
    },
    image_url: {
      type: 'string',
      description:
        "animate_image: URL of the still image to animate. OMIT IT to auto-pick: a photo the user attached/uploaded in the last 24 hours wins, otherwise their most recent generated image from the gallery. Any public https image URL also works. The tool's reply NAMES which image it used — relay that to the user. Oversized sources (>10MB) are auto-shrunk to fit fal's limit. generate_audio: optional single reference image to generate a matching audio scene from (cannot be combined with audio_urls).",
    },
    quality: {
      type: 'string',
      enum: ['standard', 'premium'],
      description:
        "generate_video only. 'standard' = Kling 3.0 (default, ~$0.42-0.63 per 5s). 'premium' = Veo 3.1 Fast, cinematic + native audio (~$0.75 per 5-8s). Use premium only when the user asks for top quality.",
    },
    duration_seconds: {
      type: 'integer',
      description: 'Video length in seconds. Standard/animate: 5 or 10 (default 5). Premium: 4, 6, or 8 (default 8).',
    },
    audio: {
      type: 'boolean',
      description:
        "generate_video and animate_image: generate native audio/sound. SOUND MATTERS on this platform (blind users experience videos through it) — if the user hasn't said, ASK once: with sound (standard 5s ≈ $0.63) or silent (cheapest, 5s ≈ $0.42)? Defaults: false for standard/animate, true for premium.",
    },
    aspect_ratio: {
      type: 'string',
      enum: ['16:9', '9:16', '1:1'],
      description: 'Aspect ratio (default 16:9). Use 9:16 for phone-style vertical video. Ignored for animate_image (follows the source image).',
    },
    image_size: {
      type: 'string',
      enum: ['square_hd', 'portrait_4_3', 'portrait_16_9', 'landscape_4_3', 'landscape_16_9'],
      description: 'Image only: output shape (default landscape_4_3).',
    },
    voice: {
      type: 'string',
      enum: AUDIO_VOICES,
      description:
        'generate_audio only: optional preset voice. Omit to let the prompt describe the voice, or when using audio_urls (a reference clip overrides any preset).',
    },
    audio_urls: {
      type: 'array',
      items: { type: 'string' },
      description:
        "generate_audio only: up to 3 reference audio clip URLs (≤30s each), referenced in the prompt as @Audio1/@Audio2/@Audio3. This is how you CLONE a voice, EXTEND / EDIT / INPAINT an existing clip, or STITCH two clips together. Accepts public https URLs or the user's own gallery/upload URLs.",
    },
    use_recent_audio: {
      type: 'boolean',
      description:
        "generate_audio only: set true when the user says 'extend/continue/edit/redo MY last clip' (or similar) and gives no URL — auto-loads their most recent uploaded or generated clip as @Audio1. Leave false/absent for brand-new scenes.",
    },
    output_format: {
      type: 'string',
      enum: ['mp3', 'wav', 'pcm', 'ogg_opus'],
      description: 'generate_audio only: output audio format (default mp3).',
    },
    speed: {
      type: 'number',
      description: 'generate_audio only: speech speed, 0.5–2.0 (default 1).',
    },
    pitch: {
      type: 'integer',
      description: 'generate_audio only: voice pitch shift in semitones, -12 to 12 (default 0).',
    },
    request_id: {
      type: 'string',
      description: "check_video only: the request id returned by generate_video/animate_image.",
    },
  },
  required: ['action'],
};

class FalAI extends Tool {
  constructor(fields = {}) {
    super();
    this.override = fields.override ?? false;
    this.userId = fields.userId;
    this.req = fields.req;
    this.name = 'fal_studio';
    this.description =
      'Generate short AI VIDEOS (Kling 3.0 standard / Veo 3.1 Fast premium), ANIMATE still images into video (image-to-video), make best-in-class design IMAGES with legible text (Seedream 4.5), and generate CINEMATIC AUDIO — dialogue, sound effects, music and voice cloning (Seed Audio 1.0) — via fal.ai. ' +
      'Video costs real money per second (~$0.42-1.30 per clip) and takes 1-4 minutes to render; images cost ~$0.04 and audio ~$0.075/minute, both fast. ' +
      `Each user has a ~$${MONTHLY_CAP_USD}/month fal budget; the tool enforces it and says so politely if they've hit it.`;
    this.description_for_model =
      this.description +
      " For video: tell the user the clip is rendering and the rough cost BEFORE generating. If generate_video or animate_image returns a request_id instead of a URL: you CANNOT send messages on your own later, so NEVER say 'I'll ping you' or 'I'll check back' — instead END your reply by asking the user to send any message in ~2 minutes ('just say ready'), and on their NEXT message call check_video FIRST and deliver the result before anything else. " +
      "animate_image with no image_url automatically animates the photo the user uploaded (last 24 hours), or else their most recent generated image — perfect for 'here's my dog, make him wag' or 'now make it move'. Its reply names WHICH image it used: repeat that to the user so nothing gets animated by surprise. animate_image always renders on Kling standard — never promise premium/Veo for an animation. " +
      "Before any video, if the user hasn't specified, ask ONCE whether they want sound (recommended here — blind users experience video through audio; standard 5s: ~$0.63 with sound vs ~$0.42 silent) and only use premium quality when the user picks it. " +
      'Always show returned media as markdown: images as ![desc](url), videos as [Watch the video](url), audio as [Play the audio](url). Enhance thin prompts into rich visual descriptions first. ' +
      "AUDIO (generate_audio, Seed Audio 1.0): cinematic scenes with dialogue + sound effects + music + ambience in one ~2-min pass, plus TTS, voice cloning, and editing existing clips (extend / inpaint / stitch / swap a line). It returns FAST and synchronously with a real audio URL — there is NO request_id and NO check step, so never promise to follow up. Return it as [Play the audio](url) so it plays inline; it is auto-saved to the gallery with a blind-friendly description of what the listener will hear. It is cheap (~$0.075/min, about 15 cents for a full 2 minutes) and rides the same monthly fal budget — mention the small cost but there is no need to pre-ask for a normal clip. For voice cloning or editing, pass reference clips in audio_urls (or set use_recent_audio:true for 'my last clip'). English and Chinese only; keep prompts under 2,048 characters.";
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

  /**
   * Monthly fal spend guardrail (videos only — images are pennies).
   * Returns null when the job may proceed, or a polite refusal string.
   * Fails OPEN on internal errors: a DB hiccup should not break video, and
   * every generation still logs spend regardless.
   */
  async checkBudget(estUSD) {
    try {
      if (!MONTHLY_CAP_USD || MONTHLY_CAP_USD <= 0 || !this.userId) {
        return null;
      }
      const oid = new mongoose.Types.ObjectId(String(this.userId));
      const User = mongoose.models.User;
      if (User) {
        const u = await User.findById(oid).select('role').lean();
        if (u && String(u.role).toUpperCase() === 'ADMIN') {
          return null;
        }
      }
      // KADE prepaid Stage A: fal draws from the shared wallet ($1 = 1,000,000 credits).
      // Admin already returned null above. Block at $0. Fail open on any error.
      try {
        const Balance = mongoose.models.Balance;
        if (Balance) {
          const bal = await Balance.findOne({ user: oid }).select('tokenCredits').lean();
          if (bal && typeof bal.tokenCredits === 'number') {
            const dollars = bal.tokenCredits / 1e6;
            if (dollars - estUSD < 0) {
              logger.info(`[FalAI] wallet block: user ${this.userId} has $${dollars.toFixed(2)}, needs $${estUSD.toFixed(2)}`);
              return (
                `OUT OF CREDITS — do not retry. This user has about $${dollars.toFixed(2)} of prepaid credits left, ` +
                `and this (~$${estUSD.toFixed(2)}) would go over. Tell them warmly they've used up their credits for now ` +
                `and can ask Kade to add more; a picture is nearly free if they want something small.`
              );
            }
          }
        }
      } catch (e) { /* fail open — never block on a balance-check error */ }
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const agg = await KadeUsage.aggregate([
        {
          $match: {
            user: oid,
            service: { $in: ['fal_video', 'fal_image', 'fal_audio'] },
            createdAt: { $gte: monthStart },
          },
        },
        { $group: { _id: null, total: { $sum: '$costUSD' } } },
      ]);
      const spent = agg?.[0]?.total || 0;
      if (spent + estUSD > MONTHLY_CAP_USD) {
        const resetDate = new Date(now.getFullYear(), now.getMonth() + 1, 1).toLocaleDateString(
          'en-US',
          { month: 'long', day: 'numeric' },
        );
        logger.info(`[FalAI] budget block: user ${this.userId} spent $${spent.toFixed(2)} of $${MONTHLY_CAP_USD}`);
        return (
          `BUDGET REACHED — do not retry. This user has used $${spent.toFixed(2)} of their ` +
          `$${MONTHLY_CAP_USD.toFixed(2)} monthly video budget, and this clip (~$${estUSD.toFixed(2)}) would go over. ` +
          `Tell them warmly that they've hit their video budget for this month, it resets on ${resetDate}, ` +
          'and offer a picture instead (images are outside the cap and nearly free).'
        );
      }
      return null;
    } catch (err) {
      logger.warn('[FalAI] budget check failed open:', err.message);
      return null;
    }
  }

  async _call(data) {
    const { action } = data || {};
    try {
      if (action === 'generate_image') return await this.generateImage(data);
      if (action === 'generate_video') return await this.generateVideo(data);
      if (action === 'animate_image') return await this.animateImage(data);
      if (action === 'check_video') return await this.checkVideo(data);
      if (action === 'generate_audio') return await this.generateAudio(data);
      return "Unknown action. Use 'generate_image', 'generate_video', 'animate_image', 'check_video', or 'generate_audio'.";
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

  audioCost(seconds) {
    // $0.075 per minute of generated audio, kept to 3 decimals.
    return Math.round((Number(seconds) / 60) * 0.075 * 1000) / 1000;
  }

  /** Absolutize a site-relative URL and re-sign it if it is a stale S3 link. */
  async absoluteResign(u) {
    let src = String(u || '').trim();
    if (src && !/^https?:\/\//i.test(src)) {
      const base = (process.env.DOMAIN_SERVER || 'https://kademurdock.com').replace(/\/$/, '');
      src = base + (src.startsWith('/') ? src : '/' + src);
    }
    try {
      const { needsRefresh, getNewS3URL } = require('@librechat/api');
      if (
        typeof needsRefresh === 'function' &&
        typeof getNewS3URL === 'function' &&
        /[?&]X-Amz-/.test(src) &&
        needsRefresh(src, 300)
      ) {
        src = await getNewS3URL(src);
      }
    } catch (e) {
      logger.warn('[FalAI] audio ref re-sign skipped:', e.message);
    }
    return src;
  }

  /**
   * Resolve up to 3 reference clips for Seed Audio. Explicit audio_urls win.
   * With none given, use_recent_audio pulls the user's most recent uploaded
   * (last 24h) or generated audio as @Audio1 — the "extend/edit my last clip"
   * flow. Brand-new scenes pass nothing and stay reference-free.
   */
  async resolveAudioRefs(data) {
    let raw = [];
    if (Array.isArray(data.audio_urls)) {
      raw = data.audio_urls.filter(Boolean).map(String);
    } else if (typeof data.audio_urls === 'string' && data.audio_urls.trim()) {
      raw = [data.audio_urls.trim()];
    }
    let note = '';
    if (raw.length === 0 && this.userId) {
      const oid = new mongoose.Types.ObjectId(String(this.userId));
      const File = mongoose.models.File;
      // 1) Audio files attached to THIS message win — freshly uploaded, in the
      //    order attached, and scoped to this turn (no bleed from an earlier
      //    conversation's uploads).
      try {
        const ids = this._currentMessageAudioFileIds();
        if (File && ids.length) {
          const docs = await File.find({
            user: oid,
            file_id: { $in: ids },
            type: /^audio\//,
          }).lean();
          const byId = new Map(docs.map((d) => [String(d.file_id), d]));
          const ordered = ids
            .map((id) => byId.get(String(id)))
            .filter(Boolean)
            .slice(0, 3);
          if (ordered.length) {
            raw = ordered.map((d) => String(d.filepath)).filter(Boolean);
            const names = ordered
              .map((d, i) => `@Audio${i + 1} = ${d.filename ? '"' + String(d.filename).slice(0, 40) + '"' : 'clip'}`)
              .join(', ');
            note = `Using the ${raw.length} clip${raw.length > 1 ? 's' : ''} you attached here (${names}).`;
          }
        }
      } catch (e) {
        logger.warn('[FalAI] current-message audio lookup failed:', e.message);
      }
      // 2) "extend/edit my last clip" with nothing attached to this message:
      //    the single most-recent uploaded clip, else the last generated clip.
      if (raw.length === 0 && data.use_recent_audio) {
        try {
          if (File) {
            const up = await File.findOne({
              user: oid,
              type: /^audio\//,
              createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
            })
              .sort({ createdAt: -1 })
              .lean();
            if (up?.filepath) {
              raw = [String(up.filepath)];
              note = up.filename
                ? `Reference @Audio1 = the clip you uploaded ("${String(up.filename).slice(0, 60)}").`
                : 'Reference @Audio1 = the clip you uploaded.';
            }
          }
        } catch (e) {
          logger.warn('[FalAI] recent audio lookup failed:', e.message);
        }
        if (raw.length === 0) {
          const latest = await KadeAsset.findOne({ user: oid, kind: 'audio' })
            .sort({ createdAt: -1 })
            .lean();
          if (latest?.url) {
            raw = [String(latest.url)];
            note = 'Reference @Audio1 = your most recent generated clip.';
          }
        }
      }
    }
    const urls = [];
    for (const u of raw.slice(0, 3)) {
      const abs = await this.absoluteResign(u);
      urls.push(await this.trimAudioRefIfLong(abs));
    }
    return { urls, note };
  }

  /** file_ids of audio files attached to the CURRENT message (req.body.files). */
  _currentMessageAudioFileIds() {
    try {
      const files = this.req && this.req.body && this.req.body.files;
      if (!Array.isArray(files)) {
        return [];
      }
      return files
        .filter((f) => f && (!f.type || /^audio\//.test(String(f.type))))
        .map((f) => f && (f.file_id || f.fileId))
        .filter(Boolean)
        .map(String);
    } catch (e) {
      void e;
      return [];
    }
  }

  /**
   * Seed Audio caps voice-clone reference clips at 30 seconds. If a resolved
   * reference is longer, download it, trim to 29s (mono 24kHz WAV via ffmpeg),
   * re-host on S3, and return the trimmed URL. Fails OPEN (returns the original
   * URL) if ffprobe/ffmpeg or the S3 upload isn't available.
   */
  async trimAudioRefIfLong(url) {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { spawnSync } = require('child_process');
    let tmpIn = null;
    let tmpOut = null;
    try {
      if (!url || !/^https?:\/\//i.test(url) || !this.userId) {
        return url;
      }
      const resp = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 15 * 1024 * 1024,
      });
      tmpIn = path.join(os.tmpdir(), `kade-ref-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      fs.writeFileSync(tmpIn, Buffer.from(resp.data));
      const probe = spawnSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', tmpIn],
        { encoding: 'utf8', timeout: 15000 },
      );
      const dur = parseFloat(String(probe.stdout || '').trim());
      if (!Number.isFinite(dur) || dur <= 30.2) {
        return url;
      }
      tmpOut = `${tmpIn}.wav`;
      const cut = spawnSync(
        'ffmpeg',
        ['-y', '-i', tmpIn, '-t', '29', '-ac', '1', '-ar', '24000', tmpOut],
        { timeout: 30000 },
      );
      if (cut.status !== 0 || !fs.existsSync(tmpOut)) {
        logger.warn('[FalAI] reference trim: ffmpeg failed, using original clip');
        return url;
      }
      const buffer = fs.readFileSync(tmpOut);
      const { saveBufferToS3 } = require('@librechat/api');
      if (typeof saveBufferToS3 !== 'function') {
        return url;
      }
      const newUrl = await saveBufferToS3({
        userId: String(this.userId),
        buffer,
        fileName: `kade-ref-trim-${Date.now()}.wav`,
        basePath: 'audios',
      });
      if (newUrl) {
        logger.info(`[FalAI] trimmed reference clip ${dur.toFixed(1)}s -> 29s for Seed Audio`);
        return newUrl;
      }
      return url;
    } catch (e) {
      logger.warn('[FalAI] reference trim skipped:', e.message);
      return url;
    } finally {
      try {
        if (tmpIn && fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
      } catch (e) {
        void e;
      }
      try {
        if (tmpOut && fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
      } catch (e) {
        void e;
      }
    }
  }

  /**
   * generate_audio — Seed Audio 1.0 (bytedance/seed-audio-1.0), synchronous.
   * One call covers cinematic scenes, TTS, voice cloning, and audio editing;
   * the workflow is chosen by the prompt plus which reference clips ride along.
   */
  async generateAudio(data) {
    if (!data.prompt) return 'prompt is required for generate_audio.';
    const fullPrompt = String(data.prompt);
    const { urls: refUrls, note: refNote } = await this.resolveAudioRefs(data);
    const hasRefsOrImage = refUrls.length > 0 || !!data.image_url;
    // A prompt over Seed Audio's 2,048-char cap is AUTO-SPLIT into parts and
    // each is generated, so the caller always gets audio instead of a dead-end
    // error (only when there are no reference clips/image to keep semantics).
    if (fullPrompt.length > 2048 && !hasRefsOrImage) {
      return await this.generateAudioParts(fullPrompt, data);
    }
    if (fullPrompt.length > 2048) {
      return (
        "That audio prompt is over Seed Audio's 2,048-character limit and can't be auto-split " +
        'because it uses reference audio/image. Shorten it to one ~2-minute piece, or drop the references.'
      );
    }
    const blocked = await this.checkBudget(0.15);
    if (blocked) return blocked;
    const res = await this._genOneAudio(fullPrompt, data, refUrls);
    if (!res) return 'Seed Audio returned no clip. Try rewording the prompt.';
    const mmss = `${Math.floor(res.seconds / 60)}:${String(res.seconds % 60).padStart(2, '0')}`;
    const notePrefix = refNote ? `${refNote}\n\n` : '';
    return (
      `${notePrefix}[Play the audio](${res.url})\n\n` +
      `Seed Audio clip — ${mmss} long (~$${res.costUSD.toFixed(3)}). It plays right here in the chat, ` +
      "and it's saved to your gallery at /my-creations."
    );
  }

  /** One Seed Audio generation -> { url, seconds, costUSD } or null. Logs usage + gallery. */
  async _genOneAudio(promptText, data, refUrls) {
    const body = {
      prompt: promptText,
      output_format: ['mp3', 'wav', 'pcm', 'ogg_opus'].includes(data.output_format)
        ? data.output_format
        : 'mp3',
    };
    if (typeof data.speed === 'number' && data.speed >= 0.5 && data.speed <= 2) {
      body.speed = data.speed;
    }
    if (Number.isInteger(data.pitch) && data.pitch >= -12 && data.pitch <= 12) {
      body.pitch = data.pitch;
    }
    if (refUrls && refUrls.length > 0) {
      body.audio_urls = refUrls;
    } else if (data.image_url) {
      body.image_url = await this.absoluteResign(data.image_url);
    } else if (data.voice && AUDIO_VOICES.includes(data.voice)) {
      body.voice = data.voice;
    }
    const r = await axios.post(`https://fal.run/${FAL_MODELS.audio}`, body, {
      headers: this.headers(),
      timeout: 180000,
    });
    const audio = r.data?.audio;
    if (!audio?.url) return null;
    const seconds = Math.max(1, Math.round(Number(audio.duration) || 0));
    const costUSD = this.audioCost(seconds);
    this.logUsage('fal_audio', seconds, 'seconds', costUSD, {
      model: 'seed-audio-1.0',
      refs: (refUrls && refUrls.length) || 0,
      format: body.output_format,
    });
    logKadeAsset({
      userId: this.userId,
      kind: 'audio',
      service: 'fal_audio',
      url: audio.url,
      prompt: promptText,
      model: 'seed-audio-1.0',
      costUSD,
      metadata: { seconds, refs: (refUrls && refUrls.length) || 0 },
    }).catch(() => {});
    return { url: audio.url, seconds, costUSD };
  }

  /** Split a long audio script into <=maxLen chunks at paragraph/sentence breaks. */
  splitAudioPrompt(text, maxLen) {
    const parts = [];
    let rest = String(text).trim();
    while (rest.length > maxLen) {
      let cut = rest.lastIndexOf('\n\n', maxLen);
      if (cut < maxLen * 0.5) cut = rest.lastIndexOf('\n', maxLen);
      if (cut < maxLen * 0.5) {
        const seg = rest.slice(0, maxLen);
        cut = Math.max(seg.lastIndexOf('." '), seg.lastIndexOf('. '), seg.lastIndexOf('! '), seg.lastIndexOf('? '));
        cut = cut > maxLen * 0.5 ? cut + 1 : maxLen;
      }
      parts.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) parts.push(rest);
    return parts;
  }

  /**
   * Long text-to-audio prompt -> split into parts and generate each (bounded by
   * MAX_PARTS + a wall-clock deadline), returning all playable links. Parts 2+
   * carry a continuity lead-in so Seed Audio keeps the same voices/mood/bed.
   */
  async generateAudioParts(fullPrompt, data) {
    const MAX_PARTS = 4;
    const chunks = this.splitAudioPrompt(fullPrompt, 1850);
    const planned = Math.min(chunks.length, MAX_PARTS);
    const blocked = await this.checkBudget(0.15 * planned);
    if (blocked) return blocked;
    const CONT =
      '[Continuation of the same audio piece - keep the same voices, mood, pacing, and background sound bed.] ';
    const deadline = Date.now() + 150000;
    const links = [];
    let totalSec = 0;
    let totalCost = 0;
    let made = 0;
    for (let i = 0; i < planned; i++) {
      if (i > 0 && Date.now() > deadline) break;
      const chunk = i === 0 ? chunks[i] : (CONT + chunks[i]).slice(0, 2048);
      let res = null;
      try {
        res = await this._genOneAudio(chunk, data, []);
      } catch (e) {
        logger.warn('[FalAI] audio part failed:', e.message);
      }
      if (!res) {
        if (i === 0) {
          return 'Seed Audio could not generate the first part. Try rewording the opening of the prompt.';
        }
        break;
      }
      made += 1;
      const mm = `${Math.floor(res.seconds / 60)}:${String(res.seconds % 60).padStart(2, '0')}`;
      links.push(`[Play Part ${i + 1}](${res.url}) - ${mm}`);
      totalSec += res.seconds;
      totalCost += res.costUSD;
    }
    const leftover = chunks.length - made;
    const more =
      leftover > 0
        ? ` Your script was long enough for ${chunks.length} parts; I generated the first ${made} - say "continue" for the rest.`
        : '';
    const totalMM = `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`;
    return (
      `Your piece was longer than one 2-minute clip, so I split it into ${made} part${made > 1 ? 's' : ''} and generated ${made > 1 ? 'them all' : 'it'}:\n\n` +
      `${links.join('\n')}\n\n` +
      `Total ~${totalMM}, about $${totalCost.toFixed(2)}. All saved to your gallery at /my-creations - play them in order, or ask me to stitch them into one track.${more}`
    );
  }

  videoPricing(quality, seconds, audio) {
    if (quality === 'premium') return seconds * (audio === false ? 0.10 : 0.15);
    return seconds * (audio ? 0.126 : 0.084);
  }

  /** Shared submit + in-call poll for all queue video jobs. */
  async submitAndPollVideo({ model, body, quality, seconds, audio, estUSD, prompt, modelName, extraMeta, sourceNote }) {
    const notePrefix = sourceNote ? `${sourceNote}\n\n` : '';
    const submit = await axios.post(`https://queue.fal.run/${model}`, body, {
      headers: this.headers(),
      timeout: 30000,
    });
    const requestId = submit.data?.request_id;
    const statusUrl = submit.data?.status_url;
    const responseUrl = submit.data?.response_url;
    if (!requestId) return 'fal.ai did not accept the video job. Try again.';

    this.logUsage('fal_video', seconds, 'seconds', estUSD, {
      model: modelName,
      requestId,
      audio,
      ...(extraMeta || {}),
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
              prompt,
              model: modelName,
              costUSD: estUSD,
              metadata: { requestId, seconds, audio, ...(extraMeta || {}) },
            }).catch(() => {});
            return `${notePrefix}[Watch the video](${url})\n\n${seconds}s ${quality} clip (~$${estUSD}) — it plays right in the chat, and it's saved to your gallery at /my-creations.`;
          }
          return `The video finished but no URL came back. Raw: ${JSON.stringify(out.data).slice(0, 300)}`;
        }
        if (st.data?.status === 'FAILED') {
          const refunded = await this.refundVideoCharge(requestId, 'fal render FAILED');
          return (
            'Video generation failed on fal.ai.' +
            (refunded ? " The estimated charge was removed from the user's tab — no cost." : '') +
            ' Offer to try again or adjust the request.'
          );
        }
      } catch (e) {
        const httpStatus = e?.response?.status;
        const detail = e?.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : '';
        if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
          /* fal validates lazily: the queue ACCEPTS a doomed job, then every
             status poll 4xxes (July 3: file_too_large on a 14.5MB source).
             Bail out honestly instead of pretending it's still rendering. */
          const refunded = await this.refundVideoCharge(requestId, `fal validation error ${httpStatus}`);
          const friendly = /file_too_large/.test(detail)
            ? 'fal rejected the source image as too large (over 10MB).'
            : `fal rejected the job (${httpStatus}): ${detail || e.message}.`;
          return (
            friendly +
            (refunded ? " The estimated charge was removed from the user's tab — no cost." : '') +
            ' Just try the same request again — oversized sources are auto-shrunk now.'
          );
        }
        logger.warn('[FalAI] poll error:', e.message);
      }
    }
    return (
      `${notePrefix}The video is still rendering (request_id: ${requestId}, quality: ${quality}). ` +
      `Estimated cost ~$${estUSD} was logged (auto-refunded if the render fails). ` +
      'IMPORTANT: you cannot post a follow-up message on your own after this turn ends — do NOT promise to "ping" or "check back". ' +
      "End your reply by telling the user the video is cooking and to send any message in about 2 minutes (even just 'ready?'). " +
      'On the user\'s NEXT message, call check_video with this request_id FIRST and deliver the video before anything else.'
    );
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
    const estUSD = Math.round(this.videoPricing(quality, seconds, audio) * 100) / 100;
    const blocked = await this.checkBudget(estUSD);
    if (blocked) return blocked;
    return this.submitAndPollVideo({
      model,
      body,
      quality,
      seconds,
      audio,
      estUSD,
      prompt: data.prompt,
      modelName: quality === 'premium' ? 'veo-3.1-fast' : 'kling-3.0-standard',
    });
  }

  /**
   * animate_image — Kling 3.0 image-to-video. If no image_url is given, the
   * user's most recent generated IMAGE from their gallery is used (the "Lux
   * shoots it, Rio animates it" flow). Stored gallery URLs that are S3-signed
   * get re-signed if stale; site-relative paths are made absolute.
   */
  async resolveSourceImage(imageUrl) {
    let src = imageUrl && String(imageUrl).trim();
    let source = 'explicit-url';
    let label = 'the image URL that was provided';
    if (!src) {
      // 1st choice: an image the user ATTACHED/UPLOADED recently (last hour) —
      // "here's my dog, make him wag" — the model can't quote attachment URLs,
      // so we look them up ourselves.
      try {
        const File = mongoose.models.File;
        if (File) {
          const upload = await File.findOne({
            user: new mongoose.Types.ObjectId(String(this.userId)),
            type: /^image\//,
            context: 'message_attachment',
            /* 24h, not 1h — "the picture I uploaded earlier" (July 3 slinky
               incident: a 2h-old photo silently lost to a gallery fallback). */
            createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          })
            .sort({ createdAt: -1 })
            .lean();
          if (upload?.filepath) {
            src = String(upload.filepath);
            source = 'recent-upload';
            label = upload.filename
              ? `the photo the user uploaded ("${String(upload.filename).slice(0, 60)}")`
              : 'the photo the user uploaded';
          }
        }
      } catch (e) {
        logger.warn('[FalAI] upload lookup failed:', e.message);
      }
    }
    if (!src) {
      // 2nd choice: the user's newest generated image from their gallery.
      const latest = await KadeAsset.findOne({
        user: new mongoose.Types.ObjectId(String(this.userId)),
        kind: 'image',
      })
        .sort({ createdAt: -1 })
        .lean();
      if (!latest?.url) {
        return { error: 'NO_IMAGE' };
      }
      src = String(latest.url);
      source = 'gallery-latest';
      label = latest.description
        ? `the user's newest gallery image ("${String(latest.description).slice(0, 70)}…")`
        : "the user's newest gallery image";
    }
    if (!/^https?:\/\//i.test(src)) {
      const base = (process.env.DOMAIN_SERVER || 'https://kademurdock.com').replace(/\/$/, '');
      src = base + (src.startsWith('/') ? src : '/' + src);
    }
    try {
      const { needsRefresh, getNewS3URL } = require('@librechat/api');
      if (
        typeof needsRefresh === 'function' &&
        typeof getNewS3URL === 'function' &&
        /[?&]X-Amz-/.test(src) &&
        needsRefresh(src, 300)
      ) {
        src = await getNewS3URL(src);
      }
    } catch (e) {
      logger.warn('[FalAI] source image re-sign skipped:', e.message);
    }
    return { src, source, label };
  }

  /**
   * fal validates start images only AFTER the queue accepts the job (July 3
   * slinky incident: a 14.5MB gallery PNG "submitted" fine, then every poll
   * died with file_too_large while the charge stayed logged). Pre-check the
   * size; auto-shrink oversized sources to a <2MB JPEG hosted on our S3.
   */
  async ensureFalSizedImage(src) {
    const FAL_MAX = 10 * 1024 * 1024;
    let tooBig = false;
    try {
      const head = await axios.head(src, { timeout: 12000, maxRedirects: 3 });
      const len = Number(head.headers?.['content-length'] || 0);
      tooBig = len > FAL_MAX * 0.92;
    } catch (e) {
      logger.warn('[FalAI] source size pre-check skipped:', e.message);
      return { src };
    }
    if (!tooBig) return { src };
    try {
      const sharp = require('sharp');
      const { saveBufferToS3 } = require('@librechat/api');
      const img = await axios.get(src, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 80 * 1024 * 1024,
      });
      const buffer = await sharp(Buffer.from(img.data))
        .rotate()
        .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      const url = await saveBufferToS3({
        userId: String(this.userId),
        buffer,
        fileName: `kade-anim-src-${Date.now()}.jpg`,
        basePath: 'images',
      });
      if (url) {
        logger.info('[FalAI] oversized source image auto-shrunk for fal');
        return { src: url, shrunk: true };
      }
    } catch (e) {
      logger.warn('[FalAI] source image shrink failed:', e.message);
    }
    return { error: 'TOO_BIG' };
  }

  /**
   * One-time compensating entry when a logged render never delivered — finds
   * the original charge by request id and mirrors it negative. Idempotent.
   */
  async refundVideoCharge(requestId, reason) {
    try {
      if (!requestId) return false;
      const original = await KadeUsage.findOne({
        user: String(this.userId),
        service: 'fal_video',
        costUSD: { $gt: 0 },
        'metadata.requestId': requestId,
      }).lean();
      if (!original) return false;
      const already = await KadeUsage.findOne({
        user: String(this.userId),
        'metadata.refund_for': requestId,
      }).lean();
      if (already) return true;
      await logKadeUsage({
        userId: this.userId,
        service: 'fal_video',
        quantity: original.quantity || 1,
        unit: original.unit || 'seconds',
        costUSD: -Math.abs(original.costUSD || 0),
        metadata: { refund_for: requestId, reason: String(reason || 'render failed').slice(0, 120) },
      });
      return true;
    } catch (e) {
      logger.warn('[FalAI] refund attempt failed:', e.message);
      return false;
    }
  }

  async animateImage(data) {
    const resolved = await this.resolveSourceImage(data.image_url);
    if (resolved.error === 'NO_IMAGE') {
      return (
        'No image to animate: the user has no generated images in their gallery yet and no image_url was given. ' +
        'Suggest they generate a picture first (or paste a public image URL), then animate it.'
      );
    }
    const sized = await this.ensureFalSizedImage(resolved.src);
    if (sized.error === 'TOO_BIG') {
      return (
        `That source image (${resolved.label}) is over fal's 10MB limit and the automatic shrink failed — ` +
        'nothing was submitted or charged. Ask the user for a smaller image, or generate a fresh one and animate that.'
      );
    }
    const sourceNote =
      `Source: ${resolved.label}${sized.shrunk ? " (auto-shrunk to fit fal's 10MB limit)" : ''}. ` +
      'Tell the user which image is being animated; if it is not the one they meant, have them re-attach it.';
    const seconds = data.duration_seconds === 10 ? 10 : 5;
    const audio = data.audio === true;
    const estUSD = Math.round(this.videoPricing('standard', seconds, audio) * 100) / 100;
    const blocked = await this.checkBudget(estUSD);
    if (blocked) return blocked;
    const body = {
      prompt:
        data.prompt ||
        'Animate this image with natural, lifelike motion true to the scene. Keep the subject and style unchanged.',
      start_image_url: sized.src,
      duration: String(seconds),
      generate_audio: audio,
    };
    return this.submitAndPollVideo({
      model: FAL_MODELS.video_animate,
      body,
      quality: 'standard',
      seconds,
      audio,
      estUSD,
      prompt: data.prompt || 'animated from a still image',
      modelName: 'kling-3.0-i2v',
      sourceNote,
      extraMeta: { sourceImage: resolved.source, shrunk: sized.shrunk === true },
    });
  }

  async checkVideo(data) {
    if (!data.request_id) return 'request_id is required for check_video.';
    const quality = data.quality === 'premium' ? 'premium' : 'standard';
    const alias = QUEUE_ALIAS[`video_${quality}`];
    let st;
    try {
      st = await axios.get(`https://queue.fal.run/${alias}/requests/${data.request_id}/status`, {
        headers: this.headers(),
        timeout: 20000,
      });
    } catch (e) {
      const httpStatus = e?.response?.status;
      const detail = e?.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
      if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
        const refunded = await this.refundVideoCharge(data.request_id, `fal validation error ${httpStatus}`);
        return (
          'That render never made it — fal rejected it (' +
          (/file_too_large/.test(detail) ? 'source image over the 10MB limit' : detail) +
          ').' +
          (refunded ? " The estimated charge was removed from the user's tab — no cost." : '') +
          ' Just re-run the request — oversized sources are auto-shrunk now. Do NOT re-check this request_id.'
        );
      }
      return `Couldn't reach fal to check (${detail}). Try check_video once more in a minute.`;
    }
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
    if (st.data?.status === 'FAILED') {
      const refunded = await this.refundVideoCharge(data.request_id, 'fal render FAILED');
      return (
        'That video generation failed on fal.ai.' +
        (refunded ? " The estimated charge was removed from the user's tab — no cost." : '') +
        ' Offer to try again.'
      );
    }
    return (
      `Still rendering (status: ${st.data?.status || 'IN_PROGRESS'}). ` +
      'Do NOT keep polling in this turn and do NOT promise to check back on your own — ' +
      "tell the user it needs another minute and to send any message ('ready?') so you can fetch it, then call check_video first thing on their next message."
    );
  }
}

module.exports = FalAI;
