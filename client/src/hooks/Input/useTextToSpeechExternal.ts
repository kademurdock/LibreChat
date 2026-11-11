import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useRecoilValue } from 'recoil';
import { useToastContext } from '@librechat/client';
import { useTextToSpeechMutation, useVoicesQuery } from '~/data-provider';
import { useLocalize } from '~/hooks';
import store from '~/store';
import { generationRate, voiceCacheKey } from '~/utils/voicePace';
import { speechAudioFile, speechAudioBlob } from '~/hooks/Audio/speech';
import {
  watchVoiceAudio,
  stopWatchingVoiceAudio,
} from '~/components/Chat/character/voice-playback.mjs';
import { faceTimingsAllowed } from '~/components/Chat/character/timing-track.mjs';
import { useVoicePortraitPreference } from '~/components/Chat/character/useVoicePortraitPreference';

const createFormData = (
  text: string,
  voice: string,
  speed: number,
  fillers: boolean,
  timing: boolean,
) => {
  const formData = new FormData();
  formData.append('input', text);
  formData.append('voice', voice);
  formData.append('speed', String(speed)); // Kade D2d: agent speaking rate
  formData.append('fillers', String(fillers)); // Oct 16 2026: the listener's filler switch
  // Nov 11 2026: Inworld's mouth shapes ride inside the WAV for the face (timing-track.mjs).
  if (timing) formData.append('timing', 'true');
  return formData;
};

type TUseTTSExternal = {
  setIsSpeaking: React.Dispatch<React.SetStateAction<boolean>>;
  audioRef: React.MutableRefObject<HTMLAudioElement | null>;
  messageId?: string;
  characterId?: string | null;
  isLast: boolean;
  index?: number;
};

function useTextToSpeechExternal({
  setIsSpeaking,
  audioRef,
  messageId,
  characterId,
  isLast,
  index = 0,
}: TUseTTSExternal) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const voice = useRecoilValue(store.voice);
  const voiceSpeed = useRecoilValue(store.voiceSpeed); // Kade D2d
  const cacheTTS = useRecoilValue(store.cacheTTS);
  const pacePreference = useRecoilValue(store.voicePacePreference);
  const speed = generationRate(voiceSpeed, pacePreference);
  const fillers = useRecoilValue(store.voiceFillers);
  const [portraitsOn] = useVoicePortraitPreference();

  const [downloadFile, setDownloadFile] = useState(false);

  const promiseAudioRef = useRef<HTMLAudioElement | null>(null);

  /* Global Audio Variables */
  const globalIsFetching = useRecoilValue(store.globalAudioFetchingFamily(index));
  const globalIsPlaying = useRecoilValue(store.globalAudioPlayingFamily(index));

  const autoPlayAudio = (blobUrl: string) => {
    const newAudio = new Audio(blobUrl);
    audioRef.current = newAudio;
  };

  const playAudioPromise = (blobUrl: string) => {
    const newAudio = new Audio(blobUrl);
    const initializeAudio = () => {
      newAudio.playbackRate = 1;
    };

    initializeAudio();
    watchVoiceAudio(newAudio, messageId);
    const playPromise = () => newAudio.play().then(() => setIsSpeaking(true));

    playPromise().catch((error: Error) => {
      if (
        error.message &&
        error.message.includes('The play() request was interrupted by a call to pause()')
      ) {
        console.log('Play request was interrupted by a call to pause()');
        initializeAudio();
        return playPromise().catch(console.error);
      }
      console.error(error);
      showToast({
        message: localize('com_nav_audio_play_error', { 0: error.message }),
        status: 'error',
      });
    });

    newAudio.onended = () => {
      console.log('Cached message audio ended');
      URL.revokeObjectURL(blobUrl);
      setIsSpeaking(false);
    };

    promiseAudioRef.current = newAudio;
  };

  const downloadAudio = (blobUrl: string, extension: string) => {
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `audio.${extension}`;
    a.click();
    setDownloadFile(false);
  };

  const { mutate: processAudio, isLoading } = useTextToSpeechMutation({
    onMutate: (variables) => {
      const inputText = (variables.get('input') ?? '') as string;
      if (inputText.length >= 4096) {
        showToast({
          message: localize('com_nav_long_audio_warning'),
          status: 'warning',
        });
      }
    },
    onSuccess: async (data: ArrayBuffer, variables) => {
      try {
        const inputText = (variables.get('input') ?? '') as string;
        const { blob: audioBlob, extension } = speechAudioFile(data);

        if (cacheTTS && inputText) {
          const cache = await caches.open('tts-responses');
          const request = new Request(
            voiceCacheKey(
              inputText,
              String(variables.get('voice') ?? ''),
              Number(variables.get('speed') ?? 1),
              variables.get('fillers') !== 'false',
            ),
          );
          const response = new Response(audioBlob);
          cache.put(request, response);
        }

        const blobUrl = URL.createObjectURL(audioBlob);
        if (downloadFile) {
          downloadAudio(blobUrl, extension);
        }
        autoPlayAudio(blobUrl);
      } catch (error) {
        showToast({
          message: `Error processing audio: ${(error as Error).message}`,
          status: 'error',
        });
      }
    },
    onError: (error: unknown) => {
      showToast({
        message: localize('com_nav_audio_process_error', { 0: (error as Error).message }),
        status: 'error',
      });
    },
  });

  const startMutation = (text: string, download: boolean) => {
    // Only while a face will be drawn for this message; the audio is the same either way.
    // A download is a file to keep, not a face to draw, so it never asks.
    const timing = !download && portraitsOn && !!characterId && faceTimingsAllowed();
    const formData = createFormData(text, voice ?? '', speed, fillers, timing);
    setDownloadFile(download);
    processAudio(formData);
  };

  const generateSpeechExternal = (text: string, download: boolean) => {
    if (cacheTTS) {
      handleCachedResponse(text, download);
    } else {
      startMutation(text, download);
    }
  };

  const handleCachedResponse = async (text: string, download: boolean) => {
    const cachedResponse = await caches.match(voiceCacheKey(text, voice, speed, fillers));
    if (!cachedResponse) {
      return startMutation(text, download);
    }
    const audioBlob = await speechAudioBlob(await cachedResponse.blob());
    const blobUrl = URL.createObjectURL(audioBlob);
    if (download) {
      const { extension } = speechAudioFile(await audioBlob.arrayBuffer(), audioBlob.type);
      downloadAudio(blobUrl, extension);
    } else {
      playAudioPromise(blobUrl);
    }
  };

  const cancelSpeech = () => {
    const messageAudio = document.getElementById(`audio-${messageId}`) as HTMLAudioElement | null;
    const pauseAudio = (currentElement: HTMLAudioElement | null) => {
      if (currentElement) {
        currentElement.pause();
        currentElement.src && URL.revokeObjectURL(currentElement.src);
        audioRef.current = null;
      }
    };
    pauseAudio(messageAudio);
    pauseAudio(promiseAudioRef.current);
    setIsSpeaking(false);
  };

  const cancelPromiseSpeech = useCallback(() => {
    if (promiseAudioRef.current) {
      promiseAudioRef.current.pause();
      stopWatchingVoiceAudio(promiseAudioRef.current);
      promiseAudioRef.current.src && URL.revokeObjectURL(promiseAudioRef.current.src);
      promiseAudioRef.current = null;
      setIsSpeaking(false);
    }
  }, [setIsSpeaking]);

  useEffect(() => cancelPromiseSpeech, [cancelPromiseSpeech]);

  const isFetching = useMemo(
    () => isLast && globalIsFetching && !globalIsPlaying,
    [globalIsFetching, globalIsPlaying, isLast],
  );

  const { data: voicesData = [] } = useVoicesQuery();

  return {
    generateSpeechExternal,
    cancelSpeech,
    isLoading: isFetching || isLoading,
    audioRef,
    voices: voicesData,
  };
}

export default useTextToSpeechExternal;
