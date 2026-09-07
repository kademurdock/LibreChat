import type { ExtendedJsonSchema } from './definitions';

/** Shared by definition-only agent loading and the executing studio tool. */
const AUDIO_VOICES = [
  'vivi_mixed_en_zh_ja_es_id',
  'mindy_en_es_id_pt_zh',
  'kian_en_zh',
  'cedric_en_zh',
  'sophie_en_zh',
  'jean_en_zh',
  'magnus_en_zh',
  'mabel_en_zh',
  'nadia_en_zh',
  'opal_en_zh',
  'pearl_en_zh',
  'quentin_en_zh',
  'corinne_mixed_en_zh',
  'esther_mixed_en_zh',
  'lyla_mixed_en_zh',
  'tracy_es_zh',
  'sandy_es_mixed_en_zh',
  'felix_zh',
  'celeste_zh',
  'monkey_king_zh',
];

export const falStudioSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [
        'generate_image',
        'generate_video',
        'animate_image',
        'check_video',
        'generate_audio',
        'generate_song',
        'generate_narration',
        'check_narration',
      ],
      description:
        "'generate_image' = Seedream 4.5 design/photo image (fast, ~$0.04). 'generate_video' = text-to-video clip. " +
        "'animate_image' = bring a still image to LIFE as a video (Kling image-to-video) — e.g. make a dog photo wag its tail. " +
        "'check_video' = poll a video that wasn't finished when generate_video/animate_image returned. " +
        "'generate_audio' = Seed Audio 1.0 CINEMATIC AUDIO: multi-character dialogue, sound effects, music and ambience in ONE clip (up to ~2 min), plus text-to-speech, voice cloning, and editing existing audio (extend / inpaint / stitch / swap a line) via audio_urls. Returns fast and synchronously with a real audio URL. ~$0.19/minute. " +
        "'generate_song' = full MUSIC with SUNG vocals from a style brief + lyrics. engine 'lyria3_pro' (default) = Google Lyria 3 Pro, up to ~3-min songs; engine 'minimax' = MiniMax Music 2.6. Put the STYLE in prompt, the words to sing in lyrics, things to avoid in negative_prompt, and set instrumental:true for a backing track. Queue job, ~1-2 min. ~$0.08-0.15/song. " +
        "'generate_narration' = SCENEMA AUDIO, our own GPU: ONE actor PERFORMING a script with stage directions — emotion that shifts mid-take, breaths, pauses, a voice designed from words or cloned from one reference clip (audio_urls[0] / use_recent_audio), optional scene sound. Up to 4,000 characters including XML per render; use Sound Booth projects for longer scripts. It is a QUEUED render: use the returned estimate, and expect startup or capacity waits to take several minutes. Check My Creations when ready; notification delivery depends on settings. No music, one voice per request — use generate_audio for scenes with several voices or music. " +
        "'check_narration' = the state and actual wait information for the user's specified job_id, or latest narration if omitted. Check an uncertain start before ordering another render. Missing or failed jobs do not establish final provider charges.",
    },
    prompt: {
      type: 'string',
      description:
        'Detailed prompt. For generate_narration: a single actor script, plain text with voice_description and gender or Scenema <speak> XML with stage directions; at most 4,000 characters including XML. For video: describe shot, subject, motion, mood, camera. For animate_image: describe the MOTION you want (what moves and how). For images: Seedream 4.5 excels at legible TEXT inside images (logos, signs, flyers, memes) — quote any exact wording. For generate_audio: write it like a short audio SCRIPT — [genre + environment + mood], a continuous sound bed, then each line as `Name (voice traits, emotion, pace) says: "dialogue."` with concrete [sound effect] cues; specify the language (English or Chinese). Keep it to ONE clip: under ~1,900 characters (a full 2-minute scene is only ~1,400-2,000 chars). The HARD cap is 2,048 chars / ~2 min per clip; going over makes just the FIRST clip unless the user explicitly wants a multi-minute piece (then set long_form:true).',
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
      description:
        'Video length in seconds. Standard/animate: 5 or 10 (default 5). Premium: 4, 6, or 8 (default 8).',
    },
    audio: {
      type: 'boolean',
      description:
        "generate_video and animate_image: generate native audio/sound. SOUND MATTERS on this platform (blind users experience videos through it) — if the user hasn't said, ASK once: with sound (standard 5s ≈ $0.63) or silent (cheapest, 5s ≈ $0.42)? Defaults: false for standard/animate, true for premium.",
    },
    aspect_ratio: {
      type: 'string',
      enum: ['16:9', '9:16', '1:1'],
      description:
        'Aspect ratio (default 16:9). Use 9:16 for phone-style vertical video. Ignored for animate_image (follows the source image).',
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
        "generate_narration: one voice reference clip in audio_urls[0]. generate_audio: up to 3 reference audio clip URLs (≤30s each), referenced in the prompt as @Audio1/@Audio2/@Audio3. This is how you CLONE a voice, EXTEND / EDIT / INPAINT an existing clip, or STITCH two clips together. Accepts public https URLs or the user's own gallery/upload URLs.",
    },
    use_recent_audio: {
      type: 'boolean',
      description:
        "generate_audio or generate_narration: set true when the user says 'extend/continue/edit/redo MY last clip' (or similar) and gives no URL — auto-loads their most recent uploaded or generated clip as @Audio1. Leave false/absent for brand-new scenes.",
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
    long_form: {
      type: 'boolean',
      description:
        'generate_audio only: leave FALSE by default. Seed Audio caps at ~2 min / 2,048 chars per clip, so a longer script normally makes JUST the first 2-minute clip and offers to continue. Set TRUE only when the user explicitly asks for a full multi-minute piece (audiobook chapter, long podcast) — then every part generates at once (up to 4). Do NOT set it just because a script is a little long; keep scenes to one clip.',
    },
    audio_quality: {
      type: 'string',
      enum: ['standard', 'high'],
      description:
        "generate_audio only: 'standard' (default) = 24kHz MP3, small + perfect for speech. 'high' = 48kHz lossless WAV (studio fidelity, bigger file, SAME price — Seed Audio bills by length, not quality). Use 'high' when the user asks for high/studio/lossless quality or wants a master to keep.",
    },
    volume: {
      type: 'number',
      description: 'generate_audio only: output loudness, 0.5-2.0 (default 1).',
    },
    engine: {
      type: 'string',
      enum: ['lyria3_pro', 'minimax'],
      description:
        "generate_song only: which music engine. 'lyria3_pro' (default) = Google Lyria 3 Pro — up to ~3-minute full songs with sung vocals + timed lyrics, richest quality (~$0.08). 'minimax' = MiniMax Music 2.6 — separate style + lyrics fields with clean [Verse]/[Chorus] structure control (~$0.15).",
    },
    lyrics: {
      type: 'string',
      description:
        'generate_song only: the actual words to be SUNG, with structure tags like [Verse]/[Chorus]/[Bridge] and newlines between lines. Paste the Lyrics Box straight from the Lyric agent. Omit for an instrumental, or to let the engine write its own words.',
    },
    negative_prompt: {
      type: 'string',
      description:
        "generate_song only (Lyria 3 Pro engine): what to keep OUT of the track — e.g. 'harsh distortion, muddy mix, spoken word'. Maps to the Lyric agent's Negative Tag Box. Ignored by the minimax engine.",
    },
    instrumental: {
      type: 'boolean',
      description:
        'generate_song only: set true for a vocal-free instrumental/backing track (no lyrics sung).',
    },
    request_id: {
      type: 'string',
      description: 'check_video only: the request id returned by generate_video/animate_image.',
    },
    voice_description: {
      type: 'string',
      description:
        "generate_narration only: the actor, in words, specific and theatrical — 'Woman, late 50s, low and warm, Black American, tired but kind, the voice of someone who has told this story before.' Drives everything: age, texture, accent, delivery. Ignored if prompt already is <speak> XML.",
    },
    gender: {
      type: 'string',
      enum: ['female', 'male'],
      description: 'generate_narration only: the speaker. Required unless prompt is <speak> XML.',
    },
    scene: {
      type: 'string',
      description:
        "generate_narration only: optional environment for scene sound ('rain on a tin roof, night'). Only audible with shot 'wide' or 'scene'.",
    },
    shot: {
      type: 'string',
      enum: ['closeup', 'wide', 'scene'],
      description:
        'generate_narration only: closeup = voice only (default); wide = voice + environment; scene = environment loud, <sound> cues honoured.',
    },
    seed: {
      type: 'integer',
      description: 'generate_narration only: fixed seed for a repeatable take.',
    },
    job_id: {
      type: 'string',
      description: 'check_narration only: a specific narration job id (omit for the latest).',
    },
  },
  required: ['action'],
};

export const falNarrationInstructions =
  'NARRATION (generate_narration, Scenema Audio on Kade\'s own GPU — Part 119.9): ONE actor performing a script. Write the script as Scenema XML in prompt: <speak voice="DETAILED VOICE" gender="female|male" scene="optional environment" shot="closeup|wide|scene"> then the words, with <action>stage direction</action> BETWEEN sentences to change the delivery (\'Voice tightens. Swallows. Fighting to stay composed.\') and <sound>thunder cracks</sound> for scene cues. Directions describe what the speaker is DOING and FEELING, never how the audio should sound; the same feelings you would put in a %%%tag%%% go in <action>. Or pass plain text in prompt plus voice_description + gender and the tool wraps it. To CLONE a voice pass one reference clip in audio_urls (10-20 s with some emotional range) or use_recent_audio:true. It is a QUEUED job: retain the returned job id and use its estimate. Startup and capacity waits can take several minutes. On the user\'s next message call check_narration with that job_id FIRST and relay its actual wait information. Tell them to check My Creations; notification delivery depends on their settings. Do not promise a later message yourself. A lost start response may already have queued the job: check status before another render. Missing or failed jobs do not prove zero charges. Each render is capped at 4,000 characters INCLUDING XML; use Sound Booth projects for longer scripts. One render per person at a time; daily and monthly Scenema budgets apply. ';
