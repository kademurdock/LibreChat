import { WebSearchToolDefinition, CalculatorToolDefinition } from '@librechat/agents';
import { geminiToolkit } from '~/tools/toolkits/gemini';
import { oaiToolkit } from '~/tools/toolkits/oai';

/** Extended JSON Schema type that includes standard validation keywords */
export type ExtendedJsonSchema = {
  type?: 'string' | 'number' | 'integer' | 'float' | 'boolean' | 'array' | 'object' | 'null';
  enum?: (string | number | boolean | null)[];
  items?: ExtendedJsonSchema;
  properties?: Record<string, ExtendedJsonSchema>;
  required?: string[];
  description?: string;
  additionalProperties?: boolean | ExtendedJsonSchema;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  format?: string;
  default?: unknown;
  const?: unknown;
  oneOf?: ExtendedJsonSchema[];
  anyOf?: ExtendedJsonSchema[];
  allOf?: ExtendedJsonSchema[];
  $ref?: string;
  $defs?: Record<string, ExtendedJsonSchema>;
  definitions?: Record<string, ExtendedJsonSchema>;
};

export interface ToolRegistryDefinition {
  name: string;
  description: string;
  schema: ExtendedJsonSchema;
  description_for_model?: string;
  responseFormat?: 'content_and_artifact' | 'content';
  toolType: 'builtin' | 'mcp' | 'action' | 'custom';
}

/** Google Search tool JSON schema */
export const googleSearchSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      description: 'The search query string.',
    },
    max_results: {
      type: 'integer',
      minimum: 1,
      maximum: 10,
      description: 'The maximum number of search results to return. Defaults to 5.',
    },
  },
  required: ['query'],
};

/** DALL-E 3 tool JSON schema */
export const dalle3Schema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      maxLength: 4000,
      description:
        'A text description of the desired image, following the rules, up to 4000 characters.',
    },
    style: {
      type: 'string',
      enum: ['vivid', 'natural'],
      description:
        'Must be one of `vivid` or `natural`. `vivid` generates hyper-real and dramatic images, `natural` produces more natural, less hyper-real looking images',
    },
    quality: {
      type: 'string',
      enum: ['hd', 'standard'],
      description: 'The quality of the generated image. Only `hd` and `standard` are supported.',
    },
    size: {
      type: 'string',
      enum: ['1024x1024', '1792x1024', '1024x1792'],
      description:
        'The size of the requested image. Use 1024x1024 (square) as the default, 1792x1024 if the user requests a wide image, and 1024x1792 for full-body portraits. Always include this parameter in the request.',
    },
  },
  required: ['prompt', 'style', 'quality', 'size'],
};

/** Flux API tool JSON schema */

export const falStudioSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['generate_image', 'generate_video', 'animate_image', 'check_video', 'generate_audio'],
      description:
        "'generate_image' = Seedream 4.5 design/photo image (fast, ~$0.04). 'generate_video' = text-to-video clip. 'animate_image' = bring a still image to LIFE as video (Kling image-to-video) — e.g. make a dog photo wag its tail. 'check_video' = poll a video that wasn't finished when generate_video/animate_image returned. 'generate_audio' = Seed Audio 1.0 cinematic audio (dialogue + sound effects + music + ambience in one ~2-min clip), plus TTS, voice cloning, and editing existing audio (extend/inpaint/stitch/swap a line) via audio_urls. Synchronous; ~$0.075/minute.",
    },
    prompt: {
      type: 'string',
      description:
        'Detailed prompt. For video: describe shot, subject, motion, mood, camera. For animate_image: describe the MOTION wanted. For images: Seedream 4.5 excels at legible TEXT inside images (logos, signs, flyers, memes) — quote any exact wording. For generate_audio: write a short audio SCRIPT — [genre + environment + mood], a continuous sound bed, then each line as Name (voice traits, emotion, pace) says: dialogue, with [sound effect] cues; name the language (English or Chinese); max 2,048 characters.',
    },
    image_url: {
      type: 'string',
      description:
        "animate_image: URL of the still image to animate. OMIT IT to auto-pick: a photo the user attached/uploaded in the last 24 hours wins, otherwise their most recent generated image from the gallery. Any public https image URL also works. The tool's reply NAMES which image it used — relay that to the user. Oversized sources (>10MB) are auto-shrunk. generate_audio: optional single reference image to generate a matching audio scene (cannot be combined with audio_urls).",
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
      enum: [
        'vivi_mixed_en_zh_ja_es_id', 'mindy_en_es_id_pt_zh', 'kian_en_zh', 'cedric_en_zh',
        'sophie_en_zh', 'jean_en_zh', 'magnus_en_zh', 'mabel_en_zh', 'nadia_en_zh',
        'opal_en_zh', 'pearl_en_zh', 'quentin_en_zh', 'corinne_mixed_en_zh',
        'esther_mixed_en_zh', 'lyla_mixed_en_zh', 'tracy_es_zh', 'sandy_es_mixed_en_zh',
        'felix_zh', 'celeste_zh', 'monkey_king_zh',
      ],
      description:
        'generate_audio only: optional preset voice. Omit to let the prompt describe the voice, or when using audio_urls (a reference clip overrides any preset).',
    },
    audio_urls: {
      type: 'array',
      items: { type: 'string' },
      description:
        "generate_audio only: up to 3 reference audio clip URLs (≤30s each), referenced in the prompt as @Audio1/@Audio2/@Audio3 — how you CLONE a voice, EXTEND/EDIT/INPAINT a clip, or STITCH two clips. Public https URLs or the user's own gallery/upload URLs.",
    },
    use_recent_audio: {
      type: 'boolean',
      description:
        "generate_audio only: set true when the user says 'extend/edit/redo MY last clip' with no URL — auto-loads their most recent uploaded or generated clip as @Audio1. Leave false for brand-new scenes.",
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
      description: 'check_video only: the request id returned by generate_video/animate_image.',
    },
  },
  required: ['action'],
};

export const kadeWeatherSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    location: {
      type: 'string',
      description: "City or place name, optionally with region (e.g. 'Ozark, Missouri').",
    },
    days: {
      type: 'integer',
      description: 'Forecast days to include (1-7). Default 3.',
    },
  },
  required: ['location'],
};

export const kadeWikipediaSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: "Topic to look up (e.g. 'Ozarks', 'photosynthesis').",
    },
    full_intro: {
      type: 'boolean',
      description: 'true = longer introduction section instead of the one-paragraph summary.',
    },
  },
  required: ['query'],
};

export const kadeFeedbackSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    category: {
      type: 'string',
      description:
        "What kind of report: 'bug' (something broken), 'feature' (something the user wishes existed), or 'feedback' (a general thought or suggestion). Default 'feedback'.",
    },
    subject: {
      type: 'string',
      description: "A short title, 3-10 words, summarizing the user's report.",
    },
    detail: {
      type: 'string',
      description:
        "The full description in the user's own words — what they were doing, what happened, and any details they gave (which page, which agent, what device). This goes straight to Kade.",
    },
  },
  required: ['detail'],
};

export const kadeJokeSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    category: {
      type: 'string',
      description:
        "Optional category: 'Programming', 'Misc', 'Pun', 'Spooky', 'Christmas', or 'Any' (default).",
    },
    search: {
      type: 'string',
      description: 'Optional word the joke should contain (e.g. "cat").',
    },
    dirty: {
      type: 'boolean',
      description:
        'true = adult/uncensored jokes (safe-mode off). ONLY for explicitly adult/uncensored personas with adult users; family-friendly and kid-facing personas must NEVER set this. Default false = clean.',
    },
  },
  required: [],
};

export const kadePhoneCallSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['place_call', 'check_result'],
      description:
        "'place_call' (default) dials a number. 'check_result' fetches the status and transcript of the user's most recent call (or a specific call_sid) so you can report back what was said.",
    },
    to_number: {
      type: 'string',
      description:
        "Required for place_call. US/Canada phone number, 10 digits (e.g. '4175551234'). ALWAYS confirm the exact number with the user before calling.",
    },
    purpose: {
      type: 'string',
      description:
        'Required for place_call. Short plain-language reason for the call, phrased to complete the sentence "I\'m calling because ..." — it is read aloud to whoever answers and guides the whole call. Make it specific; include any facts the phone agent needs (names, order numbers, questions to ask).',
    },
    callee_name: {
      type: 'string',
      description:
        "ONLY set this if you genuinely know the name of the person or business being called (e.g. \"Tony's Pizza\"). NEVER placeholders like 'whoever answers' — omit instead.",
    },
    call_sid: {
      type: 'string',
      description: 'Optional, for check_result: a specific call SID. Omit for the most recent call.',
    },
  },
  required: [],
};

export const kadeNewsSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    categories: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['national', 'world', 'local', 'tech', 'entertainment', 'music', 'sports'],
      },
      description:
        "Which news categories to include. 'local' = Springfield MO / Ozarks. Default ['national', 'local']. Use the user's remembered preferences when they have some.",
    },
    items_per_category: {
      type: 'integer',
      description: 'Headlines per category, 1-8. Default 4.',
    },
    feed_url: {
      type: 'string',
      description:
        'Optional: a specific RSS/Atom feed URL to read INSTEAD of the categories. Remember feeds a user asks for repeatedly.',
    },
  },
  required: [],
};

export const kadeReadPageSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      description: 'Full http(s) URL of the page to read.',
    },
    max_chars: {
      type: 'integer',
      description: 'Cap on returned text length (2000-40000). Default 12000.',
    },
  },
  required: ['url'],
};

export const kadeAdventureSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['save', 'load', 'list', 'delete'],
      description:
        "'save' writes the current game to a named slot, 'load' restores a slot, 'list' shows the user's save files, 'delete' removes one.",
    },
    slot: {
      type: 'string',
      description: "Save file name, e.g. 'dragon quest'. Required for save/load/delete.",
    },
    game_title: {
      type: 'string',
      description: "For save: the adventure's title.",
    },
    scene: {
      type: 'string',
      description: 'For save: ONE short line describing where the player is right now (shown in the save list).',
    },
    state: {
      type: 'string',
      description:
        'For save: the COMPLETE game state needed to resume cold — story summary, location/chapter, character sheet, inventory, gold, quests, key NPCs, choices made, unresolved threads.',
    },
    turns: {
      type: 'integer',
      description: 'For save: rough number of turns played so far (optional).',
    },
  },
  required: ['action'],
};

export const kadeGamesSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list_games', 'new_game', 'state', 'move', 'games', 'quit'],
      description:
        "'list_games' shows the menu; 'new_game' deals a fresh game; 'state' re-shows the table; 'move' plays ONE turn; 'games' lists saved tables; 'quit' ends a table.",
    },
    game: {
      type: 'string',
      description:
        "For new_game: cards — 'blackjack', 'wild_eights', 'uno', 'go_fish', 'war', 'in_between'; party — 'cards_against_reality', 'crab_apples', 'madlibs', 'sound_guess'; dice — 'pig', 'farkle', 'liars_dice'; words — 'trivia', 'hangman', 'scramble'; grids — 'battleship', 'tictactoe'; quick — 'rps'.",
    },
    move: {
      type: 'string',
      description:
        'For move: the EXACT move token from the LEGAL MOVES list the engine just gave you (e.g. "hit", "play_KH", "ask_1_Q"). Never invent a token.',
    },
    opponents: {
      type: 'integer',
      description: 'AI opponents where supported: card/dice games 1-3; trivia/sound_guess 0-3 rivals; cards_against_reality/crab_apples 2-3 (judge games need a table).',
    },
    bet: {
      type: 'integer',
      description: 'For new_game (blackjack): fake-chip wager 1-500, default 10. Never real money.',
    },
    rounds: {
      type: 'integer',
      description: 'Length knob: trivia questions 3-15; sound_guess/scramble rounds 3-10; cards_against_reality/crab_apples points to win 3-10; rps best-of 3-9; farkle target in thousands 2-10.',
    },
    difficulty: {
      type: 'string',
      description: "For new_game (trivia): 'easy', 'medium', or 'hard'. Omit for a mix.",
    },
    category: {
      type: 'string',
      description: 'Optional topic — trivia (general, film, music, science, sports, history, animals, and more) or hangman (animals, food, around_the_house, places, music, games_and_fun).',
    },
    clean: {
      type: 'boolean',
      description: 'For cards_against_reality: true = family-clean deck. Adults default spicy; child accounts are always clean automatically (never mention it).',
    },
    names: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional names for the AI opponents so the engine log reads in their voice.',
    },
    game_id: {
      type: 'string',
      description: 'Optional short table id to act on a specific game; defaults to the most recent active table.',
    },
  },
  required: ['action'],
};

export const fluxApiSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['generate', 'list_finetunes', 'generate_finetuned'],
      description:
        'Action to perform: "generate" for image generation, "generate_finetuned" for finetuned model generation, "list_finetunes" to get available custom models',
    },
    prompt: {
      type: 'string',
      description:
        'Text prompt for image generation. Required when action is "generate". Not used for list_finetunes.',
    },
    width: {
      type: 'number',
      description:
        'Width of the generated image in pixels. Must be a multiple of 32. Default is 1024.',
    },
    height: {
      type: 'number',
      description:
        'Height of the generated image in pixels. Must be a multiple of 32. Default is 768.',
    },
    prompt_upsampling: {
      type: 'boolean',
      description: 'Whether to perform upsampling on the prompt.',
    },
    steps: {
      type: 'integer',
      description: 'Number of steps to run the model for, a number from 1 to 50. Default is 40.',
    },
    seed: {
      type: 'number',
      description: 'Optional seed for reproducibility.',
    },
    safety_tolerance: {
      type: 'number',
      description:
        'Tolerance level for input and output moderation. Between 0 and 6, 0 being most strict, 6 being least strict.',
    },
    endpoint: {
      type: 'string',
      enum: [
        '/v1/flux-pro-1.1',
        '/v1/flux-pro',
        '/v1/flux-dev',
        '/v1/flux-pro-1.1-ultra',
        '/v1/flux-pro-finetuned',
        '/v1/flux-pro-1.1-ultra-finetuned',
      ],
      description: 'Endpoint to use for image generation.',
    },
    raw: {
      type: 'boolean',
      description:
        'Generate less processed, more natural-looking images. Only works for /v1/flux-pro-1.1-ultra.',
    },
    finetune_id: {
      type: 'string',
      description: 'ID of the finetuned model to use',
    },
    finetune_strength: {
      type: 'number',
      description: 'Strength of the finetuning effect (typically between 0.1 and 1.2)',
    },
    guidance: {
      type: 'number',
      description: 'Guidance scale for finetuned models',
    },
    aspect_ratio: {
      type: 'string',
      description: 'Aspect ratio for ultra models (e.g., "16:9")',
    },
  },
  required: [],
};

/** OpenWeather tool JSON schema */
export const openWeatherSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['help', 'current_forecast', 'timestamp', 'daily_aggregation', 'overview'],
      description: 'The action to perform',
    },
    city: {
      type: 'string',
      description: 'City name for geocoding if lat/lon not provided',
    },
    lat: {
      type: 'number',
      description: 'Latitude coordinate',
    },
    lon: {
      type: 'number',
      description: 'Longitude coordinate',
    },
    exclude: {
      type: 'string',
      description: 'Parts to exclude from the response',
    },
    units: {
      type: 'string',
      enum: ['Celsius', 'Kelvin', 'Fahrenheit'],
      description: 'Temperature units',
    },
    lang: {
      type: 'string',
      description: 'Language code',
    },
    date: {
      type: 'string',
      description: 'Date in YYYY-MM-DD format for timestamp and daily_aggregation',
    },
    tz: {
      type: 'string',
      description: 'Timezone',
    },
  },
  required: ['action'],
};

/** Wolfram Alpha tool JSON schema */
export const wolframSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    input: {
      type: 'string',
      description: 'Natural language query to WolframAlpha following the guidelines',
    },
  },
  required: ['input'],
};

/** Stable Diffusion tool JSON schema */
export const stableDiffusionSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description:
        'Detailed keywords to describe the subject, using at least 7 keywords to accurately describe the image, separated by comma',
    },
    negative_prompt: {
      type: 'string',
      description:
        'Keywords we want to exclude from the final image, using at least 7 keywords to accurately describe the image, separated by comma',
    },
  },
  required: ['prompt', 'negative_prompt'],
};

/** Azure AI Search tool JSON schema */
export const azureAISearchSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Search word or phrase to Azure AI Search',
    },
  },
  required: ['query'],
};

/** Traversaal Search tool JSON schema */
export const traversaalSearchSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        "A properly written sentence to be interpreted by an AI to search the web according to the user's request.",
    },
  },
  required: ['query'],
};

/** Tavily Search Results tool JSON schema */
export const tavilySearchSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      description: 'The search query string.',
    },
    max_results: {
      type: 'number',
      minimum: 1,
      maximum: 10,
      description: 'The maximum number of search results to return. Defaults to 5.',
    },
    search_depth: {
      type: 'string',
      enum: ['basic', 'advanced'],
      description:
        'The depth of the search, affecting result quality and response time (`basic` or `advanced`). Default is basic for quick results and advanced for indepth high quality results but longer response time. Advanced calls equals 2 requests.',
    },
    include_images: {
      type: 'boolean',
      description:
        'Whether to include a list of query-related images in the response. Default is False.',
    },
    include_answer: {
      type: 'boolean',
      description: 'Whether to include answers in the search results. Default is False.',
    },
    include_raw_content: {
      type: 'boolean',
      description: 'Whether to include raw content in the search results. Default is False.',
    },
    include_domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'A list of domains to specifically include in the search results.',
    },
    exclude_domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'A list of domains to specifically exclude from the search results.',
    },
    topic: {
      type: 'string',
      enum: ['general', 'news', 'finance'],
      description:
        'The category of the search. Use news ONLY if query SPECIFCALLY mentions the word "news".',
    },
    time_range: {
      type: 'string',
      enum: ['day', 'week', 'month', 'year', 'd', 'w', 'm', 'y'],
      description: 'The time range back from the current date to filter results.',
    },
    days: {
      type: 'number',
      minimum: 1,
      description: 'Number of days back from the current date to include. Only if topic is news.',
    },
    include_image_descriptions: {
      type: 'boolean',
      description:
        'When include_images is true, also add a descriptive text for each image. Default is false.',
    },
  },
  required: ['query'],
};

/** File Search tool JSON schema */
export const fileSearchSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        "A natural language query to search for relevant information in the files. Be specific and use keywords related to the information you're looking for. The query will be used for semantic similarity matching against the file contents.",
    },
  },
  required: ['query'],
};

/** Tool definitions registry - maps tool names to their definitions */
export const toolDefinitions: Record<string, ToolRegistryDefinition> = {
  google: {
    name: 'google',
    description:
      'A search engine optimized for comprehensive, accurate, and trusted results. Useful for when you need to answer questions about current events.',
    schema: googleSearchSchema,
    toolType: 'builtin',
  },
  dalle: {
    name: 'dalle',
    description: `Use DALLE to create images from text descriptions.
    - It requires prompts to be in English, detailed, and to specify image type and human features for diversity.
    - Create only one image, without repeating or listing descriptions outside the "prompts" field.
    - Maintains the original intent of the description, with parameters for image style, quality, and size to tailor the output.`,
    schema: dalle3Schema,
    toolType: 'builtin',
  },
  flux: {
    name: 'flux',
    description:
      'Use Flux to generate images from text descriptions. This tool can generate images and list available finetunes. Each generate call creates one image. For multiple images, make multiple consecutive calls.',
    schema: fluxApiSchema,
    toolType: 'builtin',
  },
  fal_studio: {
    name: 'fal_studio',
    description:
      "Generate short AI VIDEOS (Kling 3.0 standard / Veo 3.1 Fast premium), ANIMATE still images into video (image-to-video — e.g. make a dog photo wag its tail; with no image_url it animates the photo the user uploaded in the last 24 hours, or else their most recent generated image — its reply names WHICH image it used, relay that; animations are always Kling standard, never promise premium/Veo for them), and make best-in-class design IMAGES with legible text (Seedream 4.5) via fal.ai. Video costs real money per second (~$0.42-1.30 per clip) and takes 1-4 minutes; images cost ~$0.04 and are fast. Each user has a monthly video budget (~$5) the tool enforces — if it says the budget is hit, relay that warmly and offer a picture instead. Failed renders auto-refund the logged charge — if the tool says a job failed or was rejected, tell the user there was NO cost and simply retry or adjust. For video: state the rough cost and get the user's yes BEFORE generating; if they haven't said, ask ONCE whether they want sound (recommended — blind users experience video through audio; ~$0.63 vs $0.42 per standard 5s) and only use premium when the user picks it; if generate_video or animate_image returns a request_id instead of a URL, you CANNOT come back on your own (agents can't send unprompted messages) — never say 'I'll ping you'; end your reply asking the user to send any message in ~2 minutes, then call check_video FIRST on their next message and deliver it. Always show returned media as markdown: images as ![desc](url), videos as [Watch the video](url), audio as [Play the audio](url). generate_audio (Seed Audio 1.0) makes cinematic audio — dialogue + sound effects + music + ambience in one ~2-min clip — plus TTS, voice cloning, and editing existing clips; it returns fast and synchronously (no request_id, no check step), is cheap (~$0.075/min), rides the same monthly fal budget, and auto-saves to the gallery with a blind-friendly description. Enhance thin prompts into rich descriptions first. NEVER claim media was generated without a real URL returned by this tool.",
    schema: falStudioSchema,
    toolType: 'builtin',
  },
  kade_phone_call: {
    name: 'kade_phone_call',
    description:
      "Place a REAL outbound phone call from the Kade-AI phone line (+1 833-530-0313) to a person or business, on behalf of the current user — and afterwards fetch the transcript with ONE action='check_result' call — it waits for the call to finish (up to ~1 min) and returns the transcript. Never call check_result more than once per turn; never dial the same call twice. Costs real money (~1.5 cents/minute, billed to the user's tab), hard-capped at 15 minutes and 10 calls per user per day. ONLY call when the user explicitly asks, ALWAYS confirm the exact number and reason first. When confirming, also tell the user casually that the call will identify them by first name as the requester and that its cost is added to their Feed the Server page. Never call emergency services, never harass anyone, never redial the same number repeatedly. If the user asked you to find something out, checking the result and reporting back IS part of the job. NEVER claim a call was placed or invent a call result — only report what this tool actually returned.",
    schema: kadePhoneCallSchema,
    toolType: 'builtin',
  },
  kade_weather: {
    name: 'kade_weather',
    description:
      'Get REAL current weather and a short forecast for any city — free, instant, no cost (Open-Meteo). Use this instead of web_search for weather questions. NEVER invent weather; only report what this tool returns.',
    schema: kadeWeatherSchema,
    toolType: 'builtin',
  },
  kade_joke: {
    name: 'kade_joke',
    description:
      'Fetch a fresh joke from a live joke database — free, instant, no cost. Use when the user wants humor; keeps you from repeating your own material. Default mode is clean/family-safe. dirty=true unlocks adult humor and is ONLY for explicitly adult/uncensored personas with adult users — kid-friendly personas never set it. Deliver it naturally in your own voice. NEVER invent a joke and claim it came from this tool.',
    schema: kadeJokeSchema,
    toolType: 'builtin',
  },
  kade_news: {
    name: 'kade_news',
    description:
      "Get REAL current news headlines from free RSS feeds — no key, no cost. Categories: national, world, local (Springfield MO / Ozarks), tech, entertainment, music, sports — or any custom feed_url. Use for 'what's the news' and morning briefings. When a user tells you which categories or feeds they like, SAVE that preference to memory and use it next time without asking. Read results conversationally (often listened to, not read). NEVER invent news; only report what this tool returns.",
    schema: kadeNewsSchema,
    toolType: 'builtin',
  },
  kade_read_page: {
    name: 'kade_read_page',
    description:
      'Fetch a webpage and return ONLY its readable content — article text with ads, menus, pop-ups, and link clutter stripped out. Free, no key, no cost. Use whenever a user shares a link they want read aloud, summarized, or discussed. Many users listen by voice or screen reader — present the content cleanly, in reading order. Use the ACTUAL returned text; never guess what a page says.',
    schema: kadeReadPageSchema,
    toolType: 'builtin',
  },
  kade_adventure: {
    name: 'kade_adventure',
    description:
      "REAL persistent save files for text-adventure and RPG games — free, no cost. Saves live on the server per USER and can be loaded in any future conversation. Offer to save at natural stopping points and before risky moments. On load, resume faithfully from the returned state — never restart or contradict it. Use action='list' first when you don't know the user's slot names.",
    schema: kadeAdventureSchema,
    toolType: 'builtin',
  },
  kade_games: {
    name: 'kade_games',
    description:
      "Server-refereed voice games, 19 strong — Blackjack, Wild Eights, Uno, War, Go Fish, In-Between, Cards Against Reality (fill-in-the-blank judge game), Crab Apples, Fill-In Stories, Guess the Sound, Pig, Farkle, Liar's Dice, Trivia Night, Hangman, Word Scramble, Battleship, Tic-Tac-Toe, Rock Paper Scissors — free, no cost. The engine deals and enforces every rule; you only relay the table and play the move the human picks from the LEGAL MOVES list. NEVER invent cards, totals, or outcomes. Games save per user and resume in any later conversation.",
    schema: kadeGamesSchema,
    toolType: 'builtin',
  },
  kade_wikipedia: {
    name: 'kade_wikipedia',
    description:
      'Look up a topic on Wikipedia — free, instant, no cost. Best for stable encyclopedic facts (people, places, history, science). For breaking news or local/current info use web_search instead. NEVER invent article content; only report what this tool returns.',
    schema: kadeWikipediaSchema,
    toolType: 'builtin',
  },
  kade_feedback: {
    name: 'kade_feedback',
    description:
      "File a bug report, feature request, or feedback to Kade (the platform owner) on behalf of the user — free, instant, no cost. Use when a user mentions something broken or frustrating, or wishes a feature existed: OFFER first (\"Want me to send that to Kade for you?\"), then call this with their description. Attributed to the user so Kade can follow up. NEVER file without the user's OK; NEVER invent details they didn't give.",
    schema: kadeFeedbackSchema,
    toolType: 'builtin',
  },
  open_weather: {
    name: 'open_weather',
    description:
      'Provides weather data from OpenWeather One Call API 3.0. Actions: help, current_forecast, timestamp, daily_aggregation, overview. If lat/lon not provided, specify "city" for geocoding. Units: "Celsius", "Kelvin", or "Fahrenheit" (default: Celsius). For timestamp action, use "date" in YYYY-MM-DD format.',
    schema: openWeatherSchema,
    toolType: 'builtin',
  },
  wolfram: {
    name: 'wolfram',
    description:
      'WolframAlpha offers computation, math, curated knowledge, and real-time data. It handles natural language queries and performs complex calculations. Follow the guidelines to get the best results.',
    schema: wolframSchema,
    toolType: 'builtin',
  },
  'stable-diffusion': {
    name: 'stable-diffusion',
    description:
      "You can generate images using text with 'stable-diffusion'. This tool is exclusively for visual content.",
    schema: stableDiffusionSchema,
    toolType: 'builtin',
  },
  'azure-ai-search': {
    name: 'azure-ai-search',
    description: "Use the 'azure-ai-search' tool to retrieve search results relevant to your input",
    schema: azureAISearchSchema,
    toolType: 'builtin',
  },
  traversaal_search: {
    name: 'traversaal_search',
    description:
      'An AI search engine optimized for comprehensive, accurate, and trusted results. Useful for when you need to answer questions about current events. Input should be a search query.',
    schema: traversaalSearchSchema,
    toolType: 'builtin',
  },
  tavily_search_results_json: {
    name: 'tavily_search_results_json',
    description:
      'A search engine optimized for comprehensive, accurate, and trusted results. Useful for when you need to answer questions about current events.',
    schema: tavilySearchSchema,
    toolType: 'builtin',
  },
  file_search: {
    name: 'file_search',
    description:
      'Performs semantic search across attached "file_search" documents using natural language queries. This tool analyzes the content of uploaded files to find relevant information, quotes, and passages that best match your query.',
    schema: fileSearchSchema,
    toolType: 'builtin',
    responseFormat: 'content_and_artifact',
  },
  image_gen_oai: {
    name: oaiToolkit.image_gen_oai.name,
    description: oaiToolkit.image_gen_oai.description,
    schema: oaiToolkit.image_gen_oai.schema,
    toolType: 'builtin',
    responseFormat: oaiToolkit.image_gen_oai.responseFormat,
  },
  image_edit_oai: {
    name: oaiToolkit.image_edit_oai.name,
    description: oaiToolkit.image_edit_oai.description,
    schema: oaiToolkit.image_edit_oai.schema,
    toolType: 'builtin',
    responseFormat: oaiToolkit.image_edit_oai.responseFormat,
  },
  gemini_image_gen: {
    name: geminiToolkit.gemini_image_gen.name,
    description: geminiToolkit.gemini_image_gen.description,
    schema: geminiToolkit.gemini_image_gen.schema,
    toolType: 'builtin',
    responseFormat: geminiToolkit.gemini_image_gen.responseFormat,
  },
};

/**
 * Tool definitions from @librechat/agents.
 *
 * `CodeExecutionToolDefinition` (the legacy `execute_code` tool) is
 * intentionally absent — the `execute_code` capability now expands into
 * the skill-flavored `bash_tool` + `read_file` pair, registered at
 * initialize-time by `registerCodeExecutionTools`. Agents whose `tools`
 * array contains the literal string `execute_code` continue to work:
 * the capability gate still filters on that string, and the runtime
 * registers the tool pair on match.
 */
const agentToolDefinitions: Record<string, ToolRegistryDefinition> = {
  [CalculatorToolDefinition.name]: {
    name: CalculatorToolDefinition.name,
    description: CalculatorToolDefinition.description,
    schema: CalculatorToolDefinition.schema as unknown as ExtendedJsonSchema,
    toolType: 'builtin',
  },
  [WebSearchToolDefinition.name]: {
    name: WebSearchToolDefinition.name,
    description: WebSearchToolDefinition.description,
    schema: WebSearchToolDefinition.schema as unknown as ExtendedJsonSchema,
    toolType: 'builtin',
  },
};

export function getToolDefinition(toolName: string): ToolRegistryDefinition | undefined {
  return toolDefinitions[toolName] ?? agentToolDefinitions[toolName];
}

export function getAllToolDefinitions(): ToolRegistryDefinition[] {
  return [...Object.values(toolDefinitions), ...Object.values(agentToolDefinitions)];
}

export function getToolSchema(toolName: string): ExtendedJsonSchema | undefined {
  return getToolDefinition(toolName)?.schema;
}
