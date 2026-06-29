import React, { useState, useRef, useCallback } from 'react';
import { useRecoilState } from 'recoil';
import { Volume2, Square } from 'lucide-react';
import { Dropdown } from '@librechat/client';
import type { Option } from '~/common';
import { useLocalize, useTTSBrowser, useTTSExternal } from '~/hooks';
import { logger } from '~/utils';
import store from '~/store';

/** Short phrase spoken when the user previews a voice. */
const PREVIEW_TEXT = 'Hello! This is a preview of my voice. I hope you like how I sound.';

/**
 * useVoicePreview — fetches a WAV sample for the given voice ID and plays it.
 * Returns { isPlaying, togglePreview } so the caller can wire up a play/stop button.
 */
function useVoicePreview() {
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setIsPlaying(false);
  }, []);

  const play = useCallback(async (voiceId: string) => {
    stop();
    setIsPlaying(true);
    try {
      const fd = new FormData();
      fd.append('input', PREVIEW_TEXT);
      fd.append('voice', voiceId);

      const res = await fetch('/api/files/speech/tts/manual', {
        method: 'POST',
        body: fd,
        credentials: 'include',
      });

      if (!res.ok) {
        logger.error(`[VoicePreview] HTTP ${res.status}`);
        setIsPlaying(false);
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;

      audio.onended = () => {
        URL.revokeObjectURL(url);
        audioRef.current = null;
        setIsPlaying(false);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        audioRef.current = null;
        setIsPlaying(false);
      };

      audio.play().catch((err) => {
        logger.error('[VoicePreview] play() failed:', err);
        URL.revokeObjectURL(url);
        setIsPlaying(false);
      });
    } catch (err) {
      logger.error('[VoicePreview] fetch failed:', err);
      setIsPlaying(false);
    }
  }, [stop]);

  const togglePreview = useCallback(
    (voiceId: string) => {
      if (isPlaying) {
        stop();
      } else {
        play(voiceId);
      }
    },
    [isPlaying, stop, play],
  );

  return { isPlaying, togglePreview };
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
  const { isPlaying, togglePreview } = useVoicePreview();

  const label = isPlaying
    ? localize('com_nav_stop_voice_preview') ?? 'Stop voice preview'
    : `${localize('com_nav_preview_voice') ?? 'Preview voice'}: ${voiceId}`;

  return (
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
