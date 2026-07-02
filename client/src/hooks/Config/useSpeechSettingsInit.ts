import { useEffect, useRef } from 'react';
import { useRecoilState, useSetRecoilState } from 'recoil';
import { useGetCustomConfigSpeechQuery } from 'librechat-data-provider/react-query';
import { STTEndpoints, TTSEndpoints } from '~/common';
import { logger } from '~/utils';
import store from '~/store';

const VALID_TTS_ENGINES: string[] = [TTSEndpoints.browser, TTSEndpoints.external];
const VALID_STT_ENGINES: string[] = [STTEndpoints.browser, STTEndpoints.external];
/* KADE (July 2 2026): librechat.yaml's speechTab schema only accepts PROVIDER
 * names (openai/azureOpenAI/elevenlabs/localai) for engineTTS/engineSTT, but
 * this client validates against browser|external — an upstream mismatch. The
 * old guard reset any provider name to "browser", which made every fresh
 * account read aloud in the DEVICE's system voice (iOS "Samantha") instead of
 * the platform's TTS. A provider name in the config means external speech IS
 * configured — map it to "external" instead. */
const LEGACY_EXTERNAL_ENGINES = new Set(['openai', 'azureopenai', 'elevenlabs', 'localai']);

/**
 * Initializes speech-related Recoil values from the server-side custom
 * configuration on first load (only when the user is authenticated)
 */
export default function useSpeechSettingsInit(isAuthenticated: boolean) {
  const { data } = useGetCustomConfigSpeechQuery({ enabled: isAuthenticated });
  const [engineTTS, setEngineTTS] = useRecoilState<string>(store.engineTTS);
  const [engineSTT, setEngineSTT] = useRecoilState<string>(store.engineSTT);

  const setters = useRef({
    conversationMode: useSetRecoilState(store.conversationMode),
    advancedMode: useSetRecoilState(store.advancedMode),
    speechToText: useSetRecoilState(store.speechToText),
    textToSpeech: useSetRecoilState(store.textToSpeech),
    cacheTTS: useSetRecoilState(store.cacheTTS),
    engineSTT: setEngineSTT,
    languageSTT: useSetRecoilState(store.languageSTT),
    autoTranscribeAudio: useSetRecoilState(store.autoTranscribeAudio),
    decibelValue: useSetRecoilState(store.decibelValue),
    autoSendText: useSetRecoilState(store.autoSendText),
    engineTTS: setEngineTTS,
    voice: useSetRecoilState(store.voice),
    cloudBrowserVoices: useSetRecoilState(store.cloudBrowserVoices),
    languageTTS: useSetRecoilState(store.languageTTS),
    automaticPlayback: useSetRecoilState(store.automaticPlayback),
    playbackRate: useSetRecoilState(store.playbackRate),
  }).current;

  useEffect(() => {
    if (!isAuthenticated || !data || data.message === 'not_found') return;

    logger.log('Initializing speech settings from config:', data);

    Object.entries(data).forEach(([key, value]) => {
      if (key === 'sttExternal' || key === 'ttsExternal') return;

      if (localStorage.getItem(key) !== null) return;

      const setter = setters[key as keyof typeof setters];
      if (setter) {
        logger.log(`Setting default speech setting: ${key} = ${value}`);
        setter(value as any);
      }
    });
  }, [isAuthenticated, data, setters]);

  useEffect(() => {
    if (VALID_TTS_ENGINES.includes(engineTTS)) return;
    const mapped = LEGACY_EXTERNAL_ENGINES.has(String(engineTTS).toLowerCase())
      ? TTSEndpoints.external
      : TTSEndpoints.browser;
    logger.log(`Mapping invalid TTS engine "${engineTTS}" to ${mapped}`);
    setEngineTTS(mapped);
  }, [engineTTS, setEngineTTS]);

  useEffect(() => {
    if (VALID_STT_ENGINES.includes(engineSTT)) return;
    const mapped = LEGACY_EXTERNAL_ENGINES.has(String(engineSTT).toLowerCase())
      ? STTEndpoints.external
      : STTEndpoints.browser;
    logger.log(`Mapping invalid STT engine "${engineSTT}" to ${mapped}`);
    setEngineSTT(mapped);
  }, [engineSTT, setEngineSTT]);
}
