import { useParams } from 'react-router-dom';
import { useEffect, useCallback, useRef } from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { useQueryClient } from '@tanstack/react-query';
import { useRecoilState, useRecoilValue, useSetRecoilState } from 'recoil';
import type { TMessage } from 'librechat-data-provider';
import { useCustomAudioRef, MediaSourceAppender, usePauseGlobalAudio } from '~/hooks/Audio';
import { useLatestMessage } from '~/hooks/Messages/useLatestMessage';
import { getLatestText, getAllContentText, logger } from '~/utils';
import { useAuthContext, useLocalize } from '~/hooks';
import { useLiveAnnouncer } from '~/Providers';
import { globalAudioId } from '~/common';
import store from '~/store';
import {
  generationRate,
  voiceCacheKey,
  voiceCacheText,
  storeVoiceAudio,
  deliveryFor,
} from '~/utils/voicePace';
import { consumeSpeechAudio, speechAudioBlob, playOrReport } from '~/hooks/Audio/speech';
import { useSpeechRequest } from '~/hooks/Audio/request';
import { claimVoice } from '~/hooks/Audio/voiceFocus';
import { watchVoiceAudio, stopWatchingVoiceAudio } from '../character/voice-playback.mjs';
import { messageCharacterId } from '../character/voice-message-motion.mjs';
import { faceTimingsAllowed } from '../character/timing-track.mjs';
import { useVoicePortraitPreference } from '../character/useVoicePortraitPreference';

export default function StreamAudio({ index = 0 }) {
  const { token } = useAuthContext();

  const cacheTTS = useRecoilValue(store.cacheTTS);
  const pacePreference = useRecoilValue(store.voicePacePreference);

  const voice = useRecoilValue(store.voice);
  const voiceSpeed = useRecoilValue(store.voiceSpeed);
  const speed = generationRate(voiceSpeed, pacePreference);
  const fillers = useRecoilValue(store.voiceFillers);
  const deliveryByAgent = useRecoilValue(store.voiceDeliveryByAgent); // Nov 12 2026, decision 24
  const [portraitsOn] = useVoicePortraitPreference();
  const activeRunId = useRecoilValue(store.activeRunFamily(index));
  const automaticPlayback = useRecoilValue(store.automaticPlayback);
  const voiceCallActive = useRecoilValue(store.voiceCallActiveState);
  const isSubmitting = useRecoilValue(store.isSubmittingFamily(index));
  const latestMessage = useLatestMessage(index);
  const setIsPlaying = useSetRecoilState(store.globalAudioPlayingFamily(index));
  const [audioRunId, setAudioRunId] = useRecoilState(store.audioRunFamily(index));
  const [isFetching, setIsFetching] = useRecoilState(store.globalAudioFetchingFamily(index));
  const [globalAudioURL, setGlobalAudioURL] = useRecoilState(store.globalAudioURLFamily(index));

  const { audioRef } = useCustomAudioRef({ setIsPlaying });
  const { pauseGlobalAudio } = usePauseGlobalAudio();

  const { conversationId: paramId } = useParams();
  const queryParam = paramId === 'new' ? paramId : (latestMessage?.conversationId ?? paramId ?? '');

  const onCancelled = useCallback(() => setIsFetching(false), [setIsFetching]);
  const speechRequest = useSpeechRequest(queryParam, activeRunId, voiceCallActive, onCancelled);

  /* Nov 12 2026 (WEB-10): auto read-aloud never ends in silence. Refs, not effect deps: a new
   * localize or announcer identity must not re-run the play effect and replay a finished clip. */
  const localize = useLocalize();
  const { announcePolite } = useLiveAnnouncer();
  const words = useRef({ localize, announcePolite });
  words.current = { localize, announcePolite };
  /** The URL this mounted instance published; a stale URL left in the store is never played. */
  const freshURLRef = useRef<string | null>(null);
  /** The reply the clip in flight belongs to. */
  const clipMessageRef = useRef<TMessage | null>(null);
  /** One lost-voice announcement per reply, whatever retries or double failures follow. */
  const lostVoiceRef = useRef<string | null>(null);

  const showClip = useCallback(
    (url: string) => {
      freshURLRef.current = url;
      setGlobalAudioURL(url);
    },
    [setGlobalAudioURL],
  );

  const announceVoiceLost = useCallback(
    (key: 'com_ui_read_aloud_blocked' | 'com_ui_read_aloud_failed', message?: TMessage | null) => {
      const id = message?.messageId ?? '';
      if (id && lostVoiceRef.current === id) {
        return;
      }
      lostVoiceRef.current = id;
      const { localize: say, announcePolite: announce } = words.current;
      announce({ message: say(key), isStatus: true });
      // The voice was the reading; give the screen reader the reply itself.
      const text = getAllContentText(message);
      if (text) {
        announce({ message: text });
      }
    },
    [],
  );

  const queryClient = useQueryClient();
  const getMessages = useCallback(
    () => queryClient.getQueryData<TMessage[]>([QueryKeys.messages, queryParam]),
    [queryParam, queryClient],
  );

  useEffect(() => {
    const latestText = getLatestText(latestMessage);

    /* KADE (July 2 2026): only auto-play FRESH replies. View switches /
     * remounts (e.g. opening Conversation Mode on an existing chat) used to
     * re-trigger playback of messages from PREVIOUS turns — live report:
     * several old clips played back-to-back at the start of a "call". A
     * message older than 2 minutes is never something to auto-play. */
    const createdAtMs = latestMessage?.createdAt ? new Date(latestMessage.createdAt).getTime() : 0;
    const isFreshReply = createdAtMs > 0 && Date.now() - createdAtMs < 2 * 60 * 1000;

    const shouldFetch = !!(
      token != null &&
      automaticPlayback &&
      /* KADE (July 2 2026): never speak over the in-app voice call —
       * Conversation Mode owns the speakers while it's open. */
      !voiceCallActive &&
      !isSubmitting &&
      latestMessage &&
      !latestMessage.isCreatedByUser &&
      latestText &&
      isFreshReply &&
      latestMessage.messageId &&
      !latestMessage.messageId.includes('_') &&
      !isFetching &&
      activeRunId != null &&
      activeRunId !== audioRunId
    );

    if (!shouldFetch) {
      return;
    }

    async function fetchAudio() {
      const controller = speechRequest.begin();
      setIsFetching(true);
      clipMessageRef.current = latestMessage ?? null;

      try {
        if (audioRef.current) {
          audioRef.current.pause();
          URL.revokeObjectURL(audioRef.current.src);
          setGlobalAudioURL(null);
        }

        /* Nov 12 2026 (WEB-1): keyed on the words spoken. Agent replies have an empty `text`, and
         * one shared key made every later reply play the first reply's audio. */
        const spokenText = voiceCacheText(latestMessage);
        /* Nov 12 2026 (decision 24): her delivery for this character, set on any device. */
        const delivery = deliveryFor(deliveryByAgent, messageCharacterId(latestMessage));
        const cacheKey = spokenText
          ? voiceCacheKey(spokenText, voice, speed, fillers, delivery)
          : '';
        const cache = await caches.open('tts-responses');
        const cachedResponse = cacheKey ? await cache.match(cacheKey) : undefined;
        if (!speechRequest.isCurrent(controller)) return;

        setAudioRunId(activeRunId);
        if (cachedResponse) {
          logger.log('Audio found in cache');
          const audioBlob = await speechAudioBlob(await cachedResponse.blob());
          if (!speechRequest.isCurrent(controller)) return;
          const blobUrl = URL.createObjectURL(audioBlob);
          showClip(blobUrl);
          setIsFetching(false);
          return;
        }

        logger.log('Fetching audio...', navigator.userAgent);
        const response = await fetch('/api/files/speech/tts', {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            messageId: latestMessage?.messageId,
            runId: activeRunId,
            voice,
            // Kade D2d: active agent's speaking rate (undefined drops out of JSON)
            speed,
            fillers, // Oct 16 2026: the listener's filler switch
            ...(delivery ? { delivery } : {}),
            // Nov 11 2026: Inworld's mouth shapes for the face, asked only while one will be drawn.
            ...(portraitsOn && messageCharacterId(latestMessage) && faceTimingsAllowed()
              ? { timing: true }
              : {}),
          }),
        });

        if (!response.ok) {
          throw new Error('Failed to fetch audio');
        }
        if (!response.body) {
          throw new Error('Null Response body');
        }

        let streamed = false;
        const audioBlob = await consumeSpeechAudio(response, {
          cache: cacheTTS,
          signal: controller.signal,
          openStream: (type) => {
            if (!speechRequest.isCurrent(controller))
              throw new DOMException('Audio request cancelled', 'AbortError');
            if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(type))
              return null;
            const mediaSource = new MediaSourceAppender(type);
            streamed = true;
            showClip(mediaSource.mediaSourceUrl);
            return {
              append: (data) => mediaSource.addData(data),
              close: () => mediaSource.close(),
              cancel: () => mediaSource.cancel(),
            };
          },
        });

        if (!speechRequest.isCurrent(controller)) return;
        if (!audioBlob && !streamed) {
          throw new Error('Empty audio response');
        }
        /* Voice first, cache second: saving must never delay or stop the reply. */
        if (audioBlob && !streamed) {
          showClip(URL.createObjectURL(audioBlob));
        }
        if (audioBlob && cacheTTS) {
          const targetMessage = (getMessages() ?? []).find(
            (msg) => msg.messageId === latestMessage?.messageId,
          );
          const savedText = voiceCacheText(targetMessage ?? latestMessage);
          void storeVoiceAudio(cache, savedText, voice, speed, fillers, audioBlob, delivery);
        }

        logger.log('Audio stream reading ended');
      } catch (error) {
        if (!speechRequest.isCurrent(controller)) return;
        logger.error('Error fetching audio:', error);
        // Mark the run as attempted, so a failure before the fetch cannot loop.
        setAudioRunId(activeRunId);
        setIsFetching(false);
        setGlobalAudioURL(null);
        announceVoiceLost('com_ui_read_aloud_failed', latestMessage);
      } finally {
        if (speechRequest.finish(controller)) setIsFetching(false);
      }
    }

    fetchAudio();
  }, [
    automaticPlayback,
    voiceCallActive,
    setGlobalAudioURL,
    setAudioRunId,
    setIsFetching,
    latestMessage,
    isSubmitting,
    activeRunId,
    getMessages,
    isFetching,
    audioRunId,
    cacheTTS,
    audioRef,
    voice,
    speed,
    fillers,
    deliveryByAgent,
    portraitsOn,
    token,
    speechRequest,
    showClip,
    announceVoiceLost,
  ]);

  /* Nov 12 2026 (WEB-10): play explicitly. The autoPlay attribute was switched off on every <audio>
   * when a call started, and Safari refuses a clip that arrives seconds after the tap; both ended
   * in silence. A refused clip is cleared and its request dropped, so it cannot burst out on the
   * next tap or fail a second time. */
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !globalAudioURL || freshURLRef.current !== globalAudioURL) {
      return;
    }
    let current = true;
    void playOrReport(audio, (why) => {
      if (!current) {
        return;
      }
      speechRequest.cancel();
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(globalAudioURL);
      freshURLRef.current = null;
      setGlobalAudioURL(null);
      setIsFetching(false);
      announceVoiceLost(
        why === 'blocked' ? 'com_ui_read_aloud_blocked' : 'com_ui_read_aloud_failed',
        clipMessageRef.current,
      );
    });
    return () => {
      current = false;
    };
  }, [
    audioRef,
    globalAudioURL,
    speechRequest,
    setGlobalAudioURL,
    setIsFetching,
    announceVoiceLost,
  ]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = 1;
  }, [audioRef, globalAudioURL]);

  /* KADE (July 15 2026): iOS/WebKit surfaces a lock-screen "Now Playing"
   * widget for any playing <audio>, and with no explicit Media Session
   * metadata it falls back to document.title -- which carries whatever the
   * current conversation's title is (see useDocumentTitle.ts). That's how a
   * one-off "read this message aloud" tap ends up showing conversation
   * content on the lock screen. Give it clean, generic info instead, and
   * keep playbackState honest so the widget doesn't linger after the clip
   * stops. */
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !globalAudioURL) {
      return;
    }

    const senderName = latestMessage?.sender || 'Kade-AI';
    navigator.mediaSession.metadata = new MediaMetadata({
      title: `Voice reply - ${senderName}`,
      artist: 'Kade-AI',
    });
    navigator.mediaSession.playbackState = 'playing';

    const audioEl = audioRef.current;
    const handlePlaying = () => {
      navigator.mediaSession.playbackState = 'playing';
    };
    const handlePaused = () => {
      navigator.mediaSession.playbackState = 'paused';
    };
    const handleDone = () => {
      navigator.mediaSession.playbackState = 'none';
      navigator.mediaSession.metadata = null;
    };

    audioEl?.addEventListener('play', handlePlaying);
    audioEl?.addEventListener('pause', handlePaused);
    audioEl?.addEventListener('ended', handleDone);

    return () => {
      audioEl?.removeEventListener('play', handlePlaying);
      audioEl?.removeEventListener('pause', handlePaused);
      audioEl?.removeEventListener('ended', handleDone);
    };
  }, [audioRef, globalAudioURL, latestMessage?.sender]);

  useEffect(() => {
    pauseGlobalAudio();
    // We only want the effect to run when the paramId changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramId]);

  /* KADE (July 2 2026): the moment a voice call opens, kill whatever this
   * element is doing (mid-play OR queued) so nothing talks over the call. */
  useEffect(() => {
    if (voiceCallActive) {
      pauseGlobalAudio();
    }
  }, [voiceCallActive, pauseGlobalAudio]);

  logger.log('StreamAudio.tsx - globalAudioURL:', globalAudioURL);
  return (
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <audio
      onPlaying={(event) => {
        claimVoice(event.currentTarget);
        watchVoiceAudio(event.currentTarget, latestMessage?.messageId);
      }}
      /* Nov 12 2026 (WEB-5): another voice can now pause this element (voiceFocus); the Read aloud
       * button on the latest reply reads this flag, so it must not stay on "Stop" while silent. */
      onPause={() => setIsPlaying(false)}
      onEmptied={(event) => stopWatchingVoiceAudio(event.currentTarget)}
      ref={audioRef}
      controls
      controlsList="nodownload nofullscreen noremoteplayback"
      style={{
        position: 'absolute',
        overflow: 'hidden',
        display: 'none',
        height: '0px',
        width: '0px',
      }}
      src={globalAudioURL ?? undefined}
      id={globalAudioId}
    />
  );
}
