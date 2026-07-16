import { atom } from 'recoil';
import { SettingsViews, LocalStorageKeys } from 'librechat-data-provider';
import { atomWithLocalStorage } from '~/store/utils';
import type { TOptionSettings } from '~/common';

// Static atoms without localStorage
const staticAtoms = {
  abortScroll: atom<boolean>({ key: 'abortScroll', default: false }),
  /** Kade D2d: the ACTIVE AGENT's speaking rate (tts.speakingRate), set by
   * useAgentVoiceSync on agent switch. Deliberately NOT persisted — it is
   * derived from the agent record; undefined = server default rate. Distinct
   * from `playbackRate` (the listener's client-side audio speed). */
  voiceSpeed: atom<number | undefined>({ key: 'voiceSpeed', default: undefined }),
  optionSettings: atom<TOptionSettings>({ key: 'optionSettings', default: {} }),
  currentSettingsView: atom<SettingsViews>({
    key: 'currentSettingsView',
    default: SettingsViews.default,
  }),
  showPopover: atom<boolean>({ key: 'showPopover', default: false }),
};

const localStorageAtoms = {
  // General settings
  autoScroll: atomWithLocalStorage('autoScroll', false),
  sidebarExpanded: atomWithLocalStorage(
    'unifiedSidebarExpanded',
    typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches ? false : true,
  ),
  enableUserMsgMarkdown: atomWithLocalStorage<boolean>(
    LocalStorageKeys.ENABLE_USER_MSG_MARKDOWN,
    true,
  ),
  keepScreenAwake: atomWithLocalStorage('keepScreenAwake', true),
  // KADE July 2 2026: soft chime when a reply finishes (accessibility)
  chimeOnCompletion: atomWithLocalStorage('chimeOnCompletion', false),
  // KADE July 16 2026: low-vision display prefs (classes applied by utils/kadeA11yPrefs.ts)
  kadeA11yHighContrast: atomWithLocalStorage('kadeA11yHighContrast', false),
  kadeA11yFont: atomWithLocalStorage<'default' | 'lexend' | 'opendyslexic'>('kadeA11yFont', 'default'),
  kadeA11yLineSpacing: atomWithLocalStorage<'default' | 'relaxed' | 'loose'>('kadeA11yLineSpacing', 'default'),
  newChatSwitchToHistory: atomWithLocalStorage('newChatSwitchToHistory', true),

  // Chat settings
  enterToSend: atomWithLocalStorage('enterToSend', true),
  maximizeChatSpace: atomWithLocalStorage('maximizeChatSpace', false),
  chatDirection: atomWithLocalStorage('chatDirection', 'LTR'),
  autoExpandTools: atomWithLocalStorage(LocalStorageKeys.AUTO_EXPAND_TOOLS, false),
  saveDrafts: atomWithLocalStorage('saveDrafts', true),
  showScrollButton: atomWithLocalStorage('showScrollButton', true),
  forkSetting: atomWithLocalStorage('forkSetting', ''),
  splitAtTarget: atomWithLocalStorage('splitAtTarget', false),
  rememberDefaultFork: atomWithLocalStorage(LocalStorageKeys.REMEMBER_FORK_OPTION, false),
  saveBadgesState: atomWithLocalStorage('saveBadgesState', false),

  // Beta features settings
  modularChat: atomWithLocalStorage('modularChat', true),
  LaTeXParsing: atomWithLocalStorage('LaTeXParsing', true),
  centerFormOnLanding: atomWithLocalStorage('centerFormOnLanding', true),
  showFooter: atomWithLocalStorage('showFooter', true),

  // Commands settings
  atCommand: atomWithLocalStorage('atCommand', true),
  plusCommand: atomWithLocalStorage('plusCommand', true),
  slashCommand: atomWithLocalStorage('slashCommand', true),
  dollarCommand: atomWithLocalStorage('dollarCommand', true),

  // Speech settings
  conversationMode: atomWithLocalStorage('conversationMode', false),
  advancedMode: atomWithLocalStorage('advancedMode', false),

  speechToText: atomWithLocalStorage('speechToText', true),
  engineSTT: atomWithLocalStorage('engineSTT', 'browser'),
  languageSTT: atomWithLocalStorage('languageSTT', ''),
  autoTranscribeAudio: atomWithLocalStorage('autoTranscribeAudio', false),
  decibelValue: atomWithLocalStorage('decibelValue', -45),
  autoSendText: atomWithLocalStorage('autoSendText', -1),

  textToSpeech: atomWithLocalStorage('textToSpeech', true),
  engineTTS: atomWithLocalStorage('engineTTS', 'browser'),
  voice: atomWithLocalStorage<string | undefined>('voice', undefined),
  cloudBrowserVoices: atomWithLocalStorage('cloudBrowserVoices', false),
  languageTTS: atomWithLocalStorage('languageTTS', ''),
  automaticPlayback: atomWithLocalStorage('automaticPlayback', false),
  playbackRate: atomWithLocalStorage<number | null>('playbackRate', null),
  cacheTTS: atomWithLocalStorage('cacheTTS', true),

  // Account settings
  UsernameDisplay: atomWithLocalStorage('UsernameDisplay', true),
};

export default { ...staticAtoms, ...localStorageAtoms };
