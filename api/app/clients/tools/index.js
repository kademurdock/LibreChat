const manifest = require('./manifest');

// Structured Tools
const DALLE3 = require('./structured/DALLE3');
const FluxAPI = require('./structured/FluxAPI');
const FalAI = require('./structured/FalAI');
const KadePhoneCall = require('./structured/KadePhoneCall');
const KadeNotify = require('./structured/KadeNotify');
const KadeCallMe = require('./structured/KadeCallMe');
const KadeMemorySearch = require('./structured/KadeMemorySearch');
const KadeWorld = require('./structured/KadeWorld');
const KadeTranscribe = require('./structured/KadeTranscribe');
const KadeWeather = require('./structured/KadeWeather');
const KadeLocation = require('./structured/KadeLocation');
const KadeCode = require('./structured/KadeCode');
const KadeMakeFile = require('./structured/KadeMakeFile');
const KadeWikipedia = require('./structured/KadeWikipedia');
const KadeLyrics = require('./structured/KadeLyrics');
const KadeMedia = require('./structured/KadeMedia');
const KadeJoke = require('./structured/KadeJoke');
const KadeNews = require('./structured/KadeNews');
const KadeResearch = require('./structured/KadeResearch');
const KadeDrivePc = require('./structured/KadeDrivePc');
const KadeLivingMemory = require('./structured/KadeLivingMemory');
const KadeErrand = require('./structured/KadeErrand');
const KadeCouncil = require('./structured/KadeCouncil');
const KadeReadPage = require('./structured/KadeReadPage');
const KadeAdventure = require('./structured/KadeAdventure');
const KadeGames = require('./structured/KadeGames');
const KadeFeedback = require('./structured/KadeFeedback');
const KadeMessage = require('./structured/KadeMessage');
const KadeHelp = require('./structured/KadeHelp');
const OpenWeather = require('./structured/OpenWeather');
const StructuredWolfram = require('./structured/Wolfram');
const StructuredACS = require('./structured/AzureAISearch');
const StructuredSD = require('./structured/StableDiffusion');
const GoogleSearchAPI = require('./structured/GoogleSearch');
const TraversaalSearch = require('./structured/TraversaalSearch');
const createOpenAIImageTools = require('./structured/OpenAIImageTools');
const TavilySearchResults = require('./structured/TavilySearchResults');
const createGeminiImageTool = require('./structured/GeminiImageGen');

module.exports = {
  ...manifest,
  // Structured Tools
  DALLE3,
  FluxAPI,
  FalAI,
  KadePhoneCall,
  KadeNotify,
  KadeCallMe,
  KadeMemorySearch,
  KadeWorld,
  KadeTranscribe,
  KadeWeather,
  KadeLocation,
  KadeCode,
  KadeMakeFile,
  KadeWikipedia,
  KadeLyrics,
  KadeMedia,
  KadeJoke,
  KadeNews,
  KadeResearch,
  KadeDrivePc,
  KadeLivingMemory,
  KadeErrand,
  KadeCouncil,
  KadeReadPage,
  KadeAdventure,
  KadeGames,
  KadeFeedback,
  KadeMessage,
  KadeHelp,
  OpenWeather,
  StructuredSD,
  StructuredACS,
  GoogleSearchAPI,
  TraversaalSearch,
  StructuredWolfram,
  TavilySearchResults,
  createOpenAIImageTools,
  createGeminiImageTool,
};
