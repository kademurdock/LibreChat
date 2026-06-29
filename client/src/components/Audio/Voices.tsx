import React, { useState, useRef, useCallback } from 'react';
import { useRecoilState } from 'recoil';
import { Volume2, Square } from 'lucide-react';
import { Dropdown } from '@librechat/client';
import type { Option } from '~/common';
import { useLocalize, useTTSBrowser, useTTSExternal } from '~/hooks';
import { useAuthContext } from '~/hooks/AuthContext';
import { logger } from '~/utils';
import store from '~/store';

/** Short phrase spoken when the user previews a voice. */
const PREVIEW_TEXT =
  "Hi there! This is a little sample of my voice, so you can hear how I sound "
  + "before you pick me. I can be warm and friendly, or calm and clear when it "
  + "matters — whatever your conversation needs. Thanks for listening, and I hope "
  + "you like how I sound!";

/** ~10ms of silence. Played synchronously inside the tap to UNLOCK the audio
 * element on iOS Safari, so the real play() after the fetch await is allowed. */
const SILENT_WAV =
  'data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';

/**
 * useVoicePreview — fetches a WAV sample for the given voice ID and plays it.
 * Returns { isPlaying, togglePreview } so the caller can wire up a play/stop button.
 */
function useVoicePreview() {
  const { token } = useAuthContext();
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }
    setIsPlaying(false);
  }, []);

  // play() receives an <audio> element created synchronously inside the click
  // handler (iOS Safari blocks play() if the element is first touched after an
  // await), fetches the sample, and points the element at it.
  const play = useCallback(async (voiceId: string, audio: HTMLAudioElement) => {
    try {
      const fd = new FormData();
      fd.append('input', PREVIEW_TEXT);
      fd.append('voice', voiceId);

      const res = await fetch('/api/files/speech/tts/manual', {
        method: 'POST',
        body: fd,
        credentials: 'include',
        // LibreChat's JWT auth reads ONLY the Authorization header (not cookies),
        // so the in-memory access token must be sent explicitly or this 401s.
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });

      if (!res.ok) {
        logger.error(`[VoicePreview] HTTP ${res.status}`);
        setError(`Preview failed: server error ${res.status}.`);
        stop();
        return;
      }

      // The backend hardcodes Content-Type: audio/mpeg, but the Inworld proxy
      // actually returns WAV bytes. Re-wrap the blob as audio/wav so the browser
      // decodes it instead of firing onerror (which was untoggling the button).
      const rawBlob = await res.blob();
      const wavBlob = new Blob([rawBlob], { type: 'audio/wav' });
      const url = URL.createObjectURL(wavBlob);

      audio.onended = () => {
        URL.revokeObjectURL(url);
        if (audioRef.current === audio) {
          audioRef.current = null;
        }
        setIsPlaying(false);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        if (audioRef.current === audio) {
          audioRef.current = null;
        }
        setError('Preview failed: this device could not decode the audio.');
        setIsPlaying(false);
      };

      audio.src = url;
      audio.play().catch((err) => {
        logger.error('[VoicePreview] play() failed:', err);
        setError(`Preview blocked by the browser (${err?.name || 'autoplay'}). Tap again.`);
        URL.revokeObjectURL(url);
        stop();
      });
    } catch (err) {
      logger.error('[VoicePreview] fetch failed:', err);
      setError('Preview failed: could not reach the voice server.');
      stop();
    }
  }, [stop, token]);

  const togglePreview = useCallback(
    (voiceId: string) => {
      if (isPlaying) {
        stop();
        return;
      }
      setError(null);
      // Create the element NOW, inside the user gesture, before any await.
      const audio = new Audio();
      // iOS Safari only allows a later programmatic play() if THIS element was
      // already played within the user gesture. Setting the silent clip
      // and calling play() synchronously here "unlocks" it; the real sample
      // (fetched async below) can then play without being blocked. The clip is
      // pure silence, so it is inaudible — do NOT mute it (a muted play does
      // not satisfy iOS's unlock requirement for later unmuted audio).
      audio.src = SILENT_WAV;
      const unlock = audio.play();
      if (unlock && typeof unlock.catch === 'function') {
        unlock.catch(() => {});
      }
      audioRef.current = audio;
      setIsPlaying(true);
      play(voiceId, audio);
    },
    [isPlaying, stop, play],
  );

  return { isPlaying, togglePreview, error };
}

/** Preview button shown alongside the ExternalVoiceDropdown. */
function VoicePreviewButton({
  voiceId,
  disabled,
}: {
  voiceId: string;
  disabled: boolean;
}) {
  const localize = useLocalize();
  const { isPlaying, togglePreview, error } = useVoicePreview();

  const label = isPlaying
    ? localize('com_nav_stop_voice_preview') ?? 'Stop voice preview'
    : `${localize('com_nav_preview_voice') ?? 'Preview voice'}: ${voiceId}`;

  return (
    <div className="flex flex-col gap-1">
    <button
      type="button"
      onClick={() => togglePreview(voiceId)}
      disabled={disabled || !voiceId}
      aria-label={label}
      aria-pressed={isPlaying}
      className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-text-secondary
        hover:bg-surface-hover hover:text-text-primary
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy
        disabled:cursor-not-allowed disabled:opacity-40
        transition-colors duration-150"
    >
      {isPlaying ? (
        <Square className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Volume2 className="h-4 w-4" aria-hidden="true" />
      )}
      <span aria-hidden="true">
        {isPlaying
          ? (localize('com_nav_stop_voice_preview') ?? 'Stop')
          : (localize('com_nav_preview_voice') ?? 'Preview')}
      </span>
    </button>
      {error && (
        <span role="alert" aria-live="assertive" className="text-xs text-red-500">
          {error}
        </span>
      )}
    </div>
  );
}

export function BrowserVoiceDropdown({ disabled = false }: { disabled?: boolean }) {
  const localize = useLocalize();
  const { voices = [] } = useTTSBrowser();
  const [voice, setVoice] = useRecoilState(store.voice);

  const handleVoiceChange = (newValue?: string | Option) => {
    logger.log('Browser Voice changed:', newValue);
    const newVoice = typeof newValue === 'string' ? newValue : newValue?.value;
    if (newVoice != null) {
      return setVoice(newVoice.toString());
    }
  };

  const labelId = 'browser-voice-dropdown-label';

  return (
    <div className="flex items-center justify-between">
      <div id={labelId}>{localize('com_nav_voice_select')}</div>
      <Dropdown
        key={`browser-voice-dropdown-${voices.length}`}
        value={voice ?? ''}
        options={voices}
        onChange={handleVoiceChange}
        sizeClasses="min-w-[200px] !max-w-[400px] [--anchor-max-width:400px]"
        testId="BrowserVoiceDropdown"
        className="z-50"
        aria-labelledby={labelId}
        disabled={disabled}
      />
    </div>
  );
}

export function ExternalVoiceDropdown({ disabled = false }: { disabled?: boolean }) {
  const localize = useLocalize();
  const { voices = [] } = useTTSExternal();
  const [voice, setVoice] = useRecoilState(store.voice);

  const handleVoiceChange = (newValue?: string | Option) => {
    logger.log('External Voice changed:', newValue);
    const newVoice = typeof newValue === 'string' ? newValue : newValue?.value;
    if (newVoice != null) {
      return setVoice(newVoice.toString());
    }
  };

  const labelId = 'external-voice-dropdown-label';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div id={labelId}>{localize('com_nav_voice_select')}</div>
        <Dropdown
          key={`external-voice-dropdown-${voices.length}`}
          value={voice ?? ''}
          options={voices}
          onChange={handleVoiceChange}
          sizeClasses="min-w-[200px] !max-w-[400px] [--anchor-max-width:400px]"
          testId="ExternalVoiceDropdown"
          className="z-50"
          aria-labelledby={labelId}
          disabled={disabled}
        />
      </div>
      {/* ♿ C3: Voice preview button — lets the user hear the selected voice before committing.
           Keyboard-accessible and VoiceOver-friendly: aria-label includes the voice name,
           aria-pressed reflects play state. */}
      {voice != null && voice !== '' && (
        <div className="flex justify-end">
          <VoicePreviewButton voiceId={voice} disabled={disabled} />
        </div>
      )}
    </div>
  );
}
