import { atom, atomFamily } from 'recoil';
import translations from '../../client/src/locales/en/translation.json';
import { KIANA_ID } from '../../client/src/components/Chat/character/portrait-rig.mjs';
export const useAuthContext = () => ({ token: 'local-preview' });
export const useLocalize = () => (key: keyof typeof translations) => translations[key] || key;
export const usePauseGlobalAudio = () => ({ pauseGlobalAudio() {} });
export const cn = (...classes: (string | boolean | undefined)[]) => classes.filter(Boolean).join(' ');
export default {
  conversationAgentIdByIndex: atomFamily({ key: 'previewAgent', default: KIANA_ID }),
  conversationByIndex: atomFamily({ key: 'previewConversation', default: { conversationId: 'new' } }),
  voice: atom({ key: 'previewVoice', default: 'Windflower' }),
  voiceSpeed: atom({ key: 'previewSpeed', default: 1 }),
  voiceCallActiveState: atom({ key: 'previewActive', default: false }),
};
