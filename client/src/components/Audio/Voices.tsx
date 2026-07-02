import React, { useState, useRef, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRecoilState, useRecoilValue } from 'recoil';
import { Volume2, Square } from 'lucide-react';
import { Dropdown } from '@librechat/client';
import type { Option } from '~/common';
import { useLocalize, useTTSBrowser, useTTSExternal } from '~/hooks';
import { useAuthContext } from '~/hooks/AuthContext';
import { logger } from '~/utils';
import store from '~/store';
import { saveAgentVoicePreference } from '~/hooks/Agents/useAgentVoiceSync';

/** Short phrase spoken when the user previews a voice. */
const PREVIEW_TEXT =
  "Hi there! This is a little sample of my voice, so you can hear how I sound "
  + "before you pick me. I can be warm and friendly, or calm and clear when it "
  + "matters — whatever your conversation needs. Thanks for listening, and I hope "
  + "you like how I sound!";

/** ~10ms of silence. Played synchronously inside the tap to UNLOCK the audio
 * element on iOS Safari, so the real play() after the fetch await is allowed.
 * Exported: AgentVoicePicker reuses the same unlock trick for its
 * audition-as-you-browse playback (D2b). */
export const SILENT_WAV =
  'data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';

/** Same proxy base the ConversationMode voice pipeline points at. */
const TTS_PROXY_BASE = 'https://inworld-tts-proxy-production.up.railway.app';

/**
 * ♿ KADE D2c/D2d: voice-catalog metadata from the TTS proxy (GET /voices.json).
 * `sample` is the expressive audition monologue the /voices library page
 * performs — the in-app pickers use the same text so both surfaces sound
 * identical. (The `custom` list is still served but no longer drives any UI:
 * the 2026-07-01 renumbering made Kade's customs Voice 1–70, so plain numeric
 * order already leads with them, indistinguishably — her call.)
 * Fail-soft: on any fetch error `sample` is undefined and callers fall back
 * to their built-in line.
 */
export function useVoiceCatalogTexts(): { sample?: string; audition?: string } {
  const { data } = useQuery(
    ['kade', 'voiceCatalog'],
    async () => {
      const res = await fetch(`${TTS_PROXY_BASE}/voices.json`);
      if (!res.ok) {
        throw new Error(`voices.json ${res.status}`);
      }
      return (await res.json()) as { sample?: string; audition?: string };
    },
    { staleTime: Infinity, retry: 1, refetchOnWindowFocus: false },
  );
  return {
    sample: typeof data?.sample === 'string' && data.sample !== '' ? data.sample : undefined,
    /** Short expressive one-liner for browse-as-you-go auditions; `{voice}`
     * placeholder is filled by the caller. %%% steering converts to [bracket]
     * direction on the proxy's synth path. */
    audition: typeof data?.audition === 'string' && data.audition !== '' ? data.audition : undefined,
  };
}

/** "Voice 12" sorts numerically; any non-numbered label sorts first, alphabetically. */
export function compareVoices(a: string, b: string): number {
  const ma = /^Voice (\d+)$/i.exec(a);
  const mb = /^Voice (\d+)$/i.exec(b);
  if (ma && mb) {
    return Number(ma[1]) - Number(mb[1]);
  }
  if (ma || mb) {
    return ma ? 1 : -1;
  }
  return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
}

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
  // D2d: `text` lets callers supply the catalog's expressive sample monologue;
  // `speed` is the optional per-agent speaking rate (0.5–1.5).
  const play = useCallback(async (
    voiceId: string,
    audio: HTMLAudioElement,
    opts?: { text?: string; speed?: number },
  ) => {
    try {
      const fd = new FormData();
      fd.append('input', opts?.text ?? PREVIEW_TEXT);
      fd.append('voice', voiceId);
      if (typeof opts?.speed === 'number') {
        fd.append('speed', String(opts.speed));
      }

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
    (voiceId: string, opts?: { text?: string; speed?: number }) => {
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
      play(voiceId, audio, opts);
    },
    [isPlaying, stop, play],
  );

  return { isPlaying, togglePreview, error };
}

/** Preview button shown alongside the ExternalVoiceDropdown, and reused by the
 * agent builder's default-voice picker (D1/D2) — same iOS-safe playback path. */
export function VoicePreviewButton({
  voiceId,
  disabled,
  speed,
}: {
  voiceId: string;
  disabled: boolean;
  /** D2d: optional speaking rate so the preview matches the agent's configured pace. */
  speed?: number;
}) {
  const localize = useLocalize();
  const { isPlaying, togglePreview, error } = useVoicePreview();
  // The same expressive monologue the /voices library page performs.
  const { sample: sampleText } = useVoiceCatalogTexts();

  const label = isPlaying
    ? localize('com_nav_stop_voice_preview') ?? 'Stop voice preview'
    : `${localize('com_nav_preview_voice') ?? 'Preview voice'}: ${voiceId}`;

  return (
    <div className="flex flex-col gap-1">
    <button
      type="button"
      onClick={() => togglePreview(voiceId, { text: sampleText, speed })}
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
  // ♿ D2c/D2d: plain numeric order — after the 2026-07-01 renumbering Kade's
  // custom voices ARE Voice 1–70, so numeric order leads with them natively.
  const orderedVoices = useMemo(() => voices.map((v) => String(v)).sort(compareVoices), [voices]);
  const [voice, setVoice] = useRecoilState(store.voice);
  // ♿ D3: the agent active in the primary conversation, so a voice pick here can
  // be remembered as THIS agent's preferred voice (per-user, localStorage).
  const activeAgentId = useRecoilValue(store.conversationAgentIdByIndex(0));

  const handleVoiceChange = (newValue?: string | Option) => {
    logger.log('External Voice changed:', newValue);
    const newVoice = typeof newValue === 'string' ? newValue : newValue?.value;
    if (newVoice != null) {
      const voiceStr = newVoice.toString();
      // ♿ D3: persist this choice for the active agent so useAgentVoiceSync
      // re-applies it next time this agent's chat opens. Safe + fire-and-forget.
      if (activeAgentId) {
        saveAgentVoicePreference(activeAgentId, voiceStr);
      }
      return setVoice(voiceStr);
    }
  };

  const labelId = 'external-voice-dropdown-label';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div id={labelId}>{localize('com_nav_voice_select')}</div>
        <Dropdown
          key={`external-voice-dropdown-${orderedVoices.length}`}
          value={voice ?? ''}
          options={orderedVoices}
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
